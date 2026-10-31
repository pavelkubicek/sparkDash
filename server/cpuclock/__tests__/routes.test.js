import { test } from "node:test";
import { strict as assert } from "node:assert";
import express from "express";
import { registerCpuClockFleetRoute, registerCpuClockRoutes } from "../routes.js";

async function withApp({ status, apply, reset, allow = () => true }, fn) {
  const events = [];
  const manager = {
    status: status ?? (async () => ({
      supported: true, hwMaxMHz: 3000, currentMaxMHz: 2808, capMHz: 2808,
      sudo: "yes", persistKind: "cron",
      service: { installed: false, maxMHz: null, enabled: null, active: null },
      cron: { installed: true, maxMHz: 2808, failed: false },
    })),
    apply: apply ?? (async () => ({ maxMHz: 2808, persist: true, persistKind: "cron" })),
    reset: reset ?? (async () => ({})),
  };
  const app = express();
  app.use(express.json());
  const registry = {
    getSpark: (id) => ({ s1: { id: "s1", name: "S1", kind: "spark" }, h1: { id: "h1", name: "H1", kind: "host" } })[id],
    sparks: [
      { id: "s1", name: "S1", kind: "spark" },
      { id: "s2", name: "S2", kind: "spark" },
      { id: "h1", name: "H1", kind: "host" },
    ],
  };
  const deps = {
    manager,
    registry,
    recordEvent: (e) => events.push(e),
    allowRead: allow,
    allowChange: allow,
    rejectLimited: (res, message) => res.status(429).json({ error: message }),
  };
  registerCpuClockFleetRoute(app, deps);
  registerCpuClockRoutes(app, deps);
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/sparks`;
  try {
    await fn(base, events);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const json = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

test("fleet cap applies to every Spark, reports the host and records one event per unit", async () => {
  const seen = [];
  await withApp(
    { apply: async (spark) => (seen.push(spark.id), { maxMHz: 2808, persist: true, persistKind: "cron" }) },
    async (base, events) => {
      const res = await fetch(`${base}/cpu-clock-all`, json("POST", { maxMHz: 2808, persist: true }));
      const body = await res.json();
      assert.equal(body.success, true);
      assert.equal(body.applied, 2);
      assert.deepEqual(body.results, [
        { id: "s1", ok: true, maxMHz: 2808, persistKind: "cron" },
        { id: "s2", ok: true, maxMHz: 2808, persistKind: "cron" },
        { id: "h1", ok: true, supported: false, reason: "CPU clock caps are only supported on Spark units" },
      ]);
      assert.deepEqual(seen, ["s1", "s2"]);
      assert.equal(events.length, 2);
      assert.ok(events.every((e) => e.type === "cpu.clock.set"));
      assert.match(events[0].message, /2808 MHz.*@reboot/);
    },
  );
});

test("fleet reset clears every cap and reports the host", async () => {
  await withApp({}, async (base, events) => {
    const res = await fetch(`${base}/cpu-clock-all`, json("POST", { reset: true }));
    const body = await res.json();
    assert.equal(body.success, true);
    assert.equal(body.applied, 2);
    assert.equal(body.results[0].maxMHz, null);
    assert.equal(body.results[2].supported, false);
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => e.type === "cpu.clock.reset"));
  });
});

test("fleet body validation rejects both/neither and out-of-range values", async () => {
  await withApp({}, async (base) => {
    assert.equal((await fetch(`${base}/cpu-clock-all`, json("POST", { maxMHz: 2808, reset: true }))).status, 400);
    assert.equal((await fetch(`${base}/cpu-clock-all`, json("POST", {}))).status, 400);
    assert.equal((await fetch(`${base}/cpu-clock-all`, json("POST", { maxMHz: "2808" }))).status, 400);
    assert.equal((await fetch(`${base}/cpu-clock-all`, json("POST", { maxMHz: 299 }))).status, 400);
  });
});

test("per-unit status, cap and reset answer with the unit's state", async () => {
  const calls = [];
  await withApp(
    {
      apply: async (_spark, body) => (calls.push(body), { maxMHz: body.maxMHz, persist: body.persist, persistKind: "cron" }),
      reset: async () => (calls.push("reset"), {}),
    },
    async (base, events) => {
      const status = await (await fetch(`${base}/s1/cpu-clock`)).json();
      assert.equal(status.capMHz, 2808);
      assert.equal(status.hwMaxMHz, 3000);

      const put = await fetch(`${base}/s1/cpu-clock`, json("PUT", { maxMHz: 2808, persist: true }));
      assert.equal(put.status, 200);
      assert.equal((await put.json()).maxMHz, 2808);

      const del = await fetch(`${base}/s1/cpu-clock`, { method: "DELETE" });
      assert.equal(del.status, 200);
      assert.deepEqual(calls, [{ maxMHz: 2808, persist: true }, "reset"]);
      assert.equal(events.length, 2);

      assert.equal((await fetch(`${base}/h1/cpu-clock`)).status, 400);
      assert.equal((await fetch(`${base}/nope/cpu-clock`)).status, 404);
    },
  );
});

test("rate limiting applies to reads and changes", async () => {
  await withApp({ allow: () => false }, async (base) => {
    assert.equal((await fetch(`${base}/s1/cpu-clock`)).status, 429);
    assert.equal((await fetch(`${base}/s1/cpu-clock`, json("PUT", { maxMHz: 2808 }))).status, 429);
    assert.equal((await fetch(`${base}/cpu-clock-all`, json("POST", { maxMHz: 2808 }))).status, 429);
  });
});
