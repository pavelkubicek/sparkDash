import { workflowById } from "./spec.js";

/**
 * Turns what `rea` printed for a run (its Evidence envelope, an error object, or any other JSON)
 * into the small ResultSummary the dashboard shows. Pure, tolerant and total: it never throws,
 * every string it returns is clipped plain text with control characters removed, and every list
 * is capped. The full result stays in the cached bundle / on the unit; tables are paged through
 * the analysis view.
 *
 * ResultSummary = { kind, headline, tables:[{id,label,total,columns,rows?}], findings, limitations,
 *                   unknowns, identity, truncated }
 *   kind: "javascript-app" | "layout" | "native-function" | "generic"
 *   `rows` (additive) is a short preview (at most PREVIEW_ROWS rows of clipped cells); the index
 *   copy of a summary drops it (see compactSummary).
 */

export const MAX_CELL_CHARS = 240;
export const MAX_FINDINGS = 200;
export const MAX_LIMITATIONS = 100;
export const MAX_UNKNOWNS = 100;
export const MAX_TABLES = 30;
export const MAX_HEADLINE_KEYS = 40;
export const PREVIEW_ROWS = 20;
const MAX_COLUMNS = 12;
const MAX_PARSE_CHARS = 48 * 1024 * 1024;
const CONTROL_RE = new RegExp(
  "[" +
    [[0, 31], [127, 159], [8203, 8207], [8232, 8238], [8294, 8297], [65279, 65279]]
      .map(([a, b]) => [a, b].map((n) => String.fromCharCode(92) + "u" + n.toString(16).padStart(4, "0")).join("-"))
      .join("") +
    "]+",
  "g"
);

/** Plain, single-line, clipped text. */
export function clip(value, max = MAX_CELL_CHARS) {
  let s;
  if (typeof value === "string") s = value;
  else if (value === null || value === undefined) s = "";
  else if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") s = String(value);
  else {
    try {
      s = JSON.stringify(value) ?? "";
    } catch {
      s = "";
    }
  }
  s = s.replace(CONTROL_RE, " ").replace(/ {2,}/g, " ").trim();
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const isScalar = (v) => typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function scalar(v) {
  if (typeof v === "string") return clip(v);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  return null;
}

/** A short "k=v; k=v" description of an object's scalar properties. */
function describeProps(o, max = 8) {
  if (!isObj(o)) return "";
  const parts = [];
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined || !isScalar(v)) continue;
    parts.push(`${clip(k, 40)}=${clip(v, 80)}`);
    if (parts.length >= max) break;
  }
  return clip(parts.join("; "));
}

function pushLimited(list, text, max) {
  if (list.length >= max) return;
  const t = clip(text);
  if (t && !list.includes(t)) list.push(t);
}

function describeUnknown(u) {
  if (typeof u === "string") return u;
  if (!isObj(u)) return clip(u);
  const family = typeof u.family === "string" ? u.family : typeof u.kind === "string" ? u.kind : "";
  const detail = ["detail", "description", "message", "reason", "title", "name"].map((k) => u[k]).find((v) => typeof v === "string") ?? "";
  const reason = typeof u.reason === "string" && u.reason !== detail ? ` (${u.reason})` : "";
  const text = `${family ? `${family}: ` : ""}${detail}${reason}`;
  return text.trim() || describeProps(u);
}

function emptySummary(kind = "generic") {
  return { kind, headline: {}, tables: [], findings: [], limitations: [], unknowns: [], identity: {}, truncated: false };
}

function setHeadline(h, key, value) {
  if (Object.keys(h).length >= MAX_HEADLINE_KEYS && !(key in h)) return;
  const v = scalar(value);
  if (v !== null && v !== "") h[clip(key, 60)] = v;
}

/** columns + preview rows of an array of items. */
function tableOf(id, label, items, { columns } = {}) {
  const arr = Array.isArray(items) ? items : [];
  let cols = columns;
  if (!cols) {
    const seen = [];
    for (const it of arr.slice(0, 25)) {
      if (!isObj(it)) continue;
      for (const [k, v] of Object.entries(it)) {
        if (!seen.includes(k) && (isScalar(v) || v === null)) seen.push(k);
        if (seen.length >= MAX_COLUMNS) break;
      }
    }
    cols = seen.length ? seen : ["value"];
  }
  cols = cols.slice(0, MAX_COLUMNS).map((c) => clip(c, 60));
  const rows = arr.slice(0, PREVIEW_ROWS).map((it) => cols.map((c) => (isObj(it) ? clip(it[c]) : c === "value" ? clip(it) : "")));
  return { id: clip(id, 60), label: clip(label, 80), total: arr.length, columns: cols, rows };
}

function errorObjectOf(v) {
  if (!isObj(v) || "normalized_result" in v || "evidence_id" in v) return null;
  const code = typeof v.code === "string" ? v.code : null;
  const err = v.error;
  const nested = isObj(err) ? err : null;
  const hasMsg = typeof v.message === "string" || typeof err === "string" || nested !== null;
  const keys = Object.keys(v).length;
  if (code && (hasMsg || v.category !== undefined || v.cta !== undefined || v.remediation !== undefined || keys <= 3)) {
    return {
      code,
      category: typeof v.category === "string" ? v.category : null,
      message: typeof v.message === "string" ? v.message : typeof err === "string" ? err : nested?.message ?? "",
      action: isObj(v.remediation) && typeof v.remediation.action === "string" ? v.remediation.action : typeof v.cta === "string" ? v.cta : "",
      retryable: typeof v.retryable === "boolean" ? v.retryable : null,
    };
  }
  if (typeof err === "string" || (nested && (typeof nested.message === "string" || typeof nested.code === "string"))) {
    return {
      code: typeof v.code === "string" ? v.code : typeof nested?.code === "string" ? nested.code : "error",
      category: null,
      message: typeof err === "string" ? err : String(nested.message ?? ""),
      action: "",
      retryable: null,
    };
  }
  return null;
}

function errorSummary(e, extra = {}) {
  const s = emptySummary("generic");
  setHeadline(s.headline, "error", e.code);
  if (e.category) setHeadline(s.headline, "category", e.category);
  if (e.retryable !== null) setHeadline(s.headline, "retryable", e.retryable);
  const detail = [e.message, e.action].filter(Boolean).join(" ");
  s.findings.push({ severity: "error", title: clip(`REA reported an error: ${e.code}`, 160), detail: clip(detail), code: clip(e.code, 80) });
  return { ...s, ...extra };
}

function mergeLimitations(into, ...lists) {
  for (const l of lists) {
    if (!Array.isArray(l)) continue;
    for (const x of l) pushLimited(into, typeof x === "string" ? x : describeUnknown(x), MAX_LIMITATIONS);
  }
}

function identityOf(ev) {
  const id = {};
  const subj = isObj(ev.subject) ? ev.subject : {};
  const sha = (isObj(subj.digest) && subj.digest.sha256) || ev.root_artifact_sha256 || ev.sha256;
  if (typeof sha === "string" && /^[0-9a-fA-F]{16,128}$/.test(sha)) id.sha256 = sha.toLowerCase();
  if (typeof subj.format === "string") id.format = clip(subj.format, 60);
  if (typeof subj.architecture === "string") id.arch = clip(subj.architecture, 60);
  if (typeof subj.name === "string") id.name = clip(subj.name, 120);
  return id;
}

function coverageTruncated(...covs) {
  return covs.some((c) => isObj(c) && (c.truncated === true || (finite(c.omitted_count) ?? 0) > 0 || (finite(c.omitted_nodes) ?? 0) > 0));
}

// ── shapes ───────────────────────────────────────────────────────────────────────────────────

const MODULE_KINDS = new Set(["javascript-module", "javascript-asset", "bundled-module", "source-module", "module"]);
const PLAIN_NODE_KINDS = new Set(["artifact", ...MODULE_KINDS]);

function jsAppFromEvidence(ev, nr, s) {
  const stats = isObj(nr.statistics) ? nr.statistics : {};
  for (const k of ["relevant_files", "parsed_javascript_files", "modules", "findings", "parse_failures", "nested_asar_containers", "text_bytes_read", "invalid_utf8_files", "visited_ast_nodes"]) {
    setHeadline(s.headline, k, stats[k]);
  }
  setHeadline(s.headline, "format", nr.format);
  const sum = isObj(nr.summary) ? nr.summary : {};
  for (const [k, v] of Object.entries(sum)) {
    if (isObj(v)) for (const [k2, v2] of Object.entries(v)) setHeadline(s.headline, `${k}_${k2}`, v2);
    else setHeadline(s.headline, k, v);
  }
  const graph = isObj(nr.graph) ? nr.graph : {};
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  setHeadline(s.headline, "graph_nodes", nodes.length);
  setHeadline(s.headline, "graph_edges", edges.length);
  if (isObj(graph.coverage) && typeof graph.coverage.status === "string") setHeadline(s.headline, "coverage", graph.coverage.status);

  const mods = [];
  for (const n of nodes) {
    if (!isObj(n) || !MODULE_KINDS.has(n.kind)) continue;
    const obs = Array.isArray(n.observations) && isObj(n.observations[0]) ? n.observations[0] : {};
    const props = isObj(obs.properties) ? obs.properties : {};
    mods.push({ path: props.path ?? obs.label ?? "", kind: n.kind, format: props.module_format ?? "", node_id: n.node_id ?? "" });
  }
  s.tables.push(tableOf("modules", "Modules and assets", mods, { columns: ["path", "kind", "format", "node_id"] }));

  // Findings: graph nodes that say something about what the application does or exposes.
  for (const n of nodes) {
    if (s.findings.length >= MAX_FINDINGS) break;
    if (!isObj(n) || typeof n.kind !== "string" || PLAIN_NODE_KINDS.has(n.kind)) continue;
    const obs = Array.isArray(n.observations) && isObj(n.observations[0]) ? n.observations[0] : {};
    const props = isObj(obs.properties) ? obs.properties : {};
    const subject = props.value ?? props.name ?? props.resolved_path ?? props.declared_path ?? props.path ?? obs.label ?? "";
    s.findings.push({ severity: "info", title: clip(`${n.kind}: ${clip(subject, 120)}`, 200), detail: describeProps(props) });
  }
  const contradictions = Array.isArray(nr.integrity_contradictions) ? nr.integrity_contradictions : [];
  for (const c of contradictions) {
    if (s.findings.length >= MAX_FINDINGS) break;
    s.findings.unshift({ severity: "warning", title: "Integrity contradiction", detail: describeUnknown(c) });
  }
  if ((finite(stats.parse_failures) ?? 0) > 0) {
    s.findings.unshift({ severity: "warning", title: `${stats.parse_failures} source file(s) could not be parsed`, detail: "Their modules are only partly represented." });
  }

  const semantic = isObj(nr.semantic_graph) ? nr.semantic_graph : {};
  for (const u of Array.isArray(semantic.unknowns) ? semantic.unknowns : []) pushLimited(s.unknowns, describeUnknown(u), MAX_UNKNOWNS);
  mergeLimitations(s.limitations, ev.limitations, nr.limitations, graph.limitations);
  s.truncated = coverageTruncated(graph.coverage, semantic.coverage);
}

/** `inspect-analysis-view` summary projection of JavaScript application Evidence. */
function jsAppFromViewSummary(nr, s) {
  const sum = isObj(nr.summary) ? nr.summary : {};
  const stats = isObj(sum.statistics) ? sum.statistics : {};
  for (const [k, v] of Object.entries(stats)) setHeadline(s.headline, k, v);
  const electron = isObj(sum.electron) ? sum.electron : {};
  for (const [k, v] of Object.entries(electron)) {
    if (isObj(v)) for (const [k2, v2] of Object.entries(v)) setHeadline(s.headline, `${k}_${k2}`, v2);
    else setHeadline(s.headline, k, v);
  }
  setHeadline(s.headline, "format", sum.format);
  const cov = isObj(sum.coverage) ? sum.coverage : {};
  if (isObj(cov.application) && typeof cov.application.status === "string") setHeadline(s.headline, "coverage", cov.application.status);
  pushLimited(s.limitations, "Counts come from the summary view; page the modules for the exact list.", MAX_LIMITATIONS);
  s.tables.push({
    id: "modules",
    label: "Modules and assets",
    total: finite(stats.relevant_files) ?? finite(stats.parsed_javascript_files) ?? 0,
    columns: ["path", "kind", "format", "node_id"],
  });
  if ((finite(stats.parse_failures) ?? 0) > 0) {
    s.findings.push({ severity: "warning", title: `${stats.parse_failures} source file(s) could not be parsed`, detail: "Their modules are only partly represented." });
  }
  const su = finite(cov.semantic_unknowns) ?? 0;
  const au = finite(cov.application_unknowns) ?? 0;
  if (su || au) pushLimited(s.unknowns, `${au} application and ${su} semantic unknowns; page the modules or open the export to see them.`, MAX_UNKNOWNS);
  s.truncated = coverageTruncated(cov.application, cov.semantic);
}

/** Arrays (and counted objects) of a result object become tables; scalars become headline facts. */
function genericFromObject(o, s, { preferred = [], skip = [] } = {}) {
  const arrays = [];
  const keys = Object.keys(o);
  const ordered = [...preferred.filter((k) => keys.includes(k)), ...keys.filter((k) => !preferred.includes(k))];
  for (const k of ordered) {
    if (skip.includes(k)) continue;
    const v = o[k];
    if (Array.isArray(v)) arrays.push([k, v]);
    else if (isScalar(v)) setHeadline(s.headline, k, v);
    else if (isObj(v)) {
      // One level down: nested arrays become `parent.key` tables, nested scalars `parent.key` facts.
      for (const [k2, v2] of Object.entries(v)) {
        if (Array.isArray(v2)) arrays.push([`${k}.${k2}`, v2]);
        else if (isScalar(v2)) setHeadline(s.headline, `${k}.${k2}`, v2);
      }
    }
  }
  for (const [k, arr] of arrays) {
    if (s.tables.length >= MAX_TABLES) break;
    s.tables.push(tableOf(k, k.replace(/[_.]/g, " "), arr));
  }
}

function layoutFromEvidence(nr, s) {
  genericFromObject(nr, s, { preferred: ["sections", "segments", "symbols", "relocations", "dynamic", "needed_libraries"], skip: ["mitigations"] });
  const mit = nr.mitigations ?? (isObj(nr.summary) ? nr.summary.mitigations : null);
  if (isObj(mit)) {
    for (const [k, v] of Object.entries(mit)) {
      if (s.findings.length >= MAX_FINDINGS) break;
      if (isScalar(v)) s.findings.push({ severity: "info", title: clip(`${k}: ${v}`, 200), detail: "Static mitigation candidate; the object was not executed." });
    }
  }
}

function nativeFromEvidence(nr, s) {
  const skip = [];
  for (const k of ["pseudocode", "pseudo_code", "decompilation", "assembly_text", "source"]) {
    if (typeof nr[k] === "string") {
      setHeadline(s.headline, `${k}_chars`, nr[k].length);
      skip.push(k);
    }
  }
  genericFromObject(nr, s, { preferred: ["callers", "callees", "references", "basic_blocks", "assembly", "comments", "strings"], skip });
}

// ── entry point ──────────────────────────────────────────────────────────────────────────────

function shapeOf(workflow) {
  if (!workflow) return "generic";
  const w = typeof workflow === "string" ? workflowById(workflow) : workflow;
  const s = isObj(w) ? w.resultShape : null;
  return s === "javascript-app" || s === "layout" || s === "native-function" ? s : "generic";
}

function fromParsed(shapeIn, parsed) {
  let shape = shapeIn;
  if (Array.isArray(parsed)) {
    const s = emptySummary("generic");
    setHeadline(s.headline, "items", parsed.length);
    s.tables.push(tableOf("items", "Items", parsed));
    return s;
  }
  if (!isObj(parsed)) {
    const s = emptySummary("generic");
    setHeadline(s.headline, "value", parsed);
    return s;
  }
  const err = errorObjectOf(parsed);
  if (err) return errorSummary(err);

  const isEvidence = isObj(parsed.normalized_result) || typeof parsed.evidence_id === "string" || typeof parsed.predicate_type === "string";
  const nr = isObj(parsed.normalized_result) ? parsed.normalized_result : parsed;
  // Only an Evidence envelope is shown with its workflow's shape; any other object is a plain fact list.
  if (!isEvidence) shape = "generic";
  const s = emptySummary(shape);
  const isViewSummary = isEvidence && nr.kind === "summary" && isObj(nr.summary);
  if (isEvidence) {
    s.identity = identityOf(parsed);
    if (!isViewSummary && isObj(parsed.provider) && typeof parsed.provider.name === "string") setHeadline(s.headline, "provider", parsed.provider.name);
    if (!isViewSummary && typeof parsed.operation === "string") setHeadline(s.headline, "operation", parsed.operation);
    if (typeof parsed.confidence === "string") setHeadline(s.headline, "confidence", parsed.confidence);
    mergeLimitations(s.limitations, parsed.limitations);
  } else {
    s.identity = identityOf(nr);
  }

  if (shape === "javascript-app") {
    if (isViewSummary) jsAppFromViewSummary(nr, s);
    else jsAppFromEvidence(parsed, nr, s);
  } else if (shape === "layout") {
    layoutFromEvidence(isViewSummary ? nr.summary : nr, s);
  } else if (shape === "native-function") {
    nativeFromEvidence(isViewSummary ? nr.summary : nr, s);
  } else {
    genericFromObject(nr, s, { skip: isEvidence ? ["limitations"] : [] });
    setHeadline(s.headline, "keys", Object.keys(nr).slice(0, 30).join(", "));
  }
  if (shape !== "javascript-app" && isObj(nr)) {
    for (const u of Array.isArray(nr.unknowns) ? nr.unknowns : []) pushLimited(s.unknowns, describeUnknown(u), MAX_UNKNOWNS);
    mergeLimitations(s.limitations, nr.limitations);
    if (coverageTruncated(nr.coverage)) s.truncated = true;
  }
  if (isEvidence && Array.isArray(parsed.unknowns)) for (const u of parsed.unknowns) pushLimited(s.unknowns, describeUnknown(u), MAX_UNKNOWNS);
  return s;
}

/**
 * @param {object|string|null} workflow catalog entry (or its id); only `resultShape` is used
 * @param {string|object|Buffer} result the text rea printed, or the parsed value
 * @param {{ size?: number, sha256?: string, truncated?: boolean, note?: string }} [opts] facts the
 *   caller knows from the unit (size/hash of the file; truncated when the body was not read in full)
 * @returns {object} ResultSummary
 */
export function summarizeResult(workflow, result, opts = {}) {
  try {
    const shape = shapeOf(workflow);
    const o = isObj(opts) ? opts : {};
    let parsed = result;
    let s;
    if (Buffer.isBuffer(parsed)) parsed = parsed.toString("utf8");
    if (typeof parsed === "string") {
      const text = (parsed.charCodeAt(0) === 65279 ? parsed.slice(1) : parsed).trim();
      if (!text) {
        s = emptySummary("generic");
        s.limitations.push("The run printed no result.");
      } else if (text.length > MAX_PARSE_CHARS) {
        s = emptySummary("generic");
        setHeadline(s.headline, "chars", text.length);
        s.limitations.push("The result is too large to summarize here; it stays on the unit.");
        s.truncated = true;
      } else {
        let value;
        let ok = true;
        try {
          value = JSON.parse(text);
        } catch {
          ok = false;
        }
        if (ok) s = fromParsed(shape, value);
        else {
          s = emptySummary("generic");
          setHeadline(s.headline, "chars", text.length);
          const jsonish = /^[{[]/.test(text);
          s.limitations.push(jsonish ? "The result is cut off or is not valid JSON, so it could not be summarized." : "The result is plain text, not JSON.");
          if (jsonish) s.truncated = true;
          s.findings.push({ severity: "info", title: "Result text", detail: clip(text, MAX_CELL_CHARS) });
        }
      }
    } else if (parsed === undefined) {
      s = emptySummary("generic");
      s.limitations.push("There is no result to summarize.");
    } else {
      s = fromParsed(shape, parsed);
    }
    if (o.truncated === true) s.truncated = true;
    const sz = finite(o.size);
    if (sz !== null) setHeadline(s.headline, "resultBytes", sz);
    if (typeof o.sha256 === "string" && /^[0-9a-fA-F]{64}$/.test(o.sha256) && !s.identity.resultSha256) s.identity.resultSha256 = o.sha256.toLowerCase();
    if (typeof o.note === "string" && o.note) pushLimited(s.limitations, o.note, MAX_LIMITATIONS);
    s.findings = s.findings.slice(0, MAX_FINDINGS);
    s.limitations = s.limitations.slice(0, MAX_LIMITATIONS);
    s.unknowns = s.unknowns.slice(0, MAX_UNKNOWNS);
    s.tables = s.tables.slice(0, MAX_TABLES);
    return s;
  } catch {
    const s = emptySummary("generic");
    s.limitations.push("The result could not be summarized.");
    return s;
  }
}

/**
 * The summary as it is kept in the run index: headline numbers and the table shapes, a handful of
 * findings, no row previews. Everything else lives in the cached bundle.
 */
export function compactSummary(summary) {
  if (!isObj(summary)) return null;
  try {
    const f = Array.isArray(summary.findings) ? summary.findings : [];
    const l = Array.isArray(summary.limitations) ? summary.limitations : [];
    const u = Array.isArray(summary.unknowns) ? summary.unknowns : [];
    return {
      kind: clip(summary.kind || "generic", 40),
      headline: isObj(summary.headline) ? Object.fromEntries(Object.entries(summary.headline).slice(0, MAX_HEADLINE_KEYS).map(([k, v]) => [clip(k, 60), scalar(v)])) : {},
      tables: (Array.isArray(summary.tables) ? summary.tables : []).slice(0, MAX_TABLES).map((t) => ({
        id: clip(t.id, 60),
        label: clip(t.label, 80),
        total: finite(t.total) ?? 0,
        columns: (Array.isArray(t.columns) ? t.columns : []).slice(0, MAX_COLUMNS).map((c) => clip(c, 60)),
      })),
      findings: f.slice(0, 10).map((x) => ({
        ...(x.severity ? { severity: clip(x.severity, 20) } : {}),
        title: clip(x.title, 160),
        detail: clip(x.detail, 160),
        ...(x.code ? { code: clip(x.code, 80) } : {}),
      })),
      limitations: l.slice(0, 5).map((x) => clip(x, 200)),
      unknowns: u.slice(0, 5).map((x) => clip(x, 200)),
      identity: isObj(summary.identity) ? Object.fromEntries(Object.entries(summary.identity).slice(0, 8).map(([k, v]) => [clip(k, 40), clip(v, 130)])) : {},
      truncated: summary.truncated === true,
      counts: { findings: f.length, limitations: l.length, unknowns: u.length },
    };
  } catch {
    return null;
  }
}
