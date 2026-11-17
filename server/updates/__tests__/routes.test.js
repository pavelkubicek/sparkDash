/**
 * The /api/updates routes on an express app with a fake transport — same harness as the storage
 * route tests. Settings are pinned to a temp file (the settings-apikeys pattern) so nothing here
 * ever reads or writes the real config.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sparkdash-updates-routes-"));
process.env.SETTINGS_JSON_PATH = path.join(root, "settings.json");

import express from "express";
import { registerUpdatesRoutes } from "../routes.js";
import { UpdateManager } from "../UpdateManager.js";

const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");

const CHECK_OK = [
  `APT_B64=${b64([{ name: "curl", newVersion: "8", oldVersion: "7" }])}`,
  `SIM_B64=${b64({ upgrades: 1, kept: 0, removals: [] })}`,
  "FW_STATE=ok",
  `FW_B64=${b64({ count: 0, devices: [] })}`,
  "FWREBOOT=0",
  "REBOOT=0",
  "STAMP=",
  "RESULT=ok",
].join("\n");

const CHECK_WITH_REMOVALS = [
  `APT_B64=${b64([{ name: "curl", newVersion: "8", oldVersion: "7" }])}`,
  `SIM_B64=${b64({ upgrades: 2, kept: 0, removals: ["python2-minimal", "old-libs"] })}`,
  "FW_STATE=ok",
  `FW_B64=${b64({ count: 1, devices: [{ name: "UEFI dbx", current: "1", available: "2" }] })}`,
  "FWREBOOT=unknown",
  "REBOOT=1",
  "STAMP=1700000000",
  "RESULT=ok",
].join("\n");

const DASH_OFF = [
  "D1_UNIT=dgx-dashboard.service",
  "D1_ENABLED=disabled",
  "D1_ACTIVE=inactive",
  "D1_MEM=",
  "D1_PID=0",
  "D2_UNIT=dgx-dashboard-admin.service",
  "D2_ENABLED=disabled",
  "D2_ACTIVE=inactive",
  "D2_MEM=",
  "D2_PID=0",
  "RESULT=ok",
].join("\n");

const KNOWN = {
  s1: { id: "s1", name: "S1", kind: "spark", platform: "linux", ssh: { user: "u", host: "s1.lan", port: 22 } },
  s2: { id: "s2", name: "S2", kind: "spark", platform: "linux", ssh: { user: "u", host: "s2.lan", port: 22 } },
  h1: { id: "h1", name: "H1", kind: "host", platform: "linux" },
};

/** The dashboard's own Linux machine, as config/sparks.json registers it. */
const DELL_LOCAL = { id: "dell-lan", name: "dell.lan", kind: "host", isLocal: true, platform: "linux" };

async function withApp({ run, allow = () => true, remoteAddr, plain = false, extraSparks = {}, online }, fn) {
  const events = [];
  const units = { ...KNOWN, ...extraSparks };
  const app = express();
  app.use(express.json());
  if (remoteAddr) {
    app.use((req, _res, next) => {
      Object.defineProperty(req.socket, "remoteAddress", { value: remoteAddr, configurable: true });
      next();
    });
  }
  const manager = new UpdateManager({
    run,
    now: () => 1_700_000_000_000,
    listSparks: () => Object.values(units),
    isOnline: online ?? ((id) => id === "s1"),
    getSettings: () => ({ updatesAutoCheck: true }),
  });
  registerUpdatesRoutes(app, {
    manager,
    registry: { getSpark: (id) => units[id] },
    recordEvent: (e) => events.push(e),
    allowRead: allow,
    allowChange: allow,
    rejectLimited: (res, message) => res.status(429).json({ error: message }),
    allowPlainPassword: () => plain,
  });
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  try {
    await fn(base, events, manager);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const json = (body) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

test("summary and detail answer with the contract shapes; unknown and host units are refused", async () => {
  await withApp({ run: async () => CHECK_OK }, async (base, _e, manager) => {
    const summary = await (await fetch(`${base}/updates/summary`)).json();
    assert.equal(summary.now, 1_700_000_000_000);
    assert.equal(summary.anyUpgradable, false);
    assert.deepEqual(summary.sparks.map((s) => s.id).sort(), ["s1", "s2"], "hosts are not update machines");
    const s1 = summary.sparks.find((s) => s.id === "s1");
    assert.deepEqual(Object.keys(s1).sort(), ["aptCount", "checkedAt", "firmwareRebootNeeded", "fwCount", "id", "name", "online", "rebootRequired", "state"]);
    assert.equal(s1.state, "idle");
    assert.equal(s1.online, true);
    assert.equal(summary.sparks.find((s) => s.id === "s2").online, false);

    const detail = await (await fetch(`${base}/sparks/s1/updates`)).json();
    assert.equal(detail.state, "idle");
    assert.equal(detail.checkedAt, null);

    const check = await (await fetch(`${base}/sparks/s1/updates/check`, json({}))).json();
    assert.equal(check.state, "ok");
    assert.equal(check.apt[0].name, "curl");
    const after = (await (await fetch(`${base}/updates/summary`)).json()).sparks.find((s) => s.id === "s1");
    assert.equal(after.aptCount, 1);
    assert.equal(after.checkedAt, 1_700_000_000_000);

    assert.equal((await fetch(`${base}/sparks/nope/updates`)).status, 404);
    // A host is not an apt machine: its update routes answer 400.
    assert.equal((await fetch(`${base}/sparks/h1/updates`)).status, 400);
  });
});

test("install gates on the simulation removals and the job is followable", async () => {
  await withApp(
    {
      run: async (s, program) => {
        if (program.includes("sparkdash-updates:install")) return "STEP=apt\nLAST=curl\nSTEP=firmware\nFWUP=missing\n" + CHECK_OK;
        return CHECK_WITH_REMOVALS;
      },
    },
    async (base, events, manager) => {
      await fetch(`${base}/sparks/s1/updates/check`, json({}));
      const blocked = await fetch(`${base}/sparks/s1/updates/install`, json({ sudoPassword: "a-perfectly-good-pw" }));
      assert.equal(blocked.status, 409);
      const gate = await blocked.json();
      assert.equal(gate.code, "needs_confirmation");
      assert.deepEqual(gate.removals, ["python2-minimal", "old-libs"]);
      assert.ok(!JSON.stringify(gate).includes("a-perfectly-good-pw"));

      const started = await fetch(`${base}/sparks/s1/updates/install`, json({ sudoPassword: "a-perfectly-good-pw", confirmRemovals: true }));
      assert.equal(started.status, 202);
      const { jobId } = await started.json();
      await manager.settled();
      const { job, now } = await (await fetch(`${base}/sparks/s1/updates/job`)).json();
      assert.equal(job.id, jobId);
      assert.equal(job.state, "done");
      assert.equal(now, 1_700_000_000_000);
      assert.deepEqual(job.phases.map((p) => [p.key, p.state]), [
        ["apt", "done"],
        ["firmware", "skipped"],
      ]);
      assert.equal(events.some((e) => e.type === "updates.install"), true);
    }
  );
});

test("check reports unit-busy while an install job runs", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  await withApp(
    {
      run: async (s, program) => {
        if (program.includes("sparkdash-updates:install")) {
          await gate;
          return "STEP=apt\nLAST=x\nSTEP=firmware\nFWUP=none\n" + CHECK_OK;
        }
        return CHECK_OK;
      },
    },
    async (base, _e, manager) => {
      // Only a checked unit may be installed on (the needs-check gate); this test is about busy.
      assert.equal((await fetch(`${base}/sparks/s1/updates/check`, json({}))).status, 200);
      const started = await fetch(`${base}/sparks/s1/updates/install`, json({}));
      assert.equal(started.status, 202);
      const busy = await fetch(`${base}/sparks/s1/updates/check`, json({}));
      assert.equal(busy.status, 409);
      assert.equal((await busy.json()).code, "unit-busy");
      release();
      await manager.settled();
    }
  );
});

test("sudo passwords: https/loopback rules, one-time use, lock-out codes, nothing echoed", async () => {
  const pw = "correct-horse-battery";
  // From another machine over plain http: refused before anything runs.
  await withApp({ run: async () => CHECK_OK, remoteAddr: "192.168.1.20" }, async (base) => {
    const r = await fetch(`${base}/sparks/s1/updates/refresh`, json({ sudoPassword: pw }));
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, "insecure-transport");
  });
  // Settings may allow it, and then the password must reach the transport — never the answer.
  const seen = [];
  await withApp(
    {
      plain: true,
      run: async (s, program, opts) => {
        seen.push({ program, input: opts?.input });
        return "REFRESHED=ok\n" + CHECK_OK;
      },
    },
    async (base) => {
      const r = await fetch(`${base}/sparks/s1/updates/refresh`, json({ sudoPassword: pw }));
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.state, "ok");
      assert.equal(seen[0].input, pw);
      assert.ok(!seen[0].program.includes(pw), "the password rides on stdin, not in the program");
      assert.ok(!JSON.stringify(body).includes(pw));
    }
  );
  // Bad password: 403 with the storage code; three times: the guard locks and answers 429.
  await withApp(
    {
      plain: true,
      run: async () => "RESULT=error\nCODE=bad-password\nMSG=The sudo password was not accepted\n",
    },
    async (base) => {
      for (let i = 0; i < 3; i += 1) {
        const r = await fetch(`${base}/sparks/s1/updates/dashboard-service`, json({ enabled: false, sudoPassword: pw }));
        assert.equal(r.status, 403);
        assert.equal((await r.json()).code, "bad-password");
      }
      const locked = await fetch(`${base}/sparks/s1/updates/dashboard-service`, json({ enabled: false, sudoPassword: pw }));
      assert.equal(locked.status, 429);
      assert.equal((await locked.json()).code, "password-locked");
    }
  );
});

test("dashboard service GET and POST answer with the two units", async () => {
  await withApp(
    {
      run: async () => DASH_OFF,
      plain: true,
    },
    async (base, events) => {
      const got = await (await fetch(`${base}/sparks/s1/updates/dashboard-service`)).json();
      assert.deepEqual(got.units, [
        { unit: "dgx-dashboard.service", enabled: "disabled", active: "inactive", memoryBytes: null, mainPid: 0 },
        { unit: "dgx-dashboard-admin.service", enabled: "disabled", active: "inactive", memoryBytes: null, mainPid: 0 },
      ]);
      assert.equal(got.now, 1_700_000_000_000);
      const post = await fetch(`${base}/sparks/s1/updates/dashboard-service`, json({ enabled: false, sudoPassword: "some-secret-pw" }));
      assert.equal(post.status, 200);
      assert.deepEqual((await post.json()).units, got.units);
      assert.equal(events.some((e) => e.type === "updates.dashboard-service" && /off/.test(e.message)), true);
    }
  );
});

test("install-all: fleet job shape, already-running refusal and outcomes", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  await withApp(
    {
      run: async (s, program) => {
        if (program.includes("sparkdash-updates:install")) {
          if (s.id === "s1") await gate;
          return "STEP=apt\nLAST=x\nSTEP=firmware\nFWUP=none\n" + CHECK_OK;
        }
        return CHECK_OK;
      },
    },
    async (base, _e, manager) => {
      const never = await (await fetch(`${base}/updates/install-all`)).json();
      assert.deepEqual(never, { job: null });
      // The fleet only installs units it has seen: check s1 so its row can reach done.
      assert.equal((await fetch(`${base}/sparks/s1/updates/check`, json({}))).status, 200);
      const started = await fetch(`${base}/updates/install-all`, json({ sudoPassword: "fleet-secret-pw" }));
      assert.equal(started.status, 202);
      const { jobId } = await started.json();
      const dup = await fetch(`${base}/updates/install-all`, json({ sudoPassword: "fleet-secret-pw" }));
      assert.equal(dup.status, 409);
      assert.equal((await dup.json()).code, "already-running");
      release();
      await manager.settled();
      const { job } = await (await fetch(`${base}/updates/install-all`)).json();
      assert.equal(job.id, jobId);
      assert.equal(job.state, "done");
      assert.equal(job.now, 1_700_000_000_000);
      const outcomes = Object.fromEntries(job.units.map((u) => [u.sparkId, u.state]));
      assert.deepEqual(Object.keys(outcomes).sort(), ["s1", "s2"], "hosts never enter the fleet");
      assert.equal(outcomes.s1, "done");
      assert.equal(outcomes.s2, "skipped-offline");
      assert.ok(!JSON.stringify(job).includes("fleet-secret-pw"));
    }
  );
});

test("the dashboard's own machine (isLocal host) is admitted: summary, detail and check", async () => {
  await withApp({ run: async () => CHECK_OK, extraSparks: { [DELL_LOCAL.id]: DELL_LOCAL } }, async (base) => {
    const summary = await (await fetch(`${base}/updates/summary`)).json();
    assert.deepEqual(summary.sparks.map((s) => s.id).sort(), ["dell-lan", "s1", "s2"], "the local host joins the units the remote host stays out of");
    const detail = await fetch(`${base}/sparks/dell-lan/updates`);
    assert.equal(detail.status, 200, "the local host passes the gate h1 fails");
    assert.equal((await detail.json()).sparkId, "dell-lan");
    const check = await fetch(`${base}/sparks/dell-lan/updates/check`, json({}));
    assert.equal(check.status, 200, "the sudo-free check runs on the dashboard's own machine");
    assert.equal((await check.json()).state, "ok");
  });
});

test("install-all carries the dashboard's own machine (isLocal host) into the fleet", async () => {
  await withApp(
    {
      run: async (s, program) => {
        if (program.includes("sparkdash-updates:install")) {
          return "STEP=apt\nLAST=x\nSTEP=firmware\nFWUP=none\n" + CHECK_OK;
        }
        return CHECK_OK;
      },
      extraSparks: { [DELL_LOCAL.id]: DELL_LOCAL },
      online: (id) => id === "s1" || id === "dell-lan",
    },
    async (base, _e, manager) => {
      // The fleet only installs units it has seen: check the two online units so their rows can reach done.
      assert.equal((await fetch(`${base}/sparks/s1/updates/check`, json({}))).status, 200);
      assert.equal((await fetch(`${base}/sparks/dell-lan/updates/check`, json({}))).status, 200);
      const started = await fetch(`${base}/updates/install-all`, json({ sudoPassword: "fleet-secret-pw" }));
      assert.equal(started.status, 202);
      await manager.settled();
      const { job } = await (await fetch(`${base}/updates/install-all`)).json();
      const outcomes = Object.fromEntries(job.units.map((u) => [u.sparkId, u.state]));
      assert.deepEqual(Object.keys(outcomes).sort(), ["dell-lan", "s1", "s2"], "the local host enters the fleet where the remote host stays out");
      assert.equal(outcomes["dell-lan"], "done", "the dashboard's own machine updates like any Spark");
      assert.equal(outcomes.s1, "done");
      assert.equal(outcomes.s2, "skipped-offline");
      assert.ok(!JSON.stringify(job).includes("fleet-secret-pw"));
    }
  );
});

test("limiters: a refused read or mutation answers 429 through rejectLimited", async () => {
  await withApp({ run: async () => CHECK_OK, allow: () => false }, async (base) => {
    assert.equal((await fetch(`${base}/updates/summary`)).status, 429);
    assert.equal((await fetch(`${base}/sparks/s1/updates/check`, json({}))).status, 429);
    assert.equal((await fetch(`${base}/sparks/s1/updates/job`)).status, 200, "job polls are deliberately un-limited");
  });
});

test("the dashboard-service POST refuses a non-boolean enabled instead of guessing off", async () => {
  let touched = 0;
  await withApp(
    {
      run: async () => {
        touched += 1;
        return DASH_OFF;
      },
      plain: true,
    },
    async (base) => {
      const yes = await fetch(`${base}/sparks/s1/updates/dashboard-service`, json({ enabled: "yes", sudoPassword: "a-secret-pw" }));
      assert.equal(yes.status, 400);
      assert.match((await yes.json()).error, /enabled must be true or false/);
      const absent = await fetch(`${base}/sparks/s1/updates/dashboard-service`, json({ sudoPassword: "a-secret-pw" }));
      assert.equal(absent.status, 400);
      assert.equal(touched, 0, "nothing was sent to the unit");
      const real = await fetch(`${base}/sparks/s1/updates/dashboard-service`, json({ enabled: false, sudoPassword: "a-secret-pw" }));
      assert.equal(real.status, 200);
      assert.equal(touched, 1);
    }
  );
});
