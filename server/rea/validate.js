import { PROVIDER_IDS } from "./providers.js";
import { workflowById } from "./spec.js";
import { buildArgv, displayLine, serverManagedFlag, verifyArgv } from "./argv.js";

/**
 * Strict validation for everything a browser can send to the REA routes. Nothing here is ever
 * interpolated into a shell string (values travel as separate argv items, see argv.js) but each
 * value is still checked hard so a bad request fails fast with a readable message and a hostile
 * one never reaches the unit. Nothing throws on hostile input; every function returns
 * `{ ok: true, ... }` or `{ ok: false, error }`.
 */

export const MAX_LABEL = 120;
export const MIN_TIMEOUT_MINUTES = 1;
export const MAX_TIMEOUT_MINUTES = 240;
export const MAX_PATH_LENGTH = 400;
export const VIEW_MAX_LIMIT = 200;
export const VIEW_DEFAULT_LIMIT = 32;
export const VIEW_MAX_OFFSET = 10_000_000;

const UPLOAD_ID_RE = /^up-[0-9]{8}-[0-9]{6}-[a-z0-9]{6}$/;
const RUN_ID_RE = /^rea-[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/;
const UPLOAD_REL_RE = /^[A-Za-z0-9._-]{1,128}(\/[A-Za-z0-9._-]{1,128}){0,15}$/;
const COLLECTION_RE = /^[a-z_]{1,40}$/;
const PATH_BODY_RE = /^[A-Za-z0-9._@+=,/ ()-]+$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const CONFIRM_CLASSES = new Set(["executes-target", "device", "network"]);
const REQUEST_KEYS = new Set(["workflowId", "target", "target2", "provider", "options", "timeoutMinutes", "authorized", "confirmExecute", "label"]);

const err = (error) => ({ ok: false, error });
const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

const reCache = new Map();
function re(source) {
  let r = reCache.get(source);
  if (!r) {
    r = new RegExp(source);
    reCache.set(source, r);
  }
  return r;
}

// ── ids and upload paths ───────────────────────────────────────────────────────────────────────

export function validateUploadId(id) {
  if (typeof id !== "string" || !UPLOAD_ID_RE.test(id)) return err("That is not a valid upload id");
  return { ok: true, value: id };
}

export function validateRunId(id) {
  if (typeof id !== "string" || !RUN_ID_RE.test(id)) return err("That is not a valid run id");
  return { ok: true, value: id };
}

/** Relative path inside one upload. Never `.`/`..`, never absolute, only a conservative charset. */
export function validateUploadPath(rel) {
  if (typeof rel !== "string" || !rel) return err("Enter the file's relative path inside the upload");
  if (rel.length > 2200) return err("The upload path is too long");
  if (!UPLOAD_REL_RE.test(rel)) return err("The upload path may only contain letters, digits and . _ - with / between folders (at most 16 levels)");
  if (rel.split("/").some((s) => s === "." || s === "..")) return err("The upload path must not contain . or .. segments");
  return { ok: true, value: rel };
}

/** Body of POST …/compare. */
export function validateCompareRequest(body) {
  const b = isPlainObject(body) ? body : {};
  const l = validateRunId(b.leftRunId);
  if (!l.ok) return err("Choose the first run to compare");
  const r = validateRunId(b.rightRunId);
  if (!r.ok) return err("Choose the second run to compare");
  if (l.value === r.value) return err("Choose two different runs to compare");
  return { ok: true, leftRunId: l.value, rightRunId: r.value };
}

// ── paths on the unit ──────────────────────────────────────────────────────────────────────────

/**
 * An absolute path (or `~/…`, which the unit resolves) with a deliberately narrow charset. The value
 * is returned as given (minus a trailing slash); the unit resolves it with realpath and re-checks it.
 */
export function validateUnitPath(raw, label = "The path") {
  if (typeof raw !== "string" || !raw) return err(`${label} is required`);
  if (raw.length > MAX_PATH_LENGTH) return err(`${label} is too long (${MAX_PATH_LENGTH} characters at most)`);
  if (CONTROL_RE.test(raw)) return err(`${label} must not contain control characters or line breaks`);
  if (raw !== raw.trim()) return err(`${label} must not start or end with a space`);
  const home = raw.startsWith("~/");
  if (!home && !raw.startsWith("/")) return err(`${label} must be absolute (or start with ~/)`);
  let body = raw.slice(home ? 2 : 1);
  if (body.endsWith("/")) body = body.slice(0, -1);
  if (!body) return err(`${label} must name a file or folder, not the root or home directory itself`);
  if (!PATH_BODY_RE.test(body)) return err(`${label} may only contain letters, digits and . _ @ + = , ( ) - space and /`);
  for (const seg of body.split("/")) {
    if (!seg.trim()) return err(`${label} must not contain empty path segments`);
    if (seg === "." || seg === "..") return err(`${label} must not contain . or .. segments`);
  }
  return { ok: true, value: `${home ? "~/" : "/"}${body}` };
}

function validateTarget(t, label, resolveUpload) {
  if (!isPlainObject(t)) return err(`${label} is required`);
  const kind = t.kind;
  if (kind === "path") {
    for (const k of Object.keys(t)) if (k !== "kind" && k !== "value") return err(`${label} has an unexpected field "${String(k).slice(0, 30)}"`);
    const p = validateUnitPath(t.value, `${label} path`);
    if (!p.ok) return p;
    return { ok: true, kind, value: p.value, display: p.value };
  }
  if (kind === "upload") {
    for (const k of Object.keys(t)) if (k !== "kind" && k !== "uploadId" && k !== "relPath") return err(`${label} has an unexpected field "${String(k).slice(0, 30)}"`);
    const id = validateUploadId(t.uploadId);
    if (!id.ok) return err(`${label}: ${id.error}`);
    let rel = null;
    if (t.relPath !== undefined && t.relPath !== null && t.relPath !== "") {
      const r = validateUploadPath(t.relPath);
      if (!r.ok) return err(`${label}: ${r.error}`);
      rel = r.value;
    }
    if (typeof resolveUpload !== "function") return err("Uploads are not available");
    let resolved = null;
    try {
      resolved = resolveUpload(id.value, rel);
    } catch {
      resolved = null;
    }
    if (typeof resolved !== "string" || !resolved) return err(`${label}: that upload is not available (it may not be committed, or it expired)`);
    const p = validateUnitPath(resolved, `${label} upload path`);
    if (!p.ok) return p;
    return { ok: true, kind, value: p.value, display: `upload ${id.value}${rel ? `/${rel}` : ""}` };
  }
  return err(`${label} must be a path on the unit or an upload`);
}

// ── option values ──────────────────────────────────────────────────────────────────────────────

function coerceInt(v) {
  if (typeof v === "number") return Number.isFinite(v) && Number.isInteger(v) ? v : NaN;
  if (typeof v === "string" && /^[0-9]{1,15}$/.test(v.trim())) return Number(v.trim());
  return NaN;
}

function checkString(arg, v, label) {
  if (typeof v !== "string") return err(`${label} must be text`);
  if (v === "") return arg.allowEmpty ? { ok: true, value: "" } : err(`${label} must not be empty`);
  if (v.length > (arg.maxLength || 300)) return err(`${label} is too long (${arg.maxLength || 300} characters at most)`);
  if (CONTROL_RE.test(v)) return err(`${label} must not contain control characters or line breaks`);
  if (arg.positional && v.startsWith("-")) return err(`${label} must not start with "-"`);
  if (arg.pattern && !re(arg.pattern).test(v)) return err(`${label} has characters or a shape that is not accepted`);
  if (arg.noDotDot && v.split("/").some((s) => s === ".." || s === ".")) return err(`${label} must not contain . or .. segments`);
  return { ok: true, value: v };
}

function validateOptionValue(arg, raw, label) {
  switch (arg.kind) {
    case "bool":
      if (typeof raw !== "boolean") return err(`${label} must be true or false`);
      return { ok: true, value: raw };
    case "int": {
      const n = coerceInt(raw);
      if (!Number.isInteger(n)) return err(`${label} must be a whole number`);
      if (arg.min !== undefined && n < arg.min) return err(`${label} must be at least ${arg.min}`);
      if (arg.max !== undefined && n > arg.max) return err(`${label} must be at most ${arg.max}`);
      return { ok: true, value: n };
    }
    case "choice":
      if (typeof raw !== "string" || !arg.choices.includes(raw)) return err(`${label} must be one of: ${arg.choices.join(", ")}`);
      return { ok: true, value: raw };
    case "string":
      return checkString(arg, raw, label);
    case "list": {
      let items = raw;
      if (typeof items === "string") items = items.split(/\r?\n|\s+/).filter(Boolean);
      if (!Array.isArray(items)) return err(`${label} must be a list`);
      if (!items.length) return err(`${label} must not be empty`);
      if (items.length > (arg.maxItems || 20)) return err(`${label} has too many entries (${arg.maxItems || 20} at most)`);
      const out = [];
      for (const it of items) {
        const c = checkString({ ...arg, allowEmpty: false }, it, `Each entry of ${label}`);
        if (!c.ok) return c;
        out.push(c.value);
      }
      return { ok: true, value: out };
    }
    case "intlist": {
      if (!Array.isArray(raw)) return err(`${label} must be a list of numbers`);
      if (raw.length > (arg.maxItems || 100)) return err(`${label} has too many entries`);
      const out = [];
      for (const it of raw) {
        const n = coerceInt(it);
        if (!Number.isInteger(n) || n < (arg.min ?? 0) || n > (arg.max ?? 1e9)) return err(`${label} must contain whole numbers between ${arg.min ?? 0} and ${arg.max ?? 1e9}`);
        out.push(n);
      }
      return { ok: true, value: out };
    }
    case "path": {
      const p = validateUnitPath(raw, label);
      return p.ok ? { ok: true, value: p.value, isPath: true } : p;
    }
    case "json": {
      let parsed = raw;
      if (typeof raw === "string") {
        if (raw.length > (arg.maxLength || 8000)) return err(`${label} is too long`);
        try {
          parsed = JSON.parse(raw);
        } catch {
          return err(`${label} must be valid JSON`);
        }
      }
      const typeOk = arg.jsonType === "array" ? Array.isArray(parsed) : isPlainObject(parsed);
      if (!typeOk) return err(`${label} must be a JSON ${arg.jsonType === "array" ? "array" : "object"}`);
      if (arg.jsonType === "array" && parsed.length > 200) return err(`${label} has too many items (200 at most)`);
      let text;
      try {
        text = JSON.stringify(parsed);
      } catch {
        return err(`${label} must be valid JSON`);
      }
      if (typeof text !== "string" || text.length > (arg.maxLength || 8000)) return err(`${label} is too long`);
      return { ok: true, value: text };
    }
    default:
      return err(`${label} cannot be set from a request`);
  }
}

const labelOf = (arg) => `Option "${arg.name}"`;

/**
 * @returns {{ ok: true, options: Record<string, unknown>, paths: string[] } | { ok: false, error: string }}
 */
function validateOptions(workflow, raw) {
  if (raw !== undefined && raw !== null && !isPlainObject(raw)) return err("Options must be an object");
  const given = raw || {};
  const byName = new Map(workflow.args.map((a) => [a.name, a]));
  const options = {};
  const paths = [];
  for (const key of Object.keys(given)) {
    const arg = byName.get(key);
    if (arg && arg.kind !== "path-run-owned") continue;
    const managed = serverManagedFlag(key);
    if (arg || managed) {
      return err(
        managed === "provider"
          ? "The provider is chosen with the provider field, not as an option"
          : `Option "${String(key).slice(0, 40)}" is managed by the dashboard and cannot be set`,
      );
    }
    return err(`Unknown option "${String(key).slice(0, 40)}" for ${workflow.id}`);
  }
  for (const arg of workflow.args) {
    if (arg.kind === "path-run-owned") continue;
    let v = given[arg.name];
    const unset = v === undefined || v === null || (v === "" && !arg.allowEmpty) || (arg.kind === "bool" && v === false) || (Array.isArray(v) && v.length === 0);
    if (unset) {
      if (arg.required && arg.allowEmpty && arg.positional) {
        options[arg.name] = "";
        continue;
      }
      if (arg.required && arg.kind !== "bool") return err(`${labelOf(arg)} is required: ${arg.help}`);
      continue;
    }
    const r = validateOptionValue(arg, v, labelOf(arg));
    if (!r.ok) return r;
    options[arg.name] = r.value;
    if (r.isPath) paths.push(r.value);
  }
  for (const arg of workflow.args) {
    if (arg.with && options[arg.name] !== undefined && options[arg.with] === undefined) {
      return err(`Option "${arg.name}" needs "${arg.with}" as well`);
    }
  }
  if (workflow.requireOneOf && !workflow.requireOneOf.some((k) => options[k] !== undefined)) {
    return err(`Set at least one of: ${workflow.requireOneOf.join(", ")}`);
  }
  return { ok: true, options, paths };
}

// ── the run request ────────────────────────────────────────────────────────────────────────────

function parseTimeout(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: fallback };
  const strict = typeof raw === "number" || (typeof raw === "string" && /^[0-9]{1,6}(\.[0-9]{1,3})?$/.test(raw.trim()));
  const n = strict ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return err(`The time limit must be a number of minutes (${MIN_TIMEOUT_MINUTES} to ${MAX_TIMEOUT_MINUTES})`);
  return { ok: true, value: Math.min(MAX_TIMEOUT_MINUTES, Math.max(MIN_TIMEOUT_MINUTES, Math.round(n))) };
}

/**
 * Whole request body (WorkflowRunRequest) -> a normalized run, or a readable error.
 *
 * @param {unknown} body
 * @param {{ deviceWritesEnabled?: boolean, resolveUpload?: (uploadId: string, relPath: string|null) => string|null }} [opts]
 */
export function validateRunRequest(body, { deviceWritesEnabled = false, resolveUpload } = {}) {
  try {
    if (!isPlainObject(body)) return err("The request body must be a JSON object");
    for (const k of Object.keys(body)) if (!REQUEST_KEYS.has(k)) return err(`Unknown field "${String(k).slice(0, 40)}"`);

    const workflow = workflowById(body.workflowId);
    if (!workflow) return err("Unknown workflow");

    if (body.authorized !== true) {
      return err("Confirm that you are authorized to analyze this target before starting");
    }
    if (workflow.effects.mutatesDevice && !deviceWritesEnabled) {
      return err("This action changes the device and is switched off. The dashboard server must be started with REA_ENABLE_DEVICE_WRITES=1 to allow it");
    }
    if (CONFIRM_CLASSES.has(workflow.execClass) && body.confirmExecute !== true) {
      const what = { "executes-target": "runs or drives the target", device: "talks to the attached device", network: "contacts a live endpoint" }[workflow.execClass];
      return err(`This workflow ${what}. Confirm that separately before starting`);
    }
    if (body.confirmExecute !== undefined && typeof body.confirmExecute !== "boolean") return err("confirmExecute must be true or false");

    // provider
    let provider = null;
    if (body.provider !== undefined && body.provider !== null && body.provider !== "") {
      if (typeof body.provider !== "string" || !PROVIDER_IDS.includes(body.provider)) {
        return err(`Provider must be one of: ${PROVIDER_IDS.join(", ")}`);
      }
      if (!workflow.needsProvider && body.provider !== "auto") return err(`${workflow.label} does not use an analysis provider`);
      provider = body.provider;
    }
    if (workflow.needsProvider && !provider) provider = "auto";
    if (!workflow.needsProvider) provider = null;

    // targets
    let target = null;
    let target2 = null;
    const paths = [];
    if (workflow.targets === 0) {
      if (body.target !== undefined && body.target !== null) return err(`${workflow.label} does not take a file or folder`);
      if (body.target2 !== undefined && body.target2 !== null) return err(`${workflow.label} does not take a second target`);
    } else {
      target = validateTarget(body.target, "Target", resolveUpload);
      if (!target.ok) return target;
      paths.push(target.value);
      if (workflow.targets === 2) {
        target2 = validateTarget(body.target2, "Second target", resolveUpload);
        if (!target2.ok) return target2;
        paths.push(target2.value);
      } else if (body.target2 !== undefined && body.target2 !== null) {
        return err(`${workflow.label} takes one target`);
      }
    }

    // options
    const opts = validateOptions(workflow, body.options);
    if (!opts.ok) return opts;
    for (const p of opts.paths) if (!paths.includes(p)) paths.push(p);

    const timeout = parseTimeout(body.timeoutMinutes, workflow.defaultTimeoutMinutes);
    if (!timeout.ok) return timeout;

    let label = "";
    if (body.label !== undefined && body.label !== null) {
      if (typeof body.label !== "string") return err("The label must be text");
      label = body.label.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_LABEL);
    }

    const argv = buildArgv(workflow, { targetValue: target?.value, target2Value: target2?.value, options: opts.options, provider });
    const bad = verifyArgv(workflow, argv);
    if (bad) return err(bad);

    return {
      ok: true,
      workflow,
      argv,
      paths,
      provider,
      options: opts.options,
      timeoutMinutes: timeout.value,
      label,
      display: displayLine(workflow, { targetDisplay: target?.display, target2Display: target2?.display, options: opts.options, provider }),
      execClass: workflow.execClass,
      effects: { ...workflow.effects },
      confirmExecute: body.confirmExecute === true,
      target: target ? { kind: target.kind, display: target.display } : null,
      target2: target2 ? { kind: target2.kind, display: target2.display } : null,
    };
  } catch {
    return err("The request could not be validated");
  }
}

// ── result views ───────────────────────────────────────────────────────────────────────────────

const NATIVE_FACETS = [
  "procedure", "pseudocode", "assembly", "basic_blocks", "comments", "callers", "callees", "incoming_references",
  "outgoing_references", "unresolved_calls", "referenced_strings", "referenced_names", "native_api", "value_flow_summary",
  "value_flow_operations", "value_flow_def_use", "value_flow_effects", "value_flow_parameters", "value_flow_parameter_uses",
];
const COLLECTIONS_BY_SHAPE = { "javascript-app": ["modules"], layout: ["sections", "symbols"], "native-function": [] };
const LAYOUT_FACETS = ["mitigations", "linkage"];

function intParam(raw, name, def, min, max) {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: def };
  const s = Array.isArray(raw) ? raw[0] : raw;
  const n = typeof s === "number" ? s : typeof s === "string" && /^[0-9]{1,9}$/.test(s) ? Number(s) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) return err(`${name} must be a whole number between ${min} and ${max}`);
  return { ok: true, value: n };
}

const first = (v) => (Array.isArray(v) ? v[0] : v);

/**
 * Query string of GET …/runs/:rid/view -> a normalized view, or an error. Only workflows whose
 * output `rea inspect-analysis-view` supports (layout, JavaScript application, native function)
 * can be viewed.
 *
 * @returns {{ ok: true, view: object } | { ok: false, error: string }}
 */
export function validateViewRequest(query, workflow) {
  if (!workflow || typeof workflow !== "object" || !workflow.viewable) return err("This workflow's result has no paged view");
  const q = isPlainObject(query) ? query : {};
  const shape = workflow.resultShape;
  const collections = COLLECTIONS_BY_SHAPE[shape] || [];
  const rawKind = first(q.kind);
  const collection = first(q.collection);
  const facet = first(q.facet);
  let kind = rawKind;
  if (kind === undefined || kind === "") kind = collection !== undefined ? "page" : facet !== undefined ? (shape === "layout" ? "facet" : "native") : "summary";
  if (typeof kind !== "string") return err("Unknown view kind");

  if (kind === "summary") return { ok: true, view: { kind: "summary" } };

  if (kind === "page" || kind === "module" || kind === "item") {
    if (collection !== undefined && (typeof collection !== "string" || !COLLECTION_RE.test(collection))) return err("That collection name is not valid");
    const c = collection === undefined && kind !== "page" ? collections[0] : collection;
    if (typeof c !== "string" || !collections.includes(c)) {
      return err(collections.length ? `Collection must be one of: ${collections.join(", ")}` : "This result has no collections to page; use the native facets");
    }
    if (kind === "page") {
      const off = intParam(q.offset, "Offset", 0, 0, VIEW_MAX_OFFSET);
      if (!off.ok) return off;
      const lim = intParam(q.limit, "Limit", VIEW_DEFAULT_LIMIT, 1, VIEW_MAX_LIMIT);
      if (!lim.ok) return lim;
      return { ok: true, view: { kind: "page", collection: c, offset: off.value, limit: lim.value } };
    }
    if (c === "modules") {
      // REA selects module items by exact observed path (an empty reference is valid) or node_id, never index/name.
      const pth = first(q.path);
      const nodeId = first(q.node_id);
      if (nodeId !== undefined) {
        if (typeof nodeId !== "string" || !/^jag_node_[A-Za-z0-9_:-]{8,128}$/.test(nodeId)) return err("The node_id is not valid");
        return { ok: true, view: { kind: "module", collection: c, selector: { node_id: nodeId } } };
      }
      if (pth === undefined) return err("Give the module's exact path or node_id");
      if (typeof pth !== "string" || pth.length > 1000 || CONTROL_RE.test(pth)) return err("The module path is not valid");
      return { ok: true, view: { kind: "module", collection: c, selector: { path: pth } } };
    }
    const name = first(q.name);
    const index = first(q.index);
    if (name !== undefined) {
      if (typeof name !== "string" || !name || name.length > 300 || CONTROL_RE.test(name)) return err("The item name is not valid");
      return { ok: true, view: { kind: "module", collection: c, selector: { name } } };
    }
    const idx = intParam(index, "Index", undefined, 0, VIEW_MAX_OFFSET);
    if (!idx.ok) return idx;
    if (idx.value === undefined) return err("Give the item's name or index");
    return { ok: true, view: { kind: "module", collection: c, selector: { index: idx.value } } };
  }

  if (kind === "facet") {
    if (shape !== "layout") return err("Facets are only available for layout results");
    if (typeof facet !== "string" || !LAYOUT_FACETS.includes(facet)) return err(`Facet must be one of: ${LAYOUT_FACETS.join(", ")}`);
    return { ok: true, view: { kind: "facet", facet } };
  }

  if (kind === "native") {
    if (shape !== "native-function") return err("Native facets are only available for native function results");
    if (typeof facet !== "string" || !NATIVE_FACETS.includes(facet)) return err(`Facet must be one of: ${NATIVE_FACETS.join(", ")}`);
    const off = intParam(q.offset, "Offset", 0, 0, VIEW_MAX_OFFSET);
    if (!off.ok) return off;
    const lim = intParam(q.limit, "Limit", VIEW_DEFAULT_LIMIT, 1, VIEW_MAX_LIMIT);
    if (!lim.ok) return lim;
    return { ok: true, view: { kind: "native", facet, offset: off.value, limit: lim.value } };
  }

  return err("Unknown view kind");
}

/** A validated view -> the `view` object `rea inspect-analysis-view` expects. */
export function reaViewObject(view) {
  if (view.kind === "module") return { kind: "item", collection: view.collection, selector: view.selector };
  return { ...view };
}
