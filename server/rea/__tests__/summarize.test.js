import test from "node:test";
import assert from "node:assert/strict";
import { summarizeResult, compactSummary, clip, MAX_CELL_CHARS, MAX_FINDINGS, MAX_LIMITATIONS, MAX_UNKNOWNS } from "../summarize.js";

const CTRL = [0, 7, 27, 127, 0x202e].map((n) => String.fromCharCode(n)).join("");

// ── synthetic Evidence (shaped after real REA 6.4.0 output) ──────────────────

function jsAppEvidence({ endpoints = 1, modules = 2, extra = {} } = {}) {
  const node = (kind, props, label = "x") => ({ node_id: `jag_node_${Math.random().toString(16).slice(2)}`, kind, observations: [{ label, properties: props }] });
  const nodes = [node("artifact", {}, "root")];
  for (let i = 0; i < modules; i += 1) nodes.push(node("javascript-module", { path: `m${i}.js`, module_format: "commonjs" }, `m${i}.js`));
  for (let i = 0; i < endpoints; i += 1) nodes.push(node("endpoint", { endpoint_kind: "network", value: `https://example.com/${i}`, mechanism: "call:fetch" }, "network endpoint"));
  return {
    evidence_id: `ev_${"a".repeat(64)}`,
    subject: { name: "app", digest: { sha256: "b".repeat(64) }, format: "directory", architecture: null, local_path: "/home/u/app" },
    provider: { id: "rea-javascript-application", name: "REA JavaScript application analyzer", version: "1" },
    predicate_type: "rea.javascript-application-analysis",
    operation: "analyze_javascript_application",
    normalized_result: {
      input_path: "/home/u/app",
      format: "directory",
      graph: { nodes, edges: [{}, {}], coverage: { status: "complete", truncated: false, omitted_count: 0, limits: [] }, limitations: ["graph limitation"] },
      summary: { browser_windows: 1, ipc: { operations: 3, literal_channels: 2 } },
      statistics: { relevant_files: 5, parsed_javascript_files: 4, modules, findings: 2, parse_failures: 0 },
      limitations: ["static only"],
      semantic_graph: { unknowns: [{ family: "data-flow", reason: "unknown-value", detail: "Unknown value at binding." }, "plain unknown"], coverage: { status: "unknown", truncated: false } },
      ...extra,
    },
    confidence: "derived",
    limitations: ["top level limitation"],
  };
}

test("javascript-app Evidence: headline, modules table, findings, limitations, unknowns, identity", () => {
  const s = summarizeResult({ resultShape: "javascript-app" }, JSON.stringify(jsAppEvidence()));
  assert.equal(s.kind, "javascript-app");
  assert.equal(s.headline.relevant_files, 5);
  assert.equal(s.headline.browser_windows, 1);
  assert.equal(s.headline.ipc_operations, 3);
  assert.equal(s.headline.graph_nodes, 4);
  assert.equal(s.headline.coverage, "complete");
  const mods = s.tables.find((t) => t.id === "modules");
  assert.equal(mods.total, 2);
  assert.deepEqual(mods.columns.slice(0, 2), ["path", "kind"]);
  assert.equal(mods.rows.length, 2);
  assert.ok(s.findings.some((f) => f.title === "endpoint: https://example.com/0"));
  assert.deepEqual(s.limitations.sort(), ["graph limitation", "static only", "top level limitation"]);
  assert.ok(s.unknowns.includes("data-flow: Unknown value at binding. (unknown-value)"));
  assert.ok(s.unknowns.includes("plain unknown"));
  assert.equal(s.identity.sha256, "b".repeat(64));
  assert.equal(s.identity.format, "directory");
  assert.equal(s.truncated, false);
  assert.ok(!JSON.stringify(s).includes("/home/u/app"), "the unit's local path is not carried");
});

test("javascript-app: coverage truncation and parse failures are surfaced; findings are capped", () => {
  const ev = jsAppEvidence({ endpoints: 500, extra: { statistics: { parse_failures: 2 } } });
  ev.normalized_result.graph.coverage.truncated = true;
  const s = summarizeResult("analyze-javascript-application", ev);
  assert.equal(s.truncated, true);
  assert.ok(s.findings.length <= MAX_FINDINGS);
  assert.equal(s.findings[0].severity, "warning");
  assert.match(s.findings[0].title, /2 source file/);
});

test("javascript-app: the summary-view projection (large results) is understood", () => {
  const view = {
    evidence_id: "ev_x",
    predicate_type: "rea.analysis-view",
    operation: "inspect_analysis_view",
    provider: { name: "REA analysis view projection" },
    normalized_result: {
      kind: "summary",
      view: { kind: "summary" },
      summary: {
        format: "directory",
        statistics: { relevant_files: 40, modules: 0, parse_failures: 1, findings: 7 },
        electron: { browser_windows: 2, ipc: { operations: 9 } },
        coverage: { application: { status: "complete", truncated: false }, semantic: { status: "unknown", truncated: true }, application_unknowns: 0, semantic_unknowns: 12 },
        limitation_count: 3,
      },
    },
    limitations: ["a limitation"],
  };
  const s = summarizeResult({ resultShape: "javascript-app" }, JSON.stringify(view), { size: 300_000_000, truncated: true, note: "stays on the unit" });
  assert.equal(s.kind, "javascript-app");
  assert.equal(s.headline.relevant_files, 40);
  assert.equal(s.headline.ipc_operations, 9);
  assert.equal(s.headline.resultBytes, 300_000_000);
  assert.equal(s.truncated, true);
  assert.equal(s.tables[0].id, "modules");
  assert.equal(s.tables[0].total, 40);
  assert.equal(s.tables[0].rows, undefined);
  assert.ok(s.limitations.includes("stays on the unit"));
  assert.ok(s.findings.some((f) => /could not be parsed/.test(f.title)));
  assert.ok(s.unknowns.some((u) => /12 semantic unknowns/.test(u)));
});

test("layout Evidence: sections and symbols become tables, mitigations findings", () => {
  const ev = {
    evidence_id: "ev_l",
    subject: { name: "a.out", digest: { sha256: "c".repeat(64) }, format: "elf", architecture: "amd64" },
    predicate_type: "rea.binary-layout",
    normalized_result: {
      class: "ELF64",
      sections: [{ name: ".text", size: 100, address: "0x401000" }, { name: ".data", size: 8, address: "0x402000" }],
      symbols: Array.from({ length: 50 }, (_, i) => ({ name: `fn${i}`, address: `0x${i}` })),
      mitigations: { nx: true, pie: false, relro: "partial" },
    },
    limitations: ["not executed"],
  };
  const s = summarizeResult({ resultShape: "layout" }, ev);
  assert.equal(s.kind, "layout");
  assert.equal(s.identity.arch, "amd64");
  assert.equal(s.headline.class, "ELF64");
  const sections = s.tables.find((t) => t.id === "sections");
  assert.equal(sections.total, 2);
  assert.deepEqual(sections.columns, ["name", "size", "address"]);
  const symbols = s.tables.find((t) => t.id === "symbols");
  assert.equal(symbols.total, 50);
  assert.equal(symbols.rows.length, 20, "preview rows are bounded");
  assert.deepEqual(s.findings.map((f) => f.title), ["nx: true", "pie: false", "relro: partial"]);
  assert.deepEqual(s.limitations, ["not executed"]);
});

test("native-function Evidence: pseudocode is counted, not carried; arrays become tables", () => {
  const ev = {
    evidence_id: "ev_n",
    subject: { name: "prog", digest: { sha256: "d".repeat(64) }, format: "pe", architecture: "x86" },
    normalized_result: {
      procedure: "main",
      address: "0x1000",
      pseudocode: "int main() { return 0; }".repeat(100),
      callers: [{ name: "start", address: "0x900" }],
      callees: [],
      assembly: [{ address: "0x1000", text: "push rbp" }],
      unknowns: ["indirect call"],
    },
  };
  const s = summarizeResult("function", ev);
  assert.equal(s.kind, "native-function");
  assert.equal(s.headline.procedure, "main");
  assert.equal(s.headline.pseudocode_chars, 2400);
  assert.ok(!JSON.stringify(s).includes("return 0"));
  assert.equal(s.tables.find((t) => t.id === "callers").total, 1);
  assert.equal(s.tables.find((t) => t.id === "callees").total, 0);
  assert.deepEqual(s.unknowns, ["indirect call"]);
});

test("generic fallback: scalar facts, array lengths, top-level keys", () => {
  const s = summarizeResult({ resultShape: "generic" }, { kind: "artifact", bytes: 42, format: "unknown", entries: [{ n: "a" }, { n: "b" }], deep: { x: 1, list: [1, 2, 3] } });
  assert.equal(s.kind, "generic");
  assert.equal(s.headline.bytes, 42);
  assert.equal(s.headline.format, "unknown");
  assert.equal(s.headline["deep.x"], 1);
  assert.match(s.headline.keys, /entries/);
  assert.equal(s.tables.find((t) => t.id === "entries").total, 2);
  assert.equal(s.tables.find((t) => t.id === "deep.list").total, 3);
  const arr = summarizeResult(null, JSON.stringify([{ a: 1 }, { a: 2 }, { a: 3 }]));
  assert.equal(arr.headline.items, 3);
  assert.equal(arr.tables[0].total, 3);
});

// ── errors, garbage, hostile input ───────────────────────────────────────────

test("an error object becomes a finding with its code, never a crash", () => {
  const e = { code: "capability_unavailable", category: "unsupported_provider", message: "Linux x64 only.", retryable: false, remediation: { action: "Use a Linux x64 unit." } };
  for (const input of [JSON.stringify(e), e]) {
    const s = summarizeResult({ resultShape: "layout" }, input);
    assert.equal(s.kind, "generic");
    assert.equal(s.headline.error, "capability_unavailable");
    assert.equal(s.findings.length, 1);
    assert.equal(s.findings[0].severity, "error");
    assert.equal(s.findings[0].code, "capability_unavailable");
    assert.match(s.findings[0].detail, /Linux x64 only\. Use a Linux x64 unit\./);
  }
  const plain = summarizeResult(null, '{"error":"boom"}');
  assert.equal(plain.findings[0].severity, "error");
  assert.match(plain.findings[0].detail, /boom/);
  const bare = summarizeResult(null, '{"code":"file_unavailable"}');
  assert.equal(bare.headline.error, "file_unavailable");
  // a legitimate result that merely has a "code" among many facts is not an error
  const ok = summarizeResult(null, { code: "A1", name: "x", a: 1, b: 2, c: 3 });
  assert.equal(ok.findings.length, 0);
});

test("garbage, empty, plain text, truncated JSON and non-objects never throw and say so", () => {
  const circular = {};
  circular.self = circular;
  const inputs = [null, undefined, "", "   ", "not json at all", '{"a":[1,2,', "[", "123", "true", "null", 42, [], {}, circular, Symbol.iterator, () => 1, Buffer.from("{\"x\":1}"), `${String.fromCharCode(0xfeff)}{"y":2}`];
  for (const input of inputs) {
    for (const wf of [null, "analyze", { resultShape: "javascript-app" }, { resultShape: "layout" }, { resultShape: "native-function" }, 7]) {
      const s = summarizeResult(wf, input);
      assert.ok(s && typeof s === "object");
      for (const k of ["kind", "headline", "tables", "findings", "limitations", "unknowns", "identity", "truncated"]) assert.ok(k in s, k);
    }
  }
  const cut = summarizeResult(null, '{"a":[1,2,');
  assert.equal(cut.truncated, true);
  assert.match(cut.limitations[0], /cut off|not valid JSON/);
  assert.equal(summarizeResult(null, "plain words").truncated, false);
  assert.deepEqual(summarizeResult(null, { x: 1 }).headline.x, 1);
  assert.equal(summarizeResult(null, Buffer.from('{"x":1}')).headline.x, 1);
});

test("everything is clipped, plain text and bounded", () => {
  const big = "x".repeat(10_000);
  const nasty = `a${CTRL}b\n\tc`;
  const ev = jsAppEvidence({ endpoints: 3 });
  ev.limitations = Array.from({ length: 500 }, (_, i) => `limit ${i} ${big}`);
  ev.normalized_result.semantic_graph.unknowns = Array.from({ length: 500 }, (_, i) => ({ family: nasty, detail: `${i} ${big}` }));
  ev.normalized_result.graph.nodes.push({ kind: "endpoint", observations: [{ label: nasty, properties: { value: big, mechanism: nasty } }] });
  ev.subject.name = nasty;
  const s = summarizeResult({ resultShape: "javascript-app" }, ev);
  assert.ok(s.limitations.length <= MAX_LIMITATIONS);
  assert.ok(s.unknowns.length <= MAX_UNKNOWNS);
  assert.ok(s.findings.length <= MAX_FINDINGS);
  const all = JSON.stringify(s);
  assert.equal([...all].some((ch) => { const c = ch.codePointAt(0); return c < 9 || c === 11 || c === 12 || (c > 13 && c < 32) || c === 127 || c === 0x202e; }), false);
  const walk = (v) => {
    if (typeof v === "string") assert.ok(v.length <= MAX_CELL_CHARS + 1, `string of ${v.length} chars`);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(s);
  assert.equal(s.identity.name, "a b c");
  assert.equal(clip(`x${CTRL}y`), "x y");
  assert.equal(clip(nasty), "a b c");
  assert.equal(clip(big).length, MAX_CELL_CHARS);
  assert.equal(clip(null), "");
});

test("a huge JSON text is not parsed in full and is marked truncated", () => {
  const s = summarizeResult(null, `{"a":"${"x".repeat(50 * 1024 * 1024)}"}`);
  assert.equal(s.truncated, true);
  assert.ok(s.limitations.length > 0);
});

test("size and hash facts from the unit are carried; truncated flag from the caller wins", () => {
  const s = summarizeResult({ resultShape: "generic" }, "", { size: 123, sha256: "E".repeat(64), truncated: true, note: "only size and hash" });
  assert.equal(s.headline.resultBytes, 123);
  assert.equal(s.identity.resultSha256, "e".repeat(64));
  assert.equal(s.truncated, true);
  assert.ok(s.limitations.includes("only size and hash"));
});

test("compactSummary: keeps headline and table shapes, drops row previews and long lists", () => {
  const full = summarizeResult({ resultShape: "javascript-app" }, jsAppEvidence({ endpoints: 60, modules: 30 }));
  assert.ok(full.tables[0].rows.length > 0);
  const c = compactSummary(full);
  assert.equal(c.kind, "javascript-app");
  assert.equal(c.tables[0].rows, undefined);
  assert.equal(c.tables[0].total, 30);
  assert.ok(c.findings.length <= 10);
  assert.equal(c.counts.findings, full.findings.length);
  assert.ok(JSON.stringify(c).length < 6000);
  assert.equal(compactSummary(null), null);
  assert.equal(compactSummary("x"), null);
});
