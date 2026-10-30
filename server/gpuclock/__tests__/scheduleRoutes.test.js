import { test } from "node:test";
import { strict as assert } from "node:assert";
import express from "express";
import { registerGpuClockScheduleRoute } from "../routes.js";
import { validateGpuClockSchedule } from "../../../src/shared/gpuClockSchedule.js";

const CONFIG = {
  enabled: true,
  tz: "Europe/Prague",
  windows: [
    { start: "08:00", end: "20:00", maxMHz: 2200 },
    { start: "20:00", end: "08:00", maxMHz: 1900 },
  ],
};

const DISABLED = { ...CONFIG, enabled: false };

async function withApp(
  { applySchedule, removeSchedule, allow = () => true, schedule = DISABLED } = {},
  fn,
) {
  const app = express();
  app.use(express.json());
  const events = [];
  const saved = [];
  let current = schedule;
  registerGpuClockScheduleRoute(app, {
    manager: {
      applySchedule: applySchedule ?? (async () => ({ capMHz: 2200, kind: "unit" })),
      removeSchedule: removeSchedule ?? (async () => ({})),
    },
    registry: {
      sparks: [
        { id: "s1", name: "S1", kind: "spark" },
        { id: "s2", name: "S2", kind: "spark" },
        { id: "h1", name: "H1", kind: "host" },
      ],
    },
    recordEvent: (e) => events.push(e),
    allowRead: allow,
    allowChange: allow,
    rejectLimited: (res, message) => res.status(429).json({ error: message }),
    getSchedule: () => current,
    saveSchedule: (cfg) => {
      // The real store validates; this stub does the same so the route's error
      // path is exercised without touching a config file.
      const check = validateGpuClockSchedule(cfg);
      if (!check.ok) {
        const err = new Error(check.errors.join("; "));
        err.status = 400;
        throw err;
      }
      saved.push(check.config);
      current = check.config;
      return current;
    },
  });
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/sparks`;
  try {
    await fn(base, { events, saved });
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const json = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test("GET returns the stored schedule", async () => {
  await withApp({}, async (base) => {
    const res = await fetch(`${base}/gpu-clock-schedule`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), DISABLED);
  });
});

test("PUT validates before anything runs, then installs on every Spark", async () => {
  const seen = [];
  await withApp(
    { applySchedule: async (spark) => (seen.push(spark.id), { capMHz: 2200, kind: "unit" }) },
    async (base, { events, saved }) => {
      const bad = await fetch(`${base}/gpu-clock-schedule`, json("PUT", { ...CONFIG, windows: [] }));
      assert.equal(bad.status, 400);
      assert.match((await bad.json()).error, /windows/);
      assert.equal(seen.length, 0);

      const res = await fetch(`${base}/gpu-clock-schedule`, json("PUT", CONFIG));
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.applied, 2);
      assert.deepEqual(body.results, [
        { id: "s1", ok: true, capMHz: 2200, kind: "unit" },
        { id: "s2", ok: true, capMHz: 2200, kind: "unit" },
        { id: "h1", ok: true, supported: false, reason: "GPU clock caps are only supported on Spark units" },
      ]);
      assert.deepEqual(seen, ["s1", "s2"]);
      assert.equal(saved.at(-1).enabled, true);
      assert.equal(events.length, 2);
      assert.ok(events.every((e) => e.type === "gpu.clock.schedule.set"));
      assert.match(events[0].message, /08:00–20:00 2200 MHz/);
    },
  );
});

test("PUT that no unit took is stored disabled and reports failure", async () => {
  await withApp(
    { applySchedule: async () => { throw Object.assign(new Error("passwordless sudo is required"), { code: "no-sudo" }); } },
    async (base, { saved }) => {
      const res = await fetch(`${base}/gpu-clock-schedule`, json("PUT", CONFIG));
      const body = await res.json();
      assert.equal(body.success, false);
      assert.equal(body.applied, 0);
      assert.equal(body.config.enabled, false);
      assert.equal(saved.at(-1).enabled, false);
      assert.match(body.results[0].error, /passwordless sudo/);
    },
  );
});

test("DELETE removes the schedule from every unit and disables the config", async () => {
  const seen = [];
  await withApp(
    {
      schedule: CONFIG,
      removeSchedule: async (spark) => {
        seen.push(spark.id);
        return {};
      },
    },
    async (base, { events, saved }) => {
      const res = await fetch(`${base}/gpu-clock-schedule`, { method: "DELETE" });
      const body = await res.json();
      assert.equal(body.success, true);
      assert.deepEqual(seen, ["s1", "s2"]);
      assert.equal(body.config.enabled, false);
      assert.equal(saved.at(-1).enabled, false);
      assert.equal(events.length, 2);
      assert.ok(events.every((e) => e.type === "gpu.clock.schedule.reset"));
    },
  );
});

test("rate limiting applies to reads and changes", async () => {
  let ran = 0;
  await withApp(
    {
      allow: () => false,
      applySchedule: async () => {
        ran += 1;
        return { capMHz: 2200, kind: "unit" };
      },
    },
    async (base) => {
      assert.equal((await fetch(`${base}/gpu-clock-schedule`)).status, 429);
      assert.equal((await fetch(`${base}/gpu-clock-schedule`, json("PUT", CONFIG))).status, 429);
      assert.equal((await fetch(`${base}/gpu-clock-schedule`, { method: "DELETE" })).status, 429);
      assert.equal(ran, 0);
    },
  );
});
