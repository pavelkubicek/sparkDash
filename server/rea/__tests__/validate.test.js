import test from "node:test";
import assert from "node:assert/strict";
import {
  validateRunRequest, validateViewRequest, validateUploadPath, validateUploadId, validateRunId, validateCompareRequest,
  validateUnitPath, reaViewObject, MAX_TIMEOUT_MINUTES,
} from "../validate.js";
import { workflowById, WORKFLOWS } from "../spec.js";
import { runOutToken } from "../argv.js";

const UP = "up-20261012-101010-abc123";
const resolveUpload = (id, rel) => (id === UP ? `/home/u/.cache/sparkdash/rea/uploads/${id}/extracted${rel ? `/${rel}` : ""}` : null);
const run = (body, opts = {}) => validateRunRequest(body, { resolveUpload, ...opts });
const base = (over = {}) => ({ workflowId: "analyze-javascript-application", target: { kind: "path", value: "/home/u/app.asar" }, authorized: true, ...over });
const bad = (r, re) => {
  assert.equal(r.ok, false, JSON.stringify(r).slice(0, 200));
  assert.equal(typeof r.error, "string");
  if (re) assert.match(r.error, re);
};

test("happy path: static workflow", () => {
  const r = run(base({ options: { "max-heap-mb": "2048", "artifact-format": "asar" }, label: "  my\nrun  ", timeoutMinutes: 5 }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.argv, ["analyze-javascript-application", "/home/u/app.asar", "--max-heap-mb", "2048", "--artifact-format", "asar", "--json"]);
  assert.deepEqual(r.paths, ["/home/u/app.asar"]);
  assert.equal(r.provider, null);
  assert.equal(r.timeoutMinutes, 5);
  assert.equal(r.label, "my run");
  assert.equal(r.execClass, "static");
  assert.equal(r.confirmExecute, false);
  assert.match(r.display, /^rea analyze-javascript-application \/home\/u\/app\.asar/);
  assert.equal(r.workflow.id, "analyze-javascript-application");
});

test("requests must be objects, with a known workflow and no unknown fields", () => {
  for (const b of [null, undefined, "x", 5, [], true]) bad(run(b));
  bad(run({ authorized: true }), /workflow/i);
  bad(run(base({ workflowId: "inspect-go-binary" })), /Unknown workflow/);
  bad(run(base({ workflowId: ["analyze"] })), /Unknown workflow/);
  bad(run(base({ workflowId: "__proto__" })), /Unknown workflow/);
  bad(run(base({ extra: 1 })), /Unknown field/);
});

test("authorization attestation is mandatory", () => {
  bad(run(base({ authorized: undefined })), /authorized/);
  bad(run(base({ authorized: "true" })), /authorized/);
  bad(run(base({ authorized: 1 })), /authorized/);
  bad(run(base({ authorized: false })), /authorized/);
});

test("confirmExecute is required for executes-target, device and network workflows", () => {
  const exec = { workflowId: "observe-native-ui", target: { kind: "path", value: "/home/u/app" }, authorized: true };
  bad(run(exec), /Confirm/);
  bad(run({ ...exec, confirmExecute: "true" }), /Confirm|true or false/);
  const ok = run({ ...exec, confirmExecute: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.execClass, "executes-target");
  assert.equal(ok.confirmExecute, true);
  assert.equal(ok.effects.launchesProcess, true);
  const dev = { workflowId: "list-adb-devices", authorized: true };
  bad(run(dev), /Confirm/);
  assert.equal(run({ ...dev, confirmExecute: true }).ok, true);
  const net = { workflowId: "list-browser-targets", authorized: true, options: { endpoint: "http://127.0.0.1:9222" } };
  bad(run(net), /Confirm/);
  assert.equal(run({ ...net, confirmExecute: true }).ok, true);
});

test("device writes are refused unless the server enables them", () => {
  const body = { workflowId: "uninstall-adb-package", authorized: true, confirmExecute: true, options: { serial: "emulator-5554", package: "com.example.app" } };
  bad(run(body), /REA_ENABLE_DEVICE_WRITES/);
  bad(run(body, { deviceWritesEnabled: false }), /REA_ENABLE_DEVICE_WRITES/);
  const r = run(body, { deviceWritesEnabled: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.argv, ["uninstall-adb-package", "emulator-5554", "com.example.app", "--json"]);
  assert.equal(r.effects.mutatesDevice, true);
  // still needs confirmation even when writes are enabled
  bad(run({ ...body, confirmExecute: undefined }, { deviceWritesEnabled: true }), /Confirm/);
  // install takes a target file
  const inst = run({ workflowId: "install-adb-package", authorized: true, confirmExecute: true, target: { kind: "path", value: "/home/u/a.apk" }, options: { serial: "R58M12", replace: true } }, { deviceWritesEnabled: true });
  assert.deepEqual(inst.argv, ["install-adb-package", "R58M12", "/home/u/a.apk", "--replace", "--json"]);
});

test("target paths: adversarial inputs", () => {
  const cases = [
    "relative/path", "../etc/passwd", "/home/u/../../etc/passwd", "/home/u/./x", "/", "~", "~/", "//", "/home//u",
    "/home/u/a\0b", "/home/u/a\nb", "/home/u/a\rb", "/home/u/a\tb", "/home/u/$(id)", "/home/u/`id`", "/home/u/a;b", "/home/u/a|b",
    "/home/u/a'b", '/home/u/a"b', "/home/u/a&b", "/home/u/a*", "/home/u/a?", "/home/u/a\\b", "/home/u/é", " /home/u/a", "/home/u/a ",
    "-rf", "--help", "/" + "a".repeat(500), "~root/x", "file:///etc/passwd",
  ];
  for (const value of cases) bad(run(base({ target: { kind: "path", value } })), undefined);
  for (const v of [undefined, null, 5, {}, [], true]) bad(run(base({ target: { kind: "path", value: v } })));
  bad(run(base({ target: undefined })), /Target/);
  bad(run(base({ target: "/home/u/app" })), /Target/);
  bad(run(base({ target: { kind: "url", value: "http://x" } })), /path on the unit|upload/);
  bad(run(base({ target: { kind: "path", value: "/home/u/a", extra: 1 } })), /unexpected field/);
  const ok = run(base({ target: { kind: "path", value: "~/Apps/My App (1).asar" } }));
  assert.equal(ok.ok, true);
  assert.equal(ok.argv[1], "~/Apps/My App (1).asar");
  assert.deepEqual(ok.paths, ["~/Apps/My App (1).asar"]);
  assert.equal(run(base({ target: { kind: "path", value: "/home/u/app/" } })).argv[1], "/home/u/app");
});

test("upload targets resolve through resolveUpload and are re-validated", () => {
  const r = run(base({ target: { kind: "upload", uploadId: UP, relPath: "dir/app.asar" } }));
  assert.equal(r.ok, true);
  assert.equal(r.argv[1], `/home/u/.cache/sparkdash/rea/uploads/${UP}/extracted/dir/app.asar`);
  assert.equal(r.target.display, `upload ${UP}/dir/app.asar`);
  assert.equal(run(base({ target: { kind: "upload", uploadId: UP } })).ok, true);
  bad(run(base({ target: { kind: "upload", uploadId: "up-1" } })), /upload id/);
  bad(run(base({ target: { kind: "upload", uploadId: "up-20261012-101010-zzzzzz" } })), /not available/);
  bad(run(base({ target: { kind: "upload", uploadId: UP, relPath: "../x" } })), /upload/i);
  bad(run(base({ target: { kind: "upload", uploadId: UP, relPath: "/etc/passwd" } })), /upload/i);
  bad(run(base({ target: { kind: "upload", uploadId: UP, relPath: "a/./b" } })), /upload/i);
  bad(run(base({ target: { kind: "upload", uploadId: UP, relPath: "a\0b" } })), /upload/i);
  bad(run(base({ target: { kind: "upload", uploadId: UP, value: "/etc/passwd" } })), /unexpected field/);
  bad(run(base({ target: { kind: "upload", uploadId: UP } }), { resolveUpload: undefined }), /Uploads/);
  bad(run(base({ target: { kind: "upload", uploadId: UP } }), { resolveUpload: () => { throw new Error("boom"); } }), /not available/);
  bad(run(base({ target: { kind: "upload", uploadId: UP } }), { resolveUpload: () => "/etc/../passwd" }), /\.\./);
  bad(run(base({ target: { kind: "upload", uploadId: UP } }), { resolveUpload: () => "relative" }), /absolute/);
});

test("two-target and zero-target workflows", () => {
  const cmp = { workflowId: "compare", authorized: true, target: { kind: "path", value: "/home/u/a.json" }, target2: { kind: "path", value: "/home/u/b.json" } };
  const r = run(cmp);
  assert.deepEqual(r.argv, ["compare", "/home/u/a.json", "/home/u/b.json", "--json"]);
  assert.deepEqual(r.paths, ["/home/u/a.json", "/home/u/b.json"]);
  bad(run({ ...cmp, target2: undefined }), /Second target/);
  bad(run({ ...cmp, target2: { kind: "path", value: "../x" } }), /Second target/);
  bad(run(base({ target2: { kind: "path", value: "/home/u/b" } })), /one target/);
  bad(run({ workflowId: "list-adb-devices", authorized: true, confirmExecute: true, target: { kind: "path", value: "/home/u/x" } }), /does not take/);
  // upload for the second target
  const mixed = run({ ...cmp, target2: { kind: "upload", uploadId: UP, relPath: "b.json" } });
  assert.equal(mixed.ok, true);
  assert.equal(mixed.paths.length, 2);
});

test("provider allow-list and spoofing", () => {
  const nat = { workflowId: "decompile", authorized: true, target: { kind: "path", value: "/home/u/bin" } };
  assert.equal(run(nat).provider, "auto");
  assert.deepEqual(run(nat).argv, ["decompile", "/home/u/bin", "--json"]);
  assert.deepEqual(run({ ...nat, provider: "ghidra" }).argv, ["decompile", "/home/u/bin", "--provider", "ghidra", "--json"]);
  for (const p of ["GHIDRA", "ghidra --evil", "ghidra\n", "../x", "binja", "--provider", "", " auto", 5, {}, ["ghidra"]]) {
    if (p === "") continue;
    bad(run({ ...nat, provider: p }), /Provider must be/);
  }
  // spoof through options
  bad(run({ ...nat, options: { provider: "ida" } }), /provider field/);
  bad(run({ ...nat, options: { "--provider": "ida" } }), /provider field/);
  // a workflow with no provider refuses a named one but tolerates auto
  const st = { workflowId: "inspect-managed-members", authorized: true, target: { kind: "path", value: "/home/u/a.dll" } };
  bad(run({ ...st, provider: "ghidra" }), /does not use/);
  assert.equal(run({ ...st, provider: "auto" }).provider, null);
});

test("options: unknown, managed, injection and type checks", () => {
  const w = (options) => run(base({ options }));
  bad(w({ nope: 1 }), /Unknown option/);
  bad(w({ json: true }), /managed by the dashboard/);
  bad(w({ format: "yaml" }), /managed by the dashboard/);
  bad(w({ "filter-output": "a" }), /managed by the dashboard/);
  bad(w({ snapshot: "/x" }), /managed by the dashboard/);
  bad(w({ "output-directory": "/tmp/x" }), /managed by the dashboard/);
  bad(w({ "--max-heap-mb": 1 }), /Unknown option/);
  bad(w({ "max-heap-mb": "1024 --json" }), /whole number/);
  bad(w({ "max-heap-mb": 1.5 }), /whole number/);
  bad(w({ "max-heap-mb": 64 }), /at least 128/);
  bad(w({ "max-heap-mb": 99999 }), /at most/);
  bad(w({ "max-heap-mb": -5 }), /whole number|at least/);
  bad(w({ "max-heap-mb": "1e3" }), /whole number/);
  bad(w({ "max-heap-mb": {} }), /whole number/);
  bad(w({ "artifact-format": "zip" }), /one of/);
  bad(w({ "artifact-format": ["asar"] }), /one of/);
  bad(w({ "artifact-format": "asar\n--json" }), /one of/);
  bad(run(base({ options: [] })), /object/);
  bad(run(base({ options: "x" })), /object/);
  const nul = Object.create(null);
  nul["max-heap-mb"] = 256;
  assert.equal(run(base({ options: nul })).ok, true);
});

test("string options: flag injection stays inside one argv element", () => {
  const nat = (options) => run({ workflowId: "search", authorized: true, target: { kind: "path", value: "/home/u/bin" }, options });
  const r = nat({ pattern: "--provider=evil --json" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.argv, ["search", "/home/u/bin", "--pattern=--provider=evil --json", "--json"]);
  bad(nat({ pattern: "a\nb" }), /control/);
  bad(nat({ pattern: "a\0b" }), /control/);
  bad(nat({ pattern: "x".repeat(5000) }), /too long/);
  bad(nat({}), /required/);
  bad(nat({ pattern: "" }), /required/);
  // positionals cannot become flags: tight patterns and the leading-dash check in verifyArgv
  const xr = run({ workflowId: "inspect-native-api", authorized: true, target: { kind: "path", value: "/home/u/bin" }, options: { address: "--provider=ida" } });
  bad(xr, /must not start with/);
  const adb = (options) => run({ workflowId: "inspect-adb-device", authorized: true, confirmExecute: true, options });
  bad(adb({ serial: "-s" }), /must not start/);
  bad(adb({ serial: "a b" }), /not accepted/);
  bad(adb({ serial: "a;rm -rf /" }), /not accepted/);
  bad(adb({}), /required/);
  assert.equal(adb({ serial: "192.168.1.5:5555" }).ok, true);
  bad(run({ workflowId: "list-adb-directory", authorized: true, confirmExecute: true, options: { serial: "S1", "device-path": "/sdcard/../data" } }), /\.\./);
  bad(run({ workflowId: "list-adb-directory", authorized: true, confirmExecute: true, options: { serial: "S1", "device-path": "sdcard" } }), /not accepted/);
});

test("CDP endpoints must be loopback http", () => {
  const ep = (endpoint, wfid = "list-browser-targets") => run({ workflowId: wfid, authorized: true, confirmExecute: true, options: { endpoint } });
  assert.equal(ep("http://127.0.0.1:9222").ok, true);
  assert.equal(ep("http://localhost:9222").ok, true);
  assert.equal(ep("http://[::1]:9222").ok, true);
  for (const e of ["http://evil.example:9222", "http://127.0.0.1.evil.com:9222", "http://169.254.169.254:80", "https://127.0.0.1:9222", "http://127.0.0.1", "http://127.0.0.1:9222/x", "ws://127.0.0.1:9222", "http://user@127.0.0.1:9222", "-x"]) {
    bad(ep(e), /not accepted|must not start/);
  }
  bad(ep("http://localhost:9222", "list-electron-targets"), /not accepted/);
  assert.equal(ep("http://127.0.0.1:9229", "list-electron-targets").ok, true);
});

test("path-bearing options are validated and added to paths; outputs are never accepted", () => {
  const body = (options) => ({ workflowId: "trace-web-module-imports", authorized: true, target: { kind: "path", value: "/home/u/m/manifest.json" }, options });
  const ok = run(body({ scriptIndex: 3, "import-map-path": "~/maps/importmap.json" }));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.argv, ["trace-web-module-imports", "/home/u/m/manifest.json", "3", "--import-map-path", "~/maps/importmap.json", "--json"]);
  assert.deepEqual(ok.paths, ["/home/u/m/manifest.json", "~/maps/importmap.json"]);
  bad(run(body({ scriptIndex: 3, "import-map-path": "../x.json" })), undefined);
  bad(run(body({ scriptIndex: 3, "import-map-path": "/a/../b" })), /\.\./);
  bad(run(body({ scriptIndex: 3, "import-map-path": "/a/b\0" })), /control/);
  bad(run(body({ scriptIndex: 3, "import-map-path": "-rf" })), /absolute/);
  bad(run(body({ scriptIndex: -1 })), /whole number|at least/);
  bad(run(body({})), /required/);
  // output directories
  const fw = { workflowId: "extract-firmware", authorized: true, target: { kind: "path", value: "/home/u/fw.bin" } };
  assert.deepEqual(run(fw).argv, ["extract-firmware", "/home/u/fw.bin", runOutToken("outputDirectory"), "--json"]);
  bad(run({ ...fw, options: { outputDirectory: "/tmp/evil" } }), /managed by the dashboard/);
  bad(run({ ...fw, options: { offset: 10 } }), /needs "length"/);
  assert.equal(run({ ...fw, options: { offset: 10, length: 20, "max-depth": 4 } }).ok, true);
  bad(run({ ...fw, options: { "max-depth": 11 } }), /at most/);
  const shot = { workflowId: "capture-adb-screen", authorized: true, confirmExecute: true, options: { serial: "S1" } };
  assert.deepEqual(run(shot).argv, ["capture-adb-screen", "S1", "--output-directory", runOutToken("output-directory"), "--json"]);
  bad(run({ ...shot, options: { serial: "S1", "output-directory": "/etc" } }), /managed by the dashboard/);
  // string option that names a bundle-relative path cannot escape
  const pl = (rel) => run({ workflowId: "inspect-plist", authorized: true, target: { kind: "path", value: "/home/u/A.app" }, options: { "relative-path": rel } });
  assert.equal(pl("Contents/Info.plist").ok, true);
  bad(pl("../../etc/passwd"), /\.\./);
  bad(pl("/etc/passwd"), /not accepted/);
});

test("lists, JSON and require-one-of options", () => {
  const sym = (symbols) => run({ workflowId: "demangle-swift", authorized: true, target: { kind: "path", value: "/home/u/a" }, options: { symbols } });
  assert.equal(sym(["$s4main3FooV"]).ok, true);
  assert.equal(sym("$s4main3FooV\n$sSS").argv.length, 5);
  bad(sym(["-x"]), /must not start/);
  bad(sym(["a b"]), /not accepted/);
  bad(sym([]), /required/);
  bad(sym(Array(60).fill("$sSS")), /too many/);
  const steps = (v) => run({ workflowId: "observe-native-ui", authorized: true, confirmExecute: true, target: { kind: "path", value: "/home/u/a" }, options: { steps: v } });
  assert.equal(steps('[{"action":"click"}]').ok, true);
  assert.equal(steps([{ action: "click" }]).argv.includes('--steps=[{"action":"click"}]'), true);
  bad(steps('{"a":1}'), /array/);
  bad(steps("not json"), /valid JSON/);
  bad(steps("[" + "1,".repeat(9000) + "1]"), /too long/);
  const ann = (options) => run({ workflowId: "annotate-native-function", authorized: true, target: { kind: "path", value: "/home/u/bin" }, options: { procedure: "main", ...options } });
  bad(ann({}), /at least one/);
  assert.equal(ann({ comment: "" }).ok, true);
  assert.equal(ann({ name: "entry" }).ok, true);
  const dt = (o) => run({ workflowId: "inspect-native-data-type", authorized: true, target: { kind: "path", value: "/home/u/bin" }, options: o });
  bad(dt({}), /at least one/);
  const sk = (options) => run({ workflowId: "inspect-web-network-capture", authorized: true, target: { kind: "path", value: "/home/u/c.har" }, options });
  const hidden = sk({ format: "har", "sensitive-value": ["hunter2"] });
  assert.equal(hidden.ok, true);
  assert.ok(!hidden.display.includes("hunter2"));
  bad(sk({ format: "zip" }), /one of/);
});

test("timeout is clamped and must be numeric", () => {
  assert.equal(run(base({ timeoutMinutes: 0 })).timeoutMinutes, 1);
  assert.equal(run(base({ timeoutMinutes: 100000 })).timeoutMinutes, MAX_TIMEOUT_MINUTES);
  assert.equal(run(base({ timeoutMinutes: "30" })).timeoutMinutes, 30);
  assert.equal(run(base({ timeoutMinutes: 7.6 })).timeoutMinutes, 8);
  assert.equal(run(base()).timeoutMinutes, workflowById("analyze-javascript-application").defaultTimeoutMinutes);
  for (const t of ["abc", "1e3", "-5", NaN, Infinity, {}, [5], "5 min"]) bad(run(base({ timeoutMinutes: t })), /time limit/);
});

test("huge strings never throw", () => {
  const huge = "a".repeat(2_000_000);
  bad(run(base({ target: { kind: "path", value: huge } })));
  bad(run(base({ options: { "artifact-format": huge } })));
  assert.equal(run(base({ label: huge })).label.length, 120);
  bad(run(base({ workflowId: huge })), /Unknown workflow/);
  const cyc = {};
  cyc.self = cyc;
  bad(run(cyc));
});

test("a request built from the spec itself validates for every workflow", () => {
  // Smoke: a request built from the spec itself must be accepted, for every workflow.
  const fill = (a) => {
    if (a.kind === "bool") return true;
    if (a.kind === "int") return a.min ?? 0;
    if (a.kind === "choice") return a.choices[0];
    if (a.kind === "path") return "/home/u/extra.json";
    if (a.kind === "json") return a.jsonType === "array" ? "[]" : "{}";
    if (a.kind === "intlist") return [0];
    const sample = {
      SERIAL: "emulator-5554", PKG: "com.example.app", PKG_QUERY: "example", DEVPATH: "/sdcard/x", ENDPOINT: "http://127.0.0.1:9222",
      ENDPOINT_LITERAL: "http://127.0.0.1:9229", TARGET_ID: "ABC123", ORIGIN: "http://localhost:3000", CLASS: "com.example.Main", METHOD: "onCreate",
    };
    const src = a.pattern || "";
    let v = "main";
    if (src.includes("emulator") || src === "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$") v = a.name === "serial" ? sample.SERIAL : "ABC123";
    if (a.name === "package") v = sample.PKG;
    if (a.name === "query" && a.pattern && a.pattern.includes("{1,100}")) v = sample.PKG_QUERY;
    if (a.name === "device-path") v = sample.DEVPATH;
    if (a.name === "endpoint") v = a.pattern.includes("localhost") ? sample.ENDPOINT : sample.ENDPOINT_LITERAL;
    if (a.name === "targetId") v = sample.TARGET_ID;
    if (a.name === "className") v = sample.CLASS;
    if (a.name === "methodName") v = sample.METHOD;
    if (a.name === "key") v = "adb_enabled";
    if (a.name === "action") v = "android.intent.action.VIEW";
    if (a.name === "sourceMapUrl") v = "https://example.com/a.js.map";
    if (a.name === "allowed-origins") v = [sample.ORIGIN];
    if (a.name === "extra") v = ["string:k:v"];
    if (a.name === "data-uri") v = "https://example.com";
    if (a.name === "component") v = "com.example/.Main";
    if (a.name === "relative-path" || a.name === "archive") v = "Contents/Info.plist";
    if (a.name === "root") v = a.kind === "list" ? ["Contents/MacOS"] : "root";
    if (a.name === "locale") v = "en";
    if (a.name === "symbols") v = ["$sSS"];
    if (a.name === "sensitive-value") v = ["secret"];
    if (a.kind === "list" && !Array.isArray(v)) v = [v];
    return v;
  };
  {
    for (const w of WORKFLOWS) {
      const options = {};
      for (const a of w.args) {
        if (a.kind === "path-run-owned") continue;
        if (a.required || a.positional) options[a.name] = fill(a);
      }
      if (w.requireOneOf) options[w.requireOneOf[0]] = fill(w.args.find((a) => a.name === w.requireOneOf[0]));
      const body = {
        workflowId: w.id, authorized: true, confirmExecute: true, options,
        ...(w.targets >= 1 ? { target: { kind: "path", value: "/home/u/t1.bin" } } : {}),
        ...(w.targets >= 2 ? { target2: { kind: "path", value: "/home/u/t2.bin" } } : {}),
      };
      const r = run(body, { deviceWritesEnabled: true });
      assert.equal(r.ok, true, `${w.id}: ${r.error}`);
      assert.equal(r.argv[0], w.command);
      assert.equal(r.argv.at(-1), "--json");
    }
  }
});

test("ids, upload paths and compare requests", () => {
  assert.equal(validateUploadId(UP).ok, true);
  for (const v of ["up-1", "", null, undefined, 5, `${UP}x`, `x${UP}`, "UP-20261012-101010-abc123", "up-20261012-101010-ABC123", `${UP}\n`]) assert.equal(validateUploadId(v).ok, false);
  assert.equal(validateRunId("rea-20261012-101010-ab12").ok, true);
  for (const v of ["rea-1", "../x", "rea-20261012-101010-ab12/../x", "rea-20261012-101010-AB12", null, {}]) assert.equal(validateRunId(v).ok, false);
  for (const ok of ["a", "a.b", "dir/file.txt", "a/b/c/d.bin", "..." , ".hidden", "a-b_c"]) assert.equal(validateUploadPath(ok).ok, true, ok);
  for (const no of ["", "..", ".", "../a", "a/..", "a/../b", "/a", "a//b", "a/", "a\\b", "a\0b", "a b", "a/./b", "é", "x".repeat(129), Array(20).fill("a").join("/"), null, 5]) {
    assert.equal(validateUploadPath(no).ok, false, JSON.stringify(no));
  }
  assert.equal(validateCompareRequest({ leftRunId: "rea-20261012-101010-ab12", rightRunId: "rea-20261012-101011-cd34" }).ok, true);
  bad(validateCompareRequest({ leftRunId: "rea-20261012-101010-ab12", rightRunId: "rea-20261012-101010-ab12" }), /different/);
  bad(validateCompareRequest({ leftRunId: "x", rightRunId: "y" }));
  bad(validateCompareRequest(null));
  assert.equal(validateUnitPath("/home/u/ok").ok, true);
  assert.equal(validateUnitPath("/").ok, false);
});

test("view requests", () => {
  const js = workflowById("analyze-javascript-application");
  const lay = workflowById("inspect-binary-layout");
  const fn = workflowById("function");
  const gen = workflowById("inspect-managed-members");
  assert.deepEqual(validateViewRequest({}, js).view, { kind: "summary" });
  assert.deepEqual(validateViewRequest({ kind: "summary" }, js).view, { kind: "summary" });
  assert.deepEqual(validateViewRequest({ collection: "modules" }, js).view, { kind: "page", collection: "modules", offset: 0, limit: 32 });
  assert.deepEqual(validateViewRequest({ collection: "modules", offset: "64", limit: "200" }, js).view, { kind: "page", collection: "modules", offset: 64, limit: 200 });
  assert.deepEqual(validateViewRequest({ collection: "symbols", offset: "0", limit: "10" }, lay).view, { kind: "page", collection: "symbols", offset: 0, limit: 10 });
  assert.deepEqual(validateViewRequest({ kind: "module", path: "src/main.js" }, js).view, { kind: "module", collection: "modules", selector: { path: "src/main.js" } });
  assert.deepEqual(reaViewObject(validateViewRequest({ kind: "module", path: "" }, js).view), { kind: "item", collection: "modules", selector: { path: "" } });
  // REA 6.4.0: module items are never selected by index or name.
  assert.equal(validateViewRequest({ kind: "module", index: "3" }, js).ok, false);
  assert.equal(validateViewRequest({ kind: "module", name: "main.js" }, js).ok, false);
  assert.deepEqual(validateViewRequest({ kind: "facet", facet: "mitigations" }, lay).view, { kind: "facet", facet: "mitigations" });
  assert.deepEqual(validateViewRequest({ kind: "native", facet: "pseudocode", limit: "5" }, fn).view, { kind: "native", facet: "pseudocode", offset: 0, limit: 5 });
  bad(validateViewRequest({}, gen), /no paged view/);
  bad(validateViewRequest({}, null));
  bad(validateViewRequest({ collection: "Modules" }, js), /not valid/);
  bad(validateViewRequest({ collection: "a".repeat(100) }, js), /not valid/);
  bad(validateViewRequest({ collection: "../../x" }, js), /not valid/);
  bad(validateViewRequest({ collection: "symbols" }, js), /one of/);
  bad(validateViewRequest({ collection: "modules", offset: "-1" }, js), /Offset/);
  bad(validateViewRequest({ collection: "modules", offset: "10000001" }, js), /Offset/);
  bad(validateViewRequest({ collection: "modules", limit: "0" }, js), /Limit/);
  bad(validateViewRequest({ collection: "modules", limit: "201" }, js), /Limit/);
  bad(validateViewRequest({ collection: "modules", limit: "1e2" }, js), /Limit/);
  bad(validateViewRequest({ kind: "facet", facet: "mitigations" }, js), /layout/);
  bad(validateViewRequest({ kind: "native", facet: "nope" }, fn), /Facet/);
  bad(validateViewRequest({ kind: "native", facet: "pseudocode" }, js), /native function/);
  bad(validateViewRequest({ kind: "module" }, js), /path or node_id/);
  bad(validateViewRequest({ kind: "evil" }, js), /Unknown view kind/);
  bad(validateViewRequest({ kind: { a: 1 } }, js), /Unknown view kind/);
});
