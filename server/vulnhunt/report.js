/**
 * Read a VulnHunter report (the README.md inside a `<repo>_VULNHUNT_RESULTS_<label>` folder) into numbers the dashboard
 * can show. Pure functions, no I/O.
 *
 * The report is markdown written by an agent, so everything here is tolerant: an unexpected
 * layout yields fewer fields, never an exception, and every string is length-capped before it
 * is stored or sent to a browser. The text is data; it is never executed or interpreted.
 */

export const SEVERITIES = ["High+", "High", "Medium", "Low", "Informational"];
const MAX_FINDINGS = 200;
const MAX_CELL = 240;

const clip = (s, n = MAX_CELL) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n);

function normalizeSeverity(raw) {
  const t = clip(raw, 40).replace(/\*/g, "").trim().toLowerCase();
  if (!t) return null;
  if (t.startsWith("high+") || t.startsWith("critical")) return "High+";
  if (t.startsWith("high")) return "High";
  if (t.startsWith("medium") || t.startsWith("moderate")) return "Medium";
  if (t.startsWith("low")) return "Low";
  if (t.startsWith("info")) return "Informational";
  return null;
}

/**
 * `| a | b |` -> ["a", "b"]; null when the line is not a table row. An escaped pipe (`\|`) and a pipe
 * inside a backtick code span stay in their cell.
 */
function splitRow(line) {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  const cells = [];
  let cur = "";
  let inCode = false;
  for (let i = 1; i < t.length; i++) {
    const ch = t[i];
    if (ch === "\\" && t[i + 1] === "|") {
      cur += "|";
      i += 1;
    } else if (ch === "`") {
      inCode = !inCode;
      cur += ch;
    } else if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (inCode) {
    // An unclosed backtick: do not let it swallow the rest of the row.
    return t.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  }
  if (cur.trim() !== "" || !t.endsWith("|")) cells.push(cur.trim());
  return cells;
}

const isSeparator = (cells) => cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, "")));

/** Pull `**Key**: value` header lines out of the top of the report. */
export function parseHeader(markdown) {
  const out = {};
  const head = String(markdown ?? "").split("\n").slice(0, 40);
  for (const line of head) {
    const m = /^\*\*([A-Za-z ]{2,30}?)(?:\*\*\s*:|:\*\*)\s*(.+)$/.exec(line.trim());
    if (m) out[m[1].trim().toLowerCase()] = clip(m[2], 300);
  }
  return {
    runId: out["run id"] ?? null,
    repository: out["repository"] ?? null,
    auditDate: out["audit date"] ?? null,
    branch: out["branch"] ?? null,
    model: out["model"] ?? null,
    findingsSummary: out["findings summary"] ?? null,
  };
}

/**
 * Findings from every summary table whose header has an ID column plus a Severity column
 * (the report puts one at the top and the README repeats it). Rows are de-duplicated by id.
 */
export function parseFindings(markdown) {
  const lines = String(markdown ?? "").split("\n");
  const byId = new Map();
  let cols = null; // header index map while inside a findings table
  for (const line of lines) {
    const cells = splitRow(line);
    if (!cells) {
      cols = null;
      continue;
    }
    if (isSeparator(cells)) continue;
    const lower = cells.map((c) => c.replace(/\*/g, "").trim().toLowerCase());
    if (lower.includes("id") && lower.includes("severity")) {
      cols = {};
      lower.forEach((name, i) => {
        if (!(name in cols)) cols[name] = i;
      });
      continue;
    }
    if (!cols) continue;
    const idCell = cells[cols.id] ?? "";
    const idMatch = /(VULN-[A-Z0-9-]+)/i.exec(idCell);
    if (!idMatch) continue;
    const id = idMatch[1].toUpperCase();
    const get = (name) => (name in cols ? clip(cells[cols[name]] ?? "") : "");
    const severity = normalizeSeverity(get("severity"));
    const finding = {
      id,
      title: get("title"),
      cwe: get("cwe") || null,
      severity,
      runtime: get("runtime") || null,
      exploitTest: get("exploit test") || null,
      measuredImpact: get("measured impact") || null,
      status: get("status") || null,
    };
    const prev = byId.get(id);
    if (!prev) {
      byId.set(id, finding);
    } else {
      // The README table repeats the summary: a later value wins, an empty one never erases an earlier value.
      const merged = { ...prev };
      for (const [k, v] of Object.entries(finding)) if (v !== null && v !== "") merged[k] = v;
      byId.set(id, merged);
    }
    if (byId.size >= MAX_FINDINGS) break;
  }
  return [...byId.values()];
}

/** Count findings per severity, keeping a stable key order. */
export function countBySeverity(findings) {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  let unrated = 0;
  for (const f of findings) {
    if (f.severity && f.severity in counts) counts[f.severity] += 1;
    else unrated += 1;
  }
  return { ...counts, unrated };
}

/** Parse the manifest vh writes. Only the stub fields are meaningful; never trusted for counts. */
export function parseManifest(text) {
  if (typeof text !== "string" || !text.trim() || text.length > 65_536) return null;
  try {
    const m = JSON.parse(text);
    if (!m || typeof m !== "object") return null;
    return {
      scanId: typeof m.scan_id === "string" ? clip(m.scan_id, 200) : null,
      agentExitCode: Number.isInteger(m.agent_exit_code) ? m.agent_exit_code : null,
      costUsd: typeof m.cost_usd === "number" && Number.isFinite(m.cost_usd) ? m.cost_usd : null,
    };
  } catch {
    return null;
  }
}

/** Headline numbers stored on the run record. */
export function summarizeReport({ report, manifestText, files }) {
  const findings = parseFindings(report);
  const header = parseHeader(report);
  const manifest = parseManifest(manifestText);
  const exploitPass = findings.filter((f) => /pass/i.test(f.exploitTest ?? "")).length;
  return {
    hasReport: Boolean(report && report.trim()),
    header,
    manifest,
    total: findings.length,
    counts: countBySeverity(findings),
    exploitPass,
    findings,
    artifacts: Array.isArray(files) ? files.slice(0, 400) : [],
  };
}
