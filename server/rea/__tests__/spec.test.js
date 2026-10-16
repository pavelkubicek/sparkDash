import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { WORKFLOWS, GROUPS, EXEC_CLASSES, SKIPPED, workflowById, publicSpec, PATTERNS } from "../spec.js";
import { ENGINES, PROVIDER_IDS } from "../providers.js";
import { buildArgv, verifyArgv, runOutToken, serverManagedFlag, displayLine } from "../argv.js";

const COMMANDS_FILE = "/tmp/claude-1000/-home-zurih-web-admin-sparkDash/9d224706-7c8e-462a-aca2-77a06d242601/scratchpad/rea-commands.txt";
const wf = (id) => workflowById(id);

test("every catalog command exists in the real CLI command list, and every CLI command is a workflow or documented as skipped", (t) => {
  if (!fs.existsSync(COMMANDS_FILE)) {
    t.skip(`${COMMANDS_FILE} is absent: cannot compare against the real rea 6.4.0 command list`);
    return;
  }
  const cmds = new Set(fs.readFileSync(COMMANDS_FILE, "utf8").split(/\s+/).filter(Boolean));
  for (const w of WORKFLOWS) assert.ok(cmds.has(w.command), `${w.id}: command ${w.command} is not in rea 6.4.0`);
  const known = new Set([...WORKFLOWS.map((w) => w.command), ...SKIPPED.map((s) => s.command)]);
  for (const c of cmds) assert.ok(known.has(c), `${c} is neither a workflow nor in SKIPPED`);
  for (const s of SKIPPED) assert.ok(cmds.has(s.command) && s.reason.length > 10, `SKIPPED ${s.command}`);
});

test("ids are unique, ids equal commands, no invented commands that the docs are ahead on", () => {
  const ids = WORKFLOWS.map((w) => w.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const w of WORKFLOWS) assert.equal(w.id, w.command);
  assert.equal(workflowById("inspect-go-binary"), null);
});

test("every workflow has a known group, execClass and a complete effects object", () => {
  const groups = new Set(GROUPS.map((g) => g.id));
  const classes = new Set(EXEC_CLASSES.map((c) => c.id));
  for (const g of GROUPS) assert.ok(WORKFLOWS.some((w) => w.group === g.id), `group ${g.id} is empty`);
  for (const w of WORKFLOWS) {
    assert.ok(groups.has(w.group), `${w.id} group`);
    assert.ok(classes.has(w.execClass), `${w.id} execClass`);
    for (const k of ["launchesProcess", "network", "writesFs", "mutatesDevice", "usesProvider"]) assert.equal(typeof w.effects[k], "boolean", `${w.id}.${k}`);
    assert.ok(w.label && w.blurb && w.defaultTimeoutMinutes >= 1 && w.defaultTimeoutMinutes <= 240, w.id);
    assert.ok([0, 1, 2].includes(w.targets));
    assert.equal(w.targetKinds.length > 0, w.targets > 0);
    assert.equal(w.effects.usesProvider, w.needsProvider);
    assert.equal(w.args.some((a) => a.name === "provider" || a.flag === "--provider"), false);
  }
});

test("effects fail closed: static means nothing launched, nothing contacted, nothing on a device", () => {
  for (const w of WORKFLOWS) {
    if (w.execClass === "static") {
      assert.equal(w.effects.launchesProcess, false, w.id);
      assert.equal(w.effects.network, false, w.id);
      assert.equal(w.effects.mutatesDevice, false, w.id);
      assert.equal(w.needsProvider, false, w.id);
    }
    if (w.effects.mutatesDevice) assert.equal(w.execClass, "device", w.id);
    if (w.group === "adb-write") assert.equal(w.effects.mutatesDevice, true, w.id);
    if (w.needsProvider) assert.equal(w.execClass, "native-provider", w.id);
  }
});

test("effect spot checks", () => {
  for (const id of ["observe-native-ui", "capture-native-ui-scenario", "observe-native-calls", "capture-process", "capture-browser-scenario", "capture-electron-scenario"]) {
    assert.equal(wf(id).execClass, "executes-target", id);
  }
  for (const id of ["install-adb-package", "uninstall-adb-package", "push-adb-file", "start-adb-app", "stop-adb-app", "start-adb-activity"]) {
    assert.equal(wf(id).execClass, "device", id);
    assert.equal(wf(id).effects.mutatesDevice, true, id);
  }
  for (const id of ["list-adb-devices", "read-adb-logcat", "pull-adb-file", "capture-adb-screen", "collect-adb-bugreport"]) {
    assert.equal(wf(id).execClass, "device", id);
    assert.equal(wf(id).effects.mutatesDevice, false, id);
  }
  for (const id of ["list-browser-targets", "observe-web-execution", "observe-javascript-runtime", "list-jeb-units"]) assert.equal(wf(id).execClass, "network", id);
  assert.equal(wf("analyze-javascript-application").execClass, "static");
  assert.equal(wf("analyze").execClass, "native-provider");
  assert.equal(wf("analyze").needsProvider, true);
  assert.equal(wf("annotate-native-function").effects.writesFs, true);
  assert.equal(wf("inspect-binary-layout").execClass, "native-provider");
});

test("viewable and result shapes", () => {
  assert.deepEqual(WORKFLOWS.filter((w) => w.viewable).map((w) => w.id).sort(), ["analyze-javascript-application", "function", "inspect-binary-layout"]);
  assert.equal(wf("analyze-javascript-application").resultShape, "javascript-app");
  assert.equal(wf("inspect-binary-layout").resultShape, "layout");
  assert.equal(wf("function").resultShape, "native-function");
});

test("args are well formed; run-owned outputs are never ordinary args; positionals resolve", () => {
  for (const w of WORKFLOWS) {
    const names = new Set();
    for (const a of w.args) {
      assert.ok(!names.has(a.name), `${w.id}: duplicate arg ${a.name}`);
      names.add(a.name);
      assert.ok(["bool", "int", "string", "choice", "list", "intlist", "path", "json", "path-run-owned"].includes(a.kind), `${w.id}.${a.name}`);
      if (a.positional) assert.equal(a.flag, null);
      else assert.equal(a.flag, `--${a.name}`);
      if (a.kind === "choice") assert.ok(a.choices.length > 0);
      if (a.kind === "int") assert.ok(a.min !== undefined && a.max !== undefined && a.min >= 0, `${w.id}.${a.name}`);
      if (a.pattern) assert.doesNotThrow(() => new RegExp(a.pattern));
      assert.equal(serverManagedFlag(a.name), a.kind === "path-run-owned" && a.name === "output-directory" ? "output-directory" : serverManagedFlag(a.name));
    }
    for (const p of w.positionals) {
      if (p.startsWith("$")) assert.ok(p === "$target" || (p === "$target2" && w.targets === 2), `${w.id} ${p}`);
      else assert.ok(w.args.some((a) => a.name === p && a.positional), `${w.id} positional ${p}`);
    }
    if (w.targets >= 1) assert.ok(w.positionals.includes("$target"), w.id);
    if (w.targets === 2) assert.ok(w.positionals.includes("$target2"), w.id);
    for (const a of w.args) if (a.positional) assert.ok(w.positionals.includes(a.name), `${w.id}: positional ${a.name} not placed`);
  }
  for (const k of Object.values(PATTERNS)) assert.doesNotThrow(() => new RegExp(k));
});

test("every flagged arg and positional is a real option of the real CLI help", (t) => {
  const helpFile = COMMANDS_FILE.replace("rea-commands.txt", "rea-cli-help.txt");
  if (!fs.existsSync(helpFile)) {
    t.skip(`${helpFile} is absent`);
    return;
  }
  const sections = new Map();
  let cur = null;
  for (const line of fs.readFileSync(helpFile, "utf8").split("\n")) {
    const m = /^################ (.+)$/.exec(line);
    if (m) {
      cur = m[1];
      sections.set(cur, []);
    } else if (cur) sections.get(cur).push(line);
  }
  for (const w of WORKFLOWS) {
    const text = sections.get(w.command).join("\n");
    for (const a of w.args) {
      if (a.flag) assert.ok(text.includes(a.flag), `${w.id}: ${a.flag} not in the real help`);
    }
  }
});

test("argv shape per family", () => {
  assert.deepEqual(buildArgv(wf("analyze-javascript-application"), { targetValue: "/a/app.asar", options: { "max-heap-mb": 2048, "artifact-format": "asar" } }),
    ["analyze-javascript-application", "/a/app.asar", "--max-heap-mb", "2048", "--artifact-format", "asar", "--json"]);
  assert.deepEqual(buildArgv(wf("analyze"), { targetValue: "/a/bin", options: {}, provider: "ghidra" }), ["analyze", "/a/bin", "--provider", "ghidra", "--json"]);
  assert.deepEqual(buildArgv(wf("analyze"), { targetValue: "/a/bin", options: {}, provider: "auto" }), ["analyze", "/a/bin", "--json"]);
  assert.deepEqual(buildArgv(wf("inspect-managed-members"), { targetValue: "/a/x.dll", provider: "ghidra" }), ["inspect-managed-members", "/a/x.dll", "--json"]);
  assert.deepEqual(buildArgv(wf("search"), { targetValue: "/a/bin", options: { pattern: "-x", mode: "regex", "case-sensitive": true } }),
    ["search", "/a/bin", "--pattern=-x", "--mode", "regex", "--case-sensitive", "--json"]);
  assert.deepEqual(buildArgv(wf("compare-managed-members"), { targetValue: "/l.dll", target2Value: "/r.dll" }), ["compare-managed-members", "/l.dll", "/r.dll", "--json"]);
  assert.deepEqual(buildArgv(wf("extract-firmware"), { targetValue: "/f.bin", options: { offset: 16, length: 32 } }),
    ["extract-firmware", "/f.bin", runOutToken("outputDirectory"), "--offset", "16", "--length", "32", "--json"]);
  assert.deepEqual(buildArgv(wf("install-adb-package"), { targetValue: "/a.apk", options: { serial: "emulator-5554", replace: true } }),
    ["install-adb-package", "emulator-5554", "/a.apk", "--replace", "--json"]);
  assert.deepEqual(buildArgv(wf("push-adb-file"), { targetValue: "/a.txt", options: { serial: "S1", "device-path": "/sdcard/a.txt" } }),
    ["push-adb-file", "S1", "/a.txt", "/sdcard/a.txt", "--json"]);
  assert.deepEqual(buildArgv(wf("capture-adb-screen"), { options: { serial: "S1" } }),
    ["capture-adb-screen", "S1", "--output-directory", runOutToken("output-directory"), "--json"]);
  assert.deepEqual(buildArgv(wf("inspect-web-page"), { options: { endpoint: "http://127.0.0.1:9222", targetId: "ABC", "allowed-origins": ["http://a", "http://b"], "include-console-text": true } }),
    ["inspect-web-page", "http://127.0.0.1:9222", "ABC", "--allowed-origins=http://a", "--allowed-origins=http://b", "--include-console-text", "--json"]);
  assert.deepEqual(buildArgv(wf("inspect-web-network-capture"), { targetValue: "/c.har", options: { format: "har", record: [0, 2] } }),
    ["inspect-web-network-capture", "/c.har", "har", "--record", "0", "--record", "2", "--json"]);
  assert.deepEqual(buildArgv(wf("demangle-swift"), { targetValue: "/a", options: { symbols: ["$s4main3FooV", "$sSS"] } }), ["demangle-swift", "/a", "$s4main3FooV", "$sSS", "--json"]);
  assert.deepEqual(buildArgv(wf("list-adb-devices")), ["list-adb-devices", "--json"]);
  assert.deepEqual(buildArgv(wf("observe-native-calls"), { targetValue: "/a/app", target2Value: "/j.json" }), ["observe-native-calls", "/a/app", "/j.json", "--json"]);
});

test("verifyArgv rejects foreign flags and control characters", () => {
  const w = wf("analyze");
  assert.equal(verifyArgv(w, ["analyze", "/a", "--json"]), null);
  assert.match(verifyArgv(w, ["analyze", "/a", "--snapshot", "/x", "--json"]), /Unexpected flag/);
  assert.match(verifyArgv(w, ["analyze", "-x", "--json"]), /Unexpected flag/);
  assert.match(verifyArgv(w, ["analyze", "/a\nb", "--json"]), /control/);
  assert.match(verifyArgv(w, ["analyze", "/a"]), /--json/);
  assert.match(verifyArgv(wf("inspect-managed-members"), ["inspect-managed-members", "/a", "--provider", "x", "--json"]), /Unexpected flag/);
  assert.match(verifyArgv(w, ["analyze", "/a", "--provider=ida", "--json"]), /value form/);
  assert.match(verifyArgv(w, ["analyze", "/a", "--json=1", "--json"]), /value form/);
  for (const f of ["json", "format", "filter-output", "provider", "snapshot", "client", "output-directory"]) assert.equal(serverManagedFlag(`--${f}`), f);
  assert.equal(serverManagedFlag("overwrite"), null);
});

test("display line hides secrets and bulky JSON", () => {
  const line = displayLine(wf("inspect-web-network-capture"), { targetDisplay: "/c.har", options: { format: "har", "sensitive-value": ["hunter2-secret"] } });
  assert.ok(!line.includes("hunter2"));
  assert.match(line, /^rea inspect-web-network-capture \/c\.har har /);
});

test("providers and engines", () => {
  assert.deepEqual(PROVIDER_IDS, ["auto", "ghidra", "hopper", "ida"]);
  const ids = ENGINES.map((e) => e.id);
  for (const id of ["ghidra", "hopper", "ida", "jadx", "apktool", "binwalk", "unblob", "adb", "jeb"]) assert.ok(ids.includes(id), id);
  for (const e of ENGINES) assert.ok(e.label && Array.isArray(e.bins) && Array.isArray(e.envVars) && e.unlocks.length > 10, e.id);
  const engineIds = new Set(ids);
  for (const w of WORKFLOWS) for (const p of w.prerequisites) assert.ok(engineIds.has(p), `${w.id} prerequisite ${p}`);
});

test("publicSpec is JSON-safe, matches the contract and carries no functions", () => {
  const spec = publicSpec();
  assert.deepEqual(JSON.parse(JSON.stringify(spec)), spec);
  assert.equal(spec.workflows.length, WORKFLOWS.length);
  assert.equal(spec.groups.length, GROUPS.length);
  for (const w of spec.workflows) {
    for (const k of ["id", "label", "group", "blurb", "command", "execClass", "effects", "targetKinds", "targets", "needsProvider", "prerequisites", "args", "resultShape", "defaultTimeoutMinutes", "viewable"]) {
      assert.ok(k in w, `${w.id}.${k}`);
    }
    assert.ok(["javascript-app", "layout", "native-function", "generic"].includes(w.resultShape));
    assert.ok(w.args.every((a) => a.kind !== "path-run-owned"));
  }
  // mutating the copy must not touch the catalog
  spec.workflows[0].label = "changed";
  assert.notEqual(WORKFLOWS[0].label, "changed");
  assert.ok(Object.isFrozen(WORKFLOWS));
});
