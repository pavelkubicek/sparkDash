/**
 * Updates feature: script fixtures through the real shell programs, the output parsers, the
 * manager's job model, the password guard and the daily scheduler. Everything that would touch
 * a unit runs through an injected fake transport; the shell tests run the assembled programs
 * against stub apt/fwupdmgr/systemctl executables on PATH.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProgram, parseKv, parseAptList, parseSim, parseFirmware, parseDashboard } from "../commands.js";
import { UpdateManager, remoteCommand, updatesUnsupportedReason } from "../UpdateManager.js";

// ─── shell fixtures ───────────────────────────────────────

const APT_LIST_FIXTURE = `Listing...
base-files/jammy-updates 14ubuntu6.3 amd64 [upgradable from: 14ubuntu6.2]
curl/jammy-security 7.81.0-1ubuntu1.16 amd64 [upgradable from: 7.81.0-1build1]
libssl3/jammy-security,jammy-updates 3.0.2-0ubuntu1.16 amd64 [upgradable from: 3.0.2-0ubuntu1.15]
python3-venv/jammy 3.10.6-1ubuntu2 amd64 [upgradable from: 3.10.6-1ubuntu1]
tzdata/jammy 2025a-0ubuntu0.22.04.1 all [upgradable from: 2024a-0ubuntu0.22.04.1]
`;

const SIM_FIXTURE = `Reading package lists...
Building dependency tree...
Reading state information...
Calculating upgrade...
The following packages will be REMOVED:
  python3-distutils python2-minimal
The following packages have been kept back:
  linux-image-generic
The following packages will be upgraded:
  curl libssl3 tzdata
3 upgraded, 0 newly installed, 2 to remove and 1 not upgraded.
Inst curl [7.81.0-1build1] (7.81.0-1ubuntu1.16 Ubuntu:22.04/jammy-security [amd64])
Inst libssl3 [3.0.2-0ubuntu1.15] (3.0.2-0ubuntu1.16 Ubuntu:22.04/jammy-security [amd64])
Inst tzdata [2024a-0ubuntu0.22.04.1] (2025a-0ubuntu0.22.04.1 Ubuntu:22.04/jammy [all])
Remv python3-distutils [3.10.6-1]
Remv python2-minimal [2.7.18-1]
Remv python2-minimal [2.7.18-1]
`;

const FW_TWO_DEVICES = JSON.stringify({
  Devices: [
    { Name: "UEFI dbx", Version: "76", VersionUpgrade: "84", UpdateState: "updatable", DeviceId: "UEFI_DBX" },
    { Name: "Goodix fingerprint", Version: "3.5", VersionUpgrade: "", UpdateState: "idle" },
    { Name: "NVIDIA GB10", Version: "1.1.0", VersionUpgrade: "1.2.0", UpdateState: "updatable" },
  ],
  Updates: [],
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-updates-"));

/** Stub executables on PATH; each reads its answer from an environment variable. */
function makeStubs(extraEnv = {}) {
  const dir = path.join(tmp, `stubs-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir);
  const stub = (name, body) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(f, 0o755);
  };
  stub("apt", 'if [ "$1" = list ]; then printf "%s\\n" "$STUB_APT_LIST"; fi; exit "${STUB_APT_RC:-0}"');
  stub("apt-get", [
    'if [ "$1" = -s ] || [ "$2" = -s ]; then printf "%s\\n" "$STUB_SIM"; exit "${STUB_SIM_RC:-0}"; fi',
    'if [ "$1" = update ]; then echo update >> "${STUB_APT_GET_LOG:-/dev/null}"; exit "${STUB_APT_UPDATE_RC:-0}"; fi',
    "exit 0",
  ].join("\n"));
  if (!extraEnv.STUB_NO_FW) {
    stub("fwupdmgr", [
      'if [ "$1" = get-updates ]; then printf "%s\\n" "$STUB_FW_JSON"; exit "${STUB_FW_RC:-0}"; fi',
      'if [ "$1" = get-devices ]; then printf "%s\\n" "$STUB_FW_DEVICES"; exit "${STUB_FW_DEVICES_RC:-0}"; fi',
      "exit 0",
    ].join("\n"));
  }
  stub("systemctl", [
    'for a in "$@"; do case $a in dgx-dashboard.service) K=1;; dgx-dashboard-admin.service) K=2;; esac; done',
    'case "$1" in',
    '  is-enabled) v=$(eval echo "\\$STUB_D${K}_ENABLED"); [ -n "$v" ] || { echo "not-found"; exit 1; }; echo "$v" ;;',
    '  is-active) v=$(eval echo "\\$STUB_D${K}_ACTIVE"); [ -n "$v" ] || { echo "inactive"; exit 3; }; echo "$v" ;;',
    '  show) v=$(eval echo "\\$STUB_D${K}_$3"); echo "${v:-}" ;;',
    '  disable|enable) echo "$1 $2 $3" >> "$STUB_SYSTEMCTL_LOG" 2>/dev/null ;;',
    "esac",
    "exit 0",
  ].join("\n"));
  stub("sudo", [
    'SS=0; for a in "$@"; do [ "$a" = -S ] && SS=1; done',
    'if [ "$SS" = 1 ]; then printf "%s\\n" "${STUB_SUDO_ERR:-sudo refused}" >&2; exit "${STUB_SUDO_RC:-1}"; fi',
    'if [ "$1" = -n ] && [ "$2" = true ]; then [ -n "${STUB_SUDO_N_ERR:-}" ] && printf "%s\\n" "$STUB_SUDO_N_ERR" >&2; exit "${STUB_SUDO_N_RC:-0}"; fi',
    'if [ "$1" = -n ]; then shift; fi',
    'exec "$@"',
  ].join("\n"));
  stub("sleep", "exit 0");
  return dir;
}

const MINIMAL_TOOLS = ["sh", "dash", "awk", "mawk", "base64", "tr", "stat", "grep", "head", "tail", "timeout", "id", "sleep", "cat", "cut", "mktemp", "sed", "env", "dirname", "sort", "wc"];
/** A PATH with only the core utilities the scripts need — so a real fwupdmgr cannot answer. */
function minimalBin(exclude = []) {
  const dir = path.join(tmp, `min-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir);
  for (const t of MINIMAL_TOOLS) {
    if (exclude.includes(t)) continue;
    for (const base of ["/usr/bin", "/bin"]) {
      const src = path.join(base, t);
      if (!fs.existsSync(path.join(dir, t)) && fs.existsSync(src)) fs.symlinkSync(src, path.join(dir, t));
    }
  }
  return dir;
}

function runShellFull(programText, extraEnv = {}) {
  const stubs = makeStubs(extraEnv);
  const PATH = extraEnv.__PATH ?? (extraEnv.STUB_NO_FW ? `${stubs}:${minimalBin()}` : `${stubs}:${process.env.PATH}`);
  return new Promise((resolve, reject) => {
    execFile(
      "/bin/sh",
      ["-c", programText],
      {
        timeout: 30_000,
        env: { PATH, HOME: process.env.HOME, LANG: "C", STUB_FW_DEVICES: '{"Devices":[]}', ...extraEnv },
        maxBuffer: 10 * 1024 * 1024,
      },
      (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve({ stdout: String(stdout), stderr: String(stderr ?? "") }))
    );
  });
}

function runShell(programText, extraEnv = {}) {
  return runShellFull(programText, extraEnv).then((r) => r.stdout);
}

test("check.sh parses apt list, the simulation, fwupd and the reboot flags", async () => {
  const out = await runShell(buildProgram("check"), {
    STUB_APT_LIST: APT_LIST_FIXTURE,
    STUB_SIM: SIM_FIXTURE,
    STUB_FW_JSON: FW_TWO_DEVICES,
    STUB_FW_RC: "0",
    STUB_FW_DEVICES: '{"Devices":[{"Name":"NVIDIA GB10","UpdateState":4}]}',
  });
  const res = parseKv(out);
  assert.equal(res.RESULT, "ok");
  assert.deepEqual(parseAptList(res.APT_B64), [
    { name: "base-files", newVersion: "14ubuntu6.3", oldVersion: "14ubuntu6.2" },
    { name: "curl", newVersion: "7.81.0-1ubuntu1.16", oldVersion: "7.81.0-1build1" },
    { name: "libssl3", newVersion: "3.0.2-0ubuntu1.16", oldVersion: "3.0.2-0ubuntu1.15" },
    { name: "python3-venv", newVersion: "3.10.6-1ubuntu2", oldVersion: "3.10.6-1ubuntu1" },
    { name: "tzdata", newVersion: "2025a-0ubuntu0.22.04.1", oldVersion: "2024a-0ubuntu0.22.04.1" },
  ]);
  assert.deepEqual(parseSim(res.SIM_B64), { upgrades: 3, kept: 1, removals: ["python3-distutils", "python2-minimal"] });
  assert.equal(res.FW_STATE, "ok");
  assert.deepEqual(parseFirmware("ok", res.FW_B64), {
    count: 2,
    devices: [
      { name: "UEFI dbx", current: "76", available: "84" },
      { name: "NVIDIA GB10", current: "1.1.0", available: "1.2.0" },
    ],
  });
  assert.equal(res.FWREBOOT, "1");
  assert.match(out, /^REBOOT=[01]$/m);
  assert.match(out, /^STAMP=\d*$/m);
});

test("check.sh: no devices and fwupd exit 2, missing fwupdmgr, reboot flag from device state", async () => {
  // The reported bug: a static needs-reboot capability flag is not a pending reboot. Only
  // UpdateState 4 (FWUPD_UPDATE_STATE_NEEDS_REBOOT) may raise FWREBOOT, never Flags alone.
  const ok2 = await runShell(buildProgram("check"), {
    STUB_APT_LIST: "Listing...\n",
    STUB_SIM: "0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.",
    STUB_FW_JSON: '{"Devices":[],"Updates":[]}',
    STUB_FW_RC: "2", // "no actions, and that is fine"
    STUB_FW_DEVICES: '{"Devices":[{"Name":"UEFI dbx","Flags":["needs-reboot"],"UpdateState":2}]}',
  });
  const r2 = parseKv(ok2);
  assert.equal(r2.RESULT, "ok");
  assert.deepEqual(parseAptList(r2.APT_B64), []);
  assert.deepEqual(parseSim(r2.SIM_B64), { upgrades: 0, kept: 0, removals: [] });
  assert.deepEqual(parseFirmware("ok", r2.FW_B64), { count: 0, devices: [] });
  assert.equal(r2.FWREBOOT, "0");

  const missing = await runShell(buildProgram("check"), {
    STUB_APT_LIST: "Listing...\n",
    STUB_SIM: "0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.",
    STUB_NO_FW: "1",
  });
  const rm = parseKv(missing);
  assert.equal(rm.FW_STATE, "missing");
  assert.ok(!("FW_B64" in rm));
  assert.ok(!("FWREBOOT" in rm), "no fwupdmgr means no reboot verdict at all");

  const err = await runShell(buildProgram("check"), {
    STUB_APT_LIST: "Listing...\n",
    STUB_SIM: "0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.",
    STUB_FW_JSON: "",
    STUB_FW_RC: "1", // a real failure, not exit 2
    STUB_FW_DEVICES_RC: "7", // a failing get-devices claims nothing, never a healthy 0
  });
  const re = parseKv(err);
  assert.equal(re.FW_STATE, "error");
  assert.ok(re.FW_ERR);
  assert.equal(re.FWREBOOT, "unknown");

  const junk = await runShell(buildProgram("check"), {
    STUB_APT_LIST: "Listing...\n",
    STUB_SIM: "0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.",
    STUB_FW_JSON: '{"Devices":[],"Updates":[]}',
    STUB_FW_RC: "2",
    STUB_FW_DEVICES: "not json", // exit 0 but no "Devices" anchor: garbage, so no verdict
  });
  assert.equal(parseKv(junk).FWREBOOT, "unknown");

  // fwupd 2.0.20 prints `"UpdateState" : 4` with spaces around the colon; both spellings count.
  const spaced = await runShell(buildProgram("check"), {
    STUB_APT_LIST: "Listing...\n",
    STUB_SIM: "0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.",
    STUB_FW_JSON: '{"Devices":[],"Updates":[]}',
    STUB_FW_RC: "2",
    STUB_FW_DEVICES: '{"Devices":[{"Name":"NVIDIA GB10","Flags":["needs-reboot"],"UpdateState" : 4}]}',
  });
  assert.equal(parseKv(spaced).FWREBOOT, "1");
});

test("refresh.sh tries apt-get update at most three times and reports honestly", async () => {
  const base = {
    STUB_APT_LIST: "Listing...\n",
    STUB_SIM: "0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.",
    STUB_FW_RC: "2",
    STUB_FW_JSON: "{}",
  };
  const log1 = path.join(tmp, `upd1-${Math.random().toString(36).slice(2)}`);
  const r1 = parseKv(await runShell(buildProgram("refresh"), { ...base, STUB_APT_UPDATE_RC: "0", STUB_APT_GET_LOG: log1 }));
  assert.equal(r1.RESULT, "ok");
  assert.equal(r1.REFRESHED, "ok");
  assert.equal(r1.REFRESH_FW, "ok");
  assert.equal(fs.readFileSync(log1, "utf8").trim().split("\n").length, 1, "one successful try, never a fourth");

  const log2 = path.join(tmp, `upd2-${Math.random().toString(36).slice(2)}`);
  const r2 = parseKv(await runShell(buildProgram("refresh"), { ...base, STUB_APT_UPDATE_RC: "100", STUB_APT_GET_LOG: log2 }));
  assert.equal(r2.RESULT, "ok", "a failed index still answers with the fresh check");
  assert.ok(r2.REFRESH_ERR && !("REFRESHED" in r2));
  assert.equal(fs.readFileSync(log2, "utf8").trim().split("\n").length, 3, "exactly three tries");
});

test("refresh.sh marks the success stamp after a successful update, never after a failed one", async () => {
  const base = {
    STUB_APT_LIST: "Listing...\n",
    STUB_SIM: "0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.",
    STUB_FW_RC: "2",
    STUB_FW_JSON: "{}",
  };
  // The stamp path is overridable so the fixture never touches the machine's real /var/lib/apt.
  const good = path.join(tmp, `stamp-ok-${Math.random().toString(36).slice(2)}`, "periodic", "update-success-stamp");
  await runShell(buildProgram("refresh"), { ...base, STUB_APT_UPDATE_RC: "0", SPARKDASH_APT_STAMP: good });
  assert.ok(fs.existsSync(good), "the check's STAMP and the UI's index age tell the truth after a dashboard refresh");
  const failed = path.join(tmp, `stamp-bad-${Math.random().toString(36).slice(2)}`, "periodic", "update-success-stamp");
  const r = parseKv(await runShell(buildProgram("refresh"), { ...base, STUB_APT_UPDATE_RC: "100", SPARKDASH_APT_STAMP: failed }));
  assert.ok(r.REFRESH_ERR);
  assert.equal(fs.existsSync(failed), false, "a failed apt run marks nothing");
});

test("the outer program is self-sufficient: sudo refusals answer with the real code, not a crash", async () => {
  const base = {
    STUB_APT_LIST: "Listing...\n",
    STUB_SIM: "0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.",
    STUB_FW_RC: "2",
    STUB_FW_JSON: "{}",
  };
  // Passwordless elevation refused: the gate's "" branch must still answer as KEY=value.
  const plain = await runShellFull(buildProgram("refresh"), { ...base, STUB_SUDO_N_RC: "1" });
  assert.match(plain.stdout, /^RESULT=error\nCODE=no-sudo\nMSG=.*\n$/);
  assert.ok(!plain.stderr.includes("not found"), `the outer shell needs fail/clean of its own: ${plain.stderr}`);

  // Typed password and sudo printing an unusable refusal: the catch-all that runs clean() and fail()
  // in the OUTER program — the exact crash the e2e caught.
  const refused = await runShellFull(buildProgram("refresh", { password: true }), {
    ...base,
    SPARKDASH_SUDO_PW: "hunter2pass",
    STUB_SUDO_ERR: "e2e is not in the sudoers file.",
    STUB_SUDO_RC: "1",
  });
  const rr = parseKv(refused.stdout);
  assert.equal(rr.RESULT, "error");
  assert.equal(rr.CODE, "no-sudo");
  assert.match(rr.MSG, /sudo refused the request: e2e is not in the sudoers file\./);
  assert.ok(!refused.stderr.includes("not found"), refused.stderr);

  // A wrong password keeps its own code.
  const wrong = await runShellFull(buildProgram("refresh", { password: true }), {
    ...base,
    SPARKDASH_SUDO_PW: "hunter2pass",
    STUB_SUDO_ERR: "Sorry, try again.",
    STUB_SUDO_RC: "1",
  });
  assert.match(wrong.stdout, /^RESULT=error\nCODE=bad-password\nMSG=.*\n$/);
  assert.ok(!wrong.stderr.includes("not found"), wrong.stderr);
});

test("the outer program reports no-sh itself when the unit has no shell on PATH", async () => {
  const out = await runShellFull(buildProgram("check"), {
    STUB_APT_LIST: "Listing...\n",
    __PATH: `${makeStubs({})}:${minimalBin(["sh"])}`,
  });
  const r = parseKv(out.stdout);
  assert.equal(r.RESULT, "error");
  assert.equal(r.CODE, "no-sh");
  assert.ok(!out.stderr.includes("not found"), out.stderr);
});

test("check.sh answers even when the simulation and apt list fail", async () => {
  const out = await runShell(buildProgram("check"), {
    STUB_APT_LIST: "",
    STUB_APT_RC: "100",
    STUB_SIM: "",
    STUB_SIM_RC: "100",
    STUB_FW_RC: "2",
    STUB_FW_JSON: "{}",
  });
  const res = parseKv(out);
  assert.equal(res.RESULT, "ok");
  assert.ok(res.APT_ERR && !("APT_B64" in res), "a failed apt list is an APT_ERR, never an empty list");
  assert.ok(res.SIM_ERR && !("SIM_B64" in res));
});

test("dashboard.sh status answers with both units from systemctl", async () => {
  const out = await runShell(buildProgram("dashboard", { args: ["status"] }), {
    STUB_D1_ENABLED: "enabled",
    STUB_D1_ACTIVE: "active",
    STUB_D1_MemoryCurrent: "58720256",
    STUB_D1_MainPID: "414243",
    STUB_D2_ENABLED: "disabled",
    STUB_D2_ACTIVE: "",
    STUB_D2_MemoryCurrent: "",
    STUB_D2_MainPID: "0",
  });
  const res = parseKv(out);
  assert.equal(res.RESULT, "ok");
  assert.deepEqual(parseDashboard(res), [
    { unit: "dgx-dashboard.service", enabled: "enabled", active: "active", memoryBytes: 58720256, mainPid: 414243 },
    { unit: "dgx-dashboard-admin.service", enabled: "disabled", active: "inactive", memoryBytes: null, mainPid: 0 },
  ]);
});

test("dashboard.sh on/off refuses without root and reports what it did", async () => {
  const out = await runShell(buildProgram("dashboard", { args: ["off"], elevate: false, password: false }), {
    STUB_D1_ENABLED: "disabled",
    STUB_D2_ENABLED: "disabled",
  });
  // The dev machine is not root for the unprivileged build; either it refuses or (running as
  // root in a container) it applies — both answers carry the state.
  const res = parseKv(out);
  assert.ok(res.RESULT === "ok" || res.CODE === "no-sudo");
});

// ─── password transport ───────────────────────────────────

test("the password never rides in the program text or the ssh command line", () => {
  const program = buildProgram("install", { password: true });
  assert.ok(program.includes("SPARKDASH_SUDO_PW"), "the password arrives via the runner's stdin, into the env");
  assert.ok(program.includes("sudo -S -p ''"));
  const remote = remoteCommand(program, false);
  assert.ok(remote.includes("base64 -d | sh"));
  assert.ok(!program.toLowerCase().includes("hunter2"));
});

// ─── the unit gate ────────────────────────────────────────

test("updatesUnsupportedReason admits the dashboard's own machine and refuses the rest", () => {
  assert.equal(updatesUnsupportedReason({ id: "l", kind: "host", isLocal: true, platform: "linux" }), null, "the local Linux host is an apt machine like any Spark");
  // The Linux gate is untouched: even a local unit on another OS stays refused.
  assert.match(updatesUnsupportedReason({ id: "l", kind: "host", isLocal: true, platform: "windows" }), /Linux Spark units/);
  assert.match(updatesUnsupportedReason({ id: "h", kind: "host", platform: "linux" }), /only supported on Spark units/, "a remote host keeps the refusal");
  assert.match(updatesUnsupportedReason({ id: "m", kind: "mac", platform: "darwin" }), /only supported on Spark units/);
  assert.equal(updatesUnsupportedReason({ id: "s", kind: "spark", platform: "linux" }), null);
});

// ─── manager with a fake transport ────────────────────────

const spark = (id, extra = {}) => ({ id, name: id, kind: "spark", platform: "linux", ssh: { user: "u", host: `${id}.lan`, port: 22 }, ...extra });

const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");

function checkLines({ apt = [], sim = { upgrades: 0, kept: 0, removals: [] }, fw = { count: 0, devices: [] }, fwState = "ok", reboot = "0", fwReboot = "unknown", stamp = "" } = {}) {
  return [
    `APT_B64=${b64(apt)}`,
    `SIM_B64=${b64(sim)}`,
    `FW_STATE=${fwState}`,
    fwState === "ok" ? `FW_B64=${b64(fw)}` : "",
    `FWREBOOT=${fwReboot}`,
    `REBOOT=${reboot}`,
    `STAMP=${stamp}`,
    "RESULT=ok",
  ]
    .filter(Boolean)
    .join("\n");
}

function makeManager({ run, sparks = [spark("s1")], online = () => true, settings = () => ({ updatesAutoCheck: true }) } = {}) {
  let clock = 1_700_000_000_000;
  const m = new UpdateManager({
    run:
      run ??
      (async () => checkLines({ apt: [{ name: "curl", newVersion: "2.0", oldVersion: "1.0" }], sim: { upgrades: 1, kept: 0, removals: [] }, fw: { count: 1, devices: [{ name: "UEFI dbx", current: "1", available: "2" }] } })),
    now: () => clock,
    listSparks: () => sparks,
    isOnline: online,
    getSettings: settings,
  });
  m.setClock = (t) => (clock = t);
  return m;
}

test("check fills the detail shape exactly as the contract lists it", async () => {
  const m = makeManager();
  const d = await m.check(spark("s1"));
  assert.deepEqual(Object.keys(d).sort(), [
    "apt",
    "checkedAt",
    "firmware",
    "firmwareRebootNeeded",
    "index",
    "indexAutoRefresh",
    "lastError",
    "now",
    "rebootRequired",
    "sim",
    "sparkId",
    "state",
  ]);
  assert.equal(d.state, "ok");
  assert.equal(d.sparkId, "s1");
  assert.equal(d.apt[0].name, "curl");
  assert.equal(d.sim.upgrades, 1);
  assert.equal(d.firmware.count, 1);
  assert.equal(d.index.refreshedAt, null);
  assert.equal(d.lastError, null);
  const s = m.summary();
  assert.equal(s.sparks[0].aptCount, 1);
  assert.equal(s.sparks[0].fwCount, 1);
  assert.equal(s.anyUpgradable, true);
  assert.equal(s.sparks[0].checkedAt, 1_700_000_000_000);
});

test("a failed part keeps the previous value and sets lastError, never a healthy guess", async () => {
  let out = checkLines({ apt: [{ name: "curl", newVersion: "2.0", oldVersion: "1.0" }], sim: { upgrades: 1, kept: 0, removals: ["oldpkg"] } });
  const m = makeManager({ run: async () => out });
  await m.check(spark("s1"));
  out = ["APT_B64=" + b64([]), "SIM_ERR=apt-get -s exited 100", "FW_STATE=missing", "REBOOT=0", "STAMP=", "RESULT=ok"].join("\n");
  const d = await m.check(spark("s1"));
  assert.deepEqual(d.sim, { upgrades: 1, kept: 0, removals: ["oldpkg"] }, "the failed simulation keeps its previous removals");
  assert.equal(d.apt.length, 0);
  assert.equal(d.state, "ok");
  assert.match(d.lastError, /exited 100/);
  assert.equal(d.firmware.devices, null);
});

test("the stamp path feeds index.refreshedAt and transport errors carry a code", async () => {
  const m = makeManager({ run: async () => checkLines({ stamp: "1700000000" }) });
  const d = await m.check(spark("s1"));
  assert.equal(d.index.refreshedAt, 1700000000 * 1000);
  const bad = makeManager({
    run: async () => {
      throw new Error("SSH to s1.lan:22 failed: connect timed out");
    },
  });
  await assert.rejects(bad.check(spark("s1")), (e) => e.code === "timeout" && e.status === 502);
  assert.equal(bad.detail(spark("s1")).state, "error");
  assert.match(bad.detail(spark("s1")).lastError, /timed out/);
});

test("a refresh on a rejecting transport sets error + lastError; a later check clears it", async () => {
  let fail = true;
  const m = makeManager({
    run: async () => {
      if (fail) throw new Error("SSH to s1.lan:22 failed: connect timed out");
      return checkLines({});
    },
  });
  await assert.rejects(m.refresh(spark("s1"), { sudoPassword: "hunter2long" }), (e) => e.status === 502);
  const d = m.detail(spark("s1"));
  assert.equal(d.state, "error");
  assert.match(d.lastError, /timed out/);
  assert.ok(!d.lastError.includes("hunter2long"), "the password never leaks into lastError");
  fail = false;
  const d2 = await m.check(spark("s1"));
  assert.equal(d2.state, "ok");
  assert.equal(d2.lastError, null);
});

test("install is gated by the simulation's removals until confirmed", async () => {
  const calls = [];
  const m = makeManager({
    run: async (s, program, opts) => {
      calls.push({ program, input: opts?.input });
      if (program.includes("sparkdash-updates:install")) return "STEP=apt\nLAST=curl\nSTEP=firmware\nFWUP=none\n" + checkLines({});
      return checkLines({ sim: { upgrades: 2, kept: 0, removals: ["python2-minimal"] } });
    },
  });
  const s1 = spark("s1");
  await m.check(s1);
  await assert.rejects(
    async () => m.install(s1, { sudoPassword: "hunter2long" }),
    (e) => e.status === 409 && e.code === "needs_confirmation" && e.removals.length === 1
  );
  const { jobId } = m.install(s1, { sudoPassword: "hunter2long", confirmRemovals: true });
  await m.settled();
  const { job } = m.job(s1);
  assert.equal(job.id, jobId);
  assert.equal(job.state, "done");
  assert.deepEqual(
    job.phases.map((p) => [p.key, p.state]),
    [
      ["apt", "done"],
      ["firmware", "done"],
    ]
  );
  assert.equal(job.phases[0].note, "last: curl");
  assert.equal(job.phases[1].note, "nothing to upgrade");
  assert.equal(m.isBusy("s1"), false);
  const installCall = calls[calls.length - 1];
  assert.equal(installCall.input, "hunter2long", "the password travels on the transport's stdin option");
  assert.ok(!installCall.program.includes("hunter2long"), "and never in the program text");
});

test("a refused password marks the job and locks further guesses", async () => {
  let n = 0;
  const m = makeManager({
    run: async (s, program) => {
      if (!program.includes("sparkdash-updates:install")) return checkLines({});
      n += 1;
      return "RESULT=error\nCODE=bad-password\nMSG=The sudo password was not accepted\n";
    },
  });
  const s1 = spark("s1");
  await m.check(s1);
  for (let i = 0; i < 3; i += 1) {
    m.install(s1, { sudoPassword: "wrong-guess" });
    await m.settled();
    const { job } = m.job(s1);
    assert.equal(job.state, "error");
    assert.equal(job.code, "bad-password");
  }
  await assert.rejects(async () => m.install(s1, { sudoPassword: "wrong-guess", confirmRemovals: true }), (e) => e.status === 429 && e.code === "password-locked");
  assert.equal(n, 3, "the lock refuses before the transport is even used");
});

test("install-all walks the fleet: offline, busy, unconfirmed removals and work", async () => {
  const units = [spark("a"), spark("b"), spark("c"), spark("d")];
  const running = new Set();
  let maxConcurrent = 0;
  const m = new UpdateManager({
    run: async (s, program, opts) => {
      running.add(s.id);
      maxConcurrent = Math.max(maxConcurrent, running.size);
      await new Promise((r) => setTimeout(r, 5));
      running.delete(s.id);
      if (program.includes("sparkdash-updates:install")) return "STEP=apt\nLAST=pkg\nSTEP=firmware\nFWUP=done\n" + checkLines({});
      if (s.id === "c") return checkLines({ sim: { upgrades: 1, kept: 0, removals: ["conflicting-lib"] } });
      return checkLines({ apt: [{ name: "x", newVersion: "2", oldVersion: "1" }] });
    },
    now: () => 5,
    listSparks: () => units,
    isOnline: (id) => id !== "b",
    getSettings: () => ({}),
  });
  await m.check(spark("a"));
  await m.check(spark("c"));
  m._busy.add("d"); // a per-unit job already holds d: the fleet must skip it, not queue behind it
  const { jobId } = m.installAll({ sudoPassword: "secret-pw" });
  while (m.fleetJob().job?.state !== "done") await new Promise((r) => setTimeout(r, 5));
  m._busy.delete("d");
  const { job } = m.fleetJob();
  assert.equal(job.id, jobId);
  assert.equal(job.state, "done");
  assert.deepEqual(
    job.units.map((u) => [u.sparkId, u.state]),
    [
      ["a", "done"],
      ["b", "skipped-offline"],
      ["c", "needs_confirmation"],
      ["d", "skipped-busy"],
    ]
  );
  assert.deepEqual(job.units[2].removals, ["conflicting-lib"]);
  assert.equal(maxConcurrent, 1, "units run one at a time");
  assert.equal(job.now, 5);
});

test("the fleet job answers null before it has ever run", () => {
  const m = makeManager();
  assert.deepEqual(m.fleetJob(), { job: null });
  assert.deepEqual(m.job(spark("s1")), { job: null });
});

// ─── dashboard services through the manager ───────────────

test("dashboard service toggle returns the GET shape after applying", async () => {
  const seen = [];
  const answer = ["RESULT=ok", "D1_UNIT=dgx-dashboard.service", "D1_ENABLED=disabled", "D1_ACTIVE=inactive", "D1_MEM=", "D1_PID=0", "D2_UNIT=dgx-dashboard-admin.service", "D2_ENABLED=disabled", "D2_ACTIVE=inactive", "D2_MEM=", "D2_PID=0"].join("\n");
  const m = makeManager({
    run: async (s, program, opts) => {
      seen.push({ program, input: opts?.input });
      return answer;
    },
  });
  const out = await m.setDashboardService(spark("s1"), { enabled: false, sudoPassword: "hunter2secret" });
  assert.deepEqual(out.units, [
    { unit: "dgx-dashboard.service", enabled: "disabled", active: "inactive", memoryBytes: null, mainPid: 0 },
    { unit: "dgx-dashboard-admin.service", enabled: "disabled", active: "inactive", memoryBytes: null, mainPid: 0 },
  ]);
  assert.equal(seen[0].input, "hunter2secret");
  assert.ok(!seen[0].program.includes("hunter2secret"));
  assert.ok(seen[0].program.includes("systemctl disable --now") === false, "the loop lives in the base64'd body, not in the clear");
  const decoded = Buffer.from(seen[0].program.match(/BODY=\$\(dec '([^']+)'\)/)[1], "base64").toString("utf8");
  assert.match(decoded, /systemctl disable --now/);
  await assert.rejects(() => m.setDashboardService(spark("s1"), { enabled: "yes" }), (e) => e.status === 400);
});

// ─── daily auto-check ─────────────────────────────────────

const prague = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
/** ms of a Prague wall-clock instant, computed through Intl so the test itself is time-zone correct. */
function atPrague(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  for (const off of [0, 60, 120]) {
    const t = guess - off * 60_000;
    const p = {};
    for (const { type, value } of prague.formatToParts(new Date(t))) p[type] = value;
    if (Number(p.year) === y && Number(p.month) === mo && Number(p.day) === d && Number(p.hour) === h && Number(p.minute) === mi) return t;
  }
  throw new Error(`no such Prague time ${y}-${mo}-${d} ${h}:${mi}`);
}

test("the daily check: jittered slot, once per local day, catch-up for offline units, gated off", async () => {
  const checked = [];
  let online = { a: true, b: false };
  const settings = { updatesAutoCheck: true };
  const m = new UpdateManager({
    run: async (s) => {
      checked.push(s.id);
      return checkLines({});
    },
    now: () => Date.now(),
    listSparks: () => [spark("a"), spark("b")],
    isOnline: (id) => online[id],
    getSettings: () => settings,
  });
  const day = "2026-11-16";
  const t0 = atPrague(2026, 11, 16, 0, 30); // midnight-ish local; day key comes out 2026-11-16
  assert.equal(m._localTime(t0).dayKey, day);

  // Before the whole window: nothing runs.
  assert.equal(await m.runTick(t0), 0);
  // a's jittered slot not yet reached → nothing; run minute by minute until 09:00.
  let started = 0;
  for (let mi = 0; mi < 540; mi += 1) started = await m.runTick(atPrague(2026, 11, 16, 6 + Math.floor(mi / 60), mi % 60));
  assert.ok(checked.includes("a"), "the online unit was auto-checked somewhere in 06:00–09:00");
  assert.ok(!checked.includes("b"), "the offline unit was not checked");
  assert.ok(started <= 1);
  // Once per day: a later tick the same day does nothing.
  assert.equal(await m.runTick(atPrague(2026, 11, 16, 22, 0)), 0);
  // b came online after its slot: the next tick that finds it online checks it (same-day catch-up).
  online.b = true;
  assert.equal(await m.runTick(atPrague(2026, 11, 16, 22, 1)), 1);
  assert.ok(checked.includes("b"));
  // Next local day: both eligible again.
  assert.equal(await m.runTick(atPrague(2026, 11, 17, 5, 59)), 0, "before 06:00 local still nothing");
  for (let mi = 0; mi < 180; mi += 1) await m.runTick(atPrague(2026, 11, 17, 6 + Math.floor(mi / 60), mi % 60));
  assert.equal(checked.filter((x) => x === "a").length, 2);
  // Gated by the settings flag.
  settings.updatesAutoCheck = false;
  assert.equal(await m.runTick(atPrague(2026, 11, 18, 9, 0)), 0);
});

test("the jitter is stable for a unit-day and spread across the fleet", () => {
  const m = makeManager();
  const first = m._jitter("spark-1", "2026-11-16");
  assert.equal(m._jitter("spark-1", "2026-11-16"), first);
  assert.ok(first >= 0 && first < 180);
  const spread = new Set();
  for (let i = 0; i < 40; i += 1) spread.add(m._jitter(`unit-${i}`, "2026-11-16"));
  assert.ok(spread.size > 20, "different units get different slots");
});

test("start/stop arm and clear an unref'd minute timer", () => {
  const m = makeManager();
  m.start();
  assert.ok(m._timer);
  m.start(); // idempotent
  m.stop();
  assert.equal(m._timer, null);
});

test("install never runs blind: a never-checked unit answers needs-check, per unit and in the fleet", async () => {
  const units = [spark("u1"), spark("u2")];
  const m = new UpdateManager({
    run: async () => checkLines({}),
    now: () => 9,
    listSparks: () => units,
    isOnline: () => true,
    getSettings: () => ({}),
  });
  await assert.rejects(async () => m.install(spark("u1"), {}), (e) => e.status === 409 && e.code === "needs-check");
  m.installAll({});
  while (m.fleetJob().job?.state !== "done") await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(
    m.fleetJob().job.units.map((u) => [u.sparkId, u.state, u.code]),
    [
      ["u1", "error", "needs-check"],
      ["u2", "error", "needs-check"],
    ]
  );
});

test("a running check holds the unit: install and refresh answer unit-busy until it finishes", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const m = makeManager({
    run: async (s, program) => {
      if (program.includes("sparkdash-updates:check")) await gate;
      return checkLines({});
    },
  });
  const s1 = spark("s1");
  const inFlight = m.check(s1);
  inFlight.catch(() => {});
  assert.equal(m.isBusy("s1"), true);
  await assert.rejects(async () => m.install(s1, { sudoPassword: "some-password", confirmRemovals: true }), (e) => e.status === 409 && e.code === "unit-busy");
  await assert.rejects(() => m.refresh(s1, { sudoPassword: "some-password" }), (e) => e.status === 409 && e.code === "unit-busy");
  release();
  const d = await inFlight;
  assert.equal(d.state, "ok");
  assert.equal(m.isBusy("s1"), false);
});

test("install while the fleet loop has claimed the unit is unit-busy", async () => {
  const units = [spark("f1"), spark("f2")];
  let release;
  const gate = new Promise((r) => (release = r));
  const m = new UpdateManager({
    run: async (s, program) => {
      if (program.includes("sparkdash-updates:install")) {
        await gate;
        return "STEP=apt\nLAST=x\nSTEP=firmware\nFWUP=none\n" + checkLines({});
      }
      return checkLines({});
    },
    now: () => 7,
    listSparks: () => units,
    isOnline: () => true,
    getSettings: () => ({}),
  });
  await m.check(spark("f1"));
  await m.check(spark("f2"));
  m.installAll({});
  while (!m.fleetJob().job?.units.some((u) => u.sparkId === "f1" && u.state === "running")) await new Promise((r) => setTimeout(r, 2));
  await assert.rejects(async () => m.install(spark("f2"), {}), (e) => e.status === 409 && e.code === "unit-busy");
  release();
  while (m.fleetJob().job?.state !== "done") await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(m.fleetJob().job.units.map((u) => u.state), ["done", "done"]);
});

test("the fleet reports a locked sudo account without touching the transport", async () => {
  // Same machine behind both entries → one guard key, shared as the guard is designed to be.
  const same = { user: "u", host: "same.lan", port: 22 };
  const units = [spark("x1", { ssh: same }), spark("x2", { ssh: same })];
  let installCalls = 0;
  const m = new UpdateManager({
    run: async (s, program) => {
      if (program.includes("sparkdash-updates:install")) installCalls += 1;
      return checkLines({});
    },
    now: () => 4,
    listSparks: () => units,
    isOnline: () => true,
    getSettings: () => ({}),
  });
  await m.check(spark("x1"));
  await m.check(spark("x2"));
  for (let i = 0; i < 3; i += 1) m._pwGuard.note(units[0], true);
  m.installAll({ sudoPassword: "irrelevant-now" });
  while (m.fleetJob().job?.state !== "done") await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(m.fleetJob().job.units.map((u) => [u.state, u.code]), [
    ["error", "password-locked"],
    ["error", "password-locked"],
  ]);
  assert.equal(installCalls, 0, "the locked account never reaches the unit");
});

test("summary flags are plain booleans while the detail keeps its tri-state", async () => {
  const m = makeManager({ run: async () => checkLines({ fwReboot: "unknown", reboot: "0" }) });
  await m.check(spark("s1"));
  const s = m.summary().sparks[0];
  assert.equal(typeof s.rebootRequired, "boolean");
  assert.equal(typeof s.firmwareRebootNeeded, "boolean");
  assert.equal(s.firmwareRebootNeeded, false);
  assert.equal(m.detail(spark("s1")).firmwareRebootNeeded, null);
});

test("the scheduler skips a busy unit without burning its day and checks it once free", async () => {
  const checked = [];
  const m = new UpdateManager({
    run: async (s) => {
      checked.push(s.id);
      return checkLines({});
    },
    now: () => Date.now(),
    listSparks: () => [spark("a")],
    isOnline: () => true,
    getSettings: () => ({ updatesAutoCheck: true }),
  });
  const late = atPrague(2026, 11, 20, 12, 0); // well past any jittered slot
  m._busy.add("a");
  assert.equal(await m.runTick(late), 0);
  m._busy.delete("a");
  assert.equal(await m.runTick(late), 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(checked, ["a"], "the busy tick did not spend the day's check");
});

// ─── daily auto index refresh (shared sudo vault) ────────

/** A vault stand-in with the SudoVault surface, recording the calls (no files in these tests). */
function fakeVault(entries = {}) {
  const map = new Map(Object.entries(entries));
  const calls = { set: [], delete: [] };
  return {
    calls,
    has: (key) => map.has(key),
    get: (key) => map.get(key) ?? null,
    set: (key, pw) => {
      map.set(key, pw);
      calls.set.push([key, pw]);
    },
    delete: (key) => {
      const had = map.delete(key);
      calls.delete.push(key);
      return had;
    },
  };
}

/** A manager on the daily-scheduler rails: records every transport call, vault injectable. */
function refreshManager({ vault, settings = { updatesAutoCheck: true, updatesAutoRefresh: true }, run, online = () => true, units = [spark("a")] } = {}) {
  const calls = [];
  const m = new UpdateManager({
    run:
      run ??
      (async (s, program, opts) => {
        calls.push({ id: s.id, program, input: opts?.input });
        if (program.includes("sparkdash-updates:refresh")) return "REFRESHED=ok\n" + checkLines({ stamp: "1700000000" });
        return checkLines({});
      }),
    now: () => Date.now(),
    listSparks: () => units,
    isOnline: online,
    getSettings: () => settings,
    vault,
  });
  return { m, calls };
}

const PAST_THE_SLOT = () => atPrague(2026, 11, 20, 12, 0); // well past any jittered slot

test("the daily slot refreshes with the remembered password, check and all", async () => {
  const vault = fakeVault({ "u@a.lan:22": "stored-hunter" });
  const { m, calls } = refreshManager({ vault });
  assert.equal(await m.runTick(PAST_THE_SLOT()), 1);
  await m.settled();
  assert.equal(calls.length, 1, "the refresh program carries the check: no second run");
  assert.equal(calls[0].input, "stored-hunter", "the remembered password is the one sent");
  assert.ok(calls[0].program.includes("sparkdash-updates:refresh"));
  const decoded = Buffer.from(calls[0].program.match(/BODY=\$\(dec '([^']+)'\)/)[1], "base64").toString("utf8");
  assert.match(decoded, /apt-get update/, "the refresh body runs");
  assert.match(decoded, /apt list --upgradable/, "and the check body rides along for the fresh state");
  assert.equal(m.detail(spark("a")).indexAutoRefresh, "stored-password");
  assert.equal(m.detail(spark("a")).index.refreshedAt, 1700000000 * 1000, "the refresh answered with its own fresh state");
});

test("a remembered password the unit stops accepting is dropped; the day still gets its check", async () => {
  const vault = fakeVault({ "u@a.lan:22": "stale-pw" });
  const { m, calls } = refreshManager({
    vault,
    run: async (s, program, opts) => {
      calls.push({ id: s.id, program, input: opts?.input });
      if (program.includes("sparkdash-updates:refresh")) return "RESULT=error\nCODE=bad-password\nMSG=The sudo password was not accepted\n";
      return checkLines({});
    },
  });
  assert.equal(await m.runTick(PAST_THE_SLOT()), 1);
  await m.settled();
  assert.deepEqual(vault.calls.delete, ["u@a.lan:22"], "the stale entry is dropped");
  assert.equal(calls.length, 2);
  assert.ok(calls[0].program.includes("sparkdash-updates:refresh"));
  assert.ok(calls[1].program.includes("sparkdash-updates:check"), "the sudo-free fallback ran: the day has data");
  assert.equal(calls[1].input ?? null, null, "the fallback carries no password");
  assert.equal(m.detail(spark("a")).state, "ok");
  assert.equal(m._pwGuard._fails.get("u@a.lan:22").n, 1, "the one wrong guess counts against the guard exactly once");
});

test("no stored password, the setting off, or a locked account keep the day sudo-free", async () => {
  for (const scenario of [
    { name: "no stored password", vault: fakeVault(), settings: { updatesAutoCheck: true, updatesAutoRefresh: true } },
    { name: "auto-refresh off", vault: fakeVault({ "u@a.lan:22": "stored" }), settings: { updatesAutoCheck: true, updatesAutoRefresh: false } },
    { name: "auto-refresh not a real true", vault: fakeVault({ "u@a.lan:22": "stored" }), settings: { updatesAutoCheck: true, updatesAutoRefresh: "yes" } },
  ]) {
    const { m, calls } = refreshManager({ vault: scenario.vault, settings: scenario.settings });
    assert.equal(await m.runTick(PAST_THE_SLOT()), 1, scenario.name);
    await m.settled();
    assert.equal(calls.length, 1, scenario.name);
    assert.ok(calls[0].program.includes("sparkdash-updates:check"), scenario.name);
    assert.equal(calls[0].input ?? null, null, scenario.name);
  }
  // A locked sudo account: the check runs, the stored password is left where it is.
  const vault = fakeVault({ "u@a.lan:22": "stored" });
  const { m, calls } = refreshManager({ vault });
  for (let i = 0; i < 3; i += 1) m._pwGuard.note(spark("a"), true);
  assert.equal(await m.runTick(PAST_THE_SLOT()), 1);
  await m.settled();
  assert.ok(calls.every((c) => c.program.includes("sparkdash-updates:check")), "the locked account never reaches the unit with a password");
  assert.deepEqual(vault.calls.delete, []);
  assert.deepEqual(vault.calls.set, []);
});

test("the auto-refresh leaves offline and busy units alone", async () => {
  const vault = fakeVault({ "u@a.lan:22": "stored", "u@b.lan:22": "stored" });
  const { m, calls } = refreshManager({ vault, units: [spark("a"), spark("b")], online: (id) => id !== "b" });
  assert.equal(await m.runTick(PAST_THE_SLOT()), 1);
  await m.settled();
  assert.deepEqual(calls.map((c) => c.id), ["a"], "the offline unit waits for its catch-up tick");
  // A busy unit: skipped in silence, its day not spent.
  const busy = refreshManager({ vault: fakeVault({ "u@a.lan:22": "stored" }) });
  busy.m._busy.add("a");
  assert.equal(await busy.m.runTick(PAST_THE_SLOT()), 0);
  busy.m._busy.delete("a");
  assert.equal(await busy.m.runTick(PAST_THE_SLOT()), 1, "free by the next tick: the day is still its own");
  await busy.m.settled();
  assert.equal(busy.calls.length, 1);
  assert.ok(busy.calls[0].program.includes("sparkdash-updates:refresh"));
});

test("a tick in flight blocks the next minute tick from stacking", async () => {
  const { m, calls } = refreshManager({ vault: fakeVault() });
  m._ticking = true; // the minute timer firing while a slow previous tick is still at work
  assert.equal(await m.runTick(PAST_THE_SLOT()), 0);
  assert.equal(calls.length, 0);
  m._ticking = false;
  assert.equal(await m.runTick(PAST_THE_SLOT()), 1);
  await m.settled();
});

// ─── remember and the fleet refresh ───────────────────────

test("remember stores only when sudo accepted the password", async () => {
  const mk = (run) => {
    const vault = fakeVault();
    const m = new UpdateManager({ run, now: () => 5, listSparks: () => [spark("s1")], isOnline: () => true, getSettings: () => ({}), vault });
    return { m, vault };
  };
  const ok = mk(async () => "REFRESHED=ok\n" + checkLines({}));
  await ok.m.refresh(spark("s1"), { sudoPassword: "hunter2long", remember: true });
  assert.deepEqual(ok.vault.calls.set, [["u@s1.lan:22", "hunter2long"]]);

  const noAsk = mk(async () => "REFRESHED=ok\n" + checkLines({}));
  await noAsk.m.refresh(spark("s1"), { sudoPassword: "hunter2long" });
  assert.deepEqual(noAsk.vault.calls.set, [], "without the ask, nothing is kept");

  const bad = mk(async () => "RESULT=error\nCODE=bad-password\nMSG=The sudo password was not accepted\n");
  await assert.rejects(bad.m.refresh(spark("s1"), { sudoPassword: "wrong-guess", remember: true }), (e) => e.status === 403);
  assert.deepEqual(bad.vault.calls.set, [], "a refused password is never stored");

  const unreachable = mk(async () => {
    throw new Error("SSH to s1.lan:22 failed");
  });
  await assert.rejects(unreachable.m.refresh(spark("s1"), { sudoPassword: "hunter2long", remember: true }), (e) => e.status === 502);
  assert.deepEqual(unreachable.vault.calls.set, [], "no answer proves nothing");

  // Sudo said yes and apt failed afterwards: the password is worth keeping, the failure still speaks.
  const aptFailed = mk(async () => "REFRESH_ERR=apt-get update failed after 3 tries\n" + checkLines({}));
  await assert.rejects(aptFailed.m.refresh(spark("s1"), { sudoPassword: "hunter2long", remember: true }), (e) => e.code === "apt-update-failed");
  assert.deepEqual(aptFailed.vault.calls.set, [["u@s1.lan:22", "hunter2long"]], "sudo's yes counts, apt's no does not");

  // A vault that cannot write must never fail the refresh itself.
  const throwing = mk(async () => "REFRESHED=ok\n" + checkLines({}));
  throwing.vault.set = () => {
    throw new Error("disk full");
  };
  const orig = console.error;
  console.error = () => {};
  try {
    assert.equal((await throwing.m.refresh(spark("s1"), { sudoPassword: "hunter2long", remember: true })).state, "ok");
  } finally {
    console.error = orig;
  }
});

test("refresh-all walks the fleet with installAll's outcome semantics, in refresh mode", async () => {
  const units = [spark("a"), spark("b"), spark("c"), spark("d")];
  const running = new Set();
  let maxConcurrent = 0;
  const vault = fakeVault();
  const m = new UpdateManager({
    run: async (s, program) => {
      running.add(s.id);
      maxConcurrent = Math.max(maxConcurrent, running.size);
      await new Promise((r) => setTimeout(r, 5));
      running.delete(s.id);
      if (!program.includes("sparkdash-updates:refresh")) return checkLines({});
      if (s.id === "a") return "RESULT=error\nCODE=bad-password\nMSG=The sudo password was not accepted\n";
      if (s.id === "c") return "REFRESH_ERR=apt-get update failed after 3 tries\n" + checkLines({});
      return "REFRESHED=ok\n" + checkLines({});
    },
    now: () => 5,
    listSparks: () => units,
    isOnline: (id) => id !== "b",
    getSettings: () => ({}),
    vault,
  });
  m._busy.add("d"); // a per-unit job already holds d: the fleet must skip it, not queue behind it
  const { jobId } = m.refreshAll({ sudoPassword: "secret-pw", remember: true });
  while (m.fleetJob().job?.state !== "done") await new Promise((r) => setTimeout(r, 5));
  m._busy.delete("d");
  const { job } = m.fleetJob();
  assert.equal(job.id, jobId);
  assert.equal(job.mode, "refresh");
  assert.equal(job.state, "done");
  assert.deepEqual(
    job.units.map((u) => [u.sparkId, u.state, u.code ?? null]),
    [
      ["a", "error", "bad-password"],
      ["b", "skipped-offline", null],
      ["c", "error", "apt-update-failed"],
      ["d", "skipped-busy", null],
    ]
  );
  assert.equal(job.units.find((u) => u.sparkId === "c").error, "apt-get update failed after 3 tries");
  assert.equal(maxConcurrent, 1, "units run one at a time");
  assert.deepEqual(vault.calls.set, [["u@c.lan:22", "secret-pw"]], "only the sudo-accepted unit gets remembered");
  assert.ok(!JSON.stringify(job).includes("secret-pw"), "the job never echoes the password");
});

test("the fleet job is shared: install-all and refresh-all refuse each other until done", async () => {
  const units = [spark("f1"), spark("f2")];
  let release;
  const gate = new Promise((r) => (release = r));
  const m = new UpdateManager({
    run: async (s, program) => {
      if (program.includes("sparkdash-updates:install") || program.includes("sparkdash-updates:refresh")) await gate;
      return "STEP=apt\nLAST=x\nSTEP=firmware\nFWUP=none\n" + checkLines({});
    },
    now: () => 7,
    listSparks: () => units,
    isOnline: () => true,
    getSettings: () => ({}),
  });
  await m.check(spark("f1"));
  await m.check(spark("f2"));
  m.refreshAll({ sudoPassword: "pw" });
  assert.throws(() => m.installAll({ sudoPassword: "pw" }), (e) => e.status === 409 && e.code === "already-running");
  release();
  while (m.fleetJob().job?.state !== "done") await new Promise((r) => setTimeout(r, 5));
  m.installAll({ sudoPassword: "pw" });
  assert.throws(() => m.refreshAll({ sudoPassword: "pw" }), (e) => e.status === 409 && e.code === "already-running");
  while (m.fleetJob().job?.state !== "done") await new Promise((r) => setTimeout(r, 5));
});
