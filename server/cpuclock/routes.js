/**
 * GET/PUT/DELETE /api/sparks/:id/cpu-clock and POST /api/sparks/cpu-clock-all.
 * Same auth and rate limiters as the GPU clock routes. The CPU cap has no
 * schedule: it is a fixed maximum frequency (or the hardware maximum).
 */
import { cpuClockUnsupportedReason } from "./CpuClockManager.js";
import { parseCpuCapRequest } from "./commands.js";

/** Whole-batch budget; one unit's own timeout is 45 s. */
export const CPU_FLEET_DEADLINE_MS = 3 * 60_000;

const keptText = (kind) => (kind === "cron" ? " by the @reboot cron job" : " by the boot service");

export function registerCpuClockRoutes(app, { manager, registry, recordEvent, allowRead, allowChange, rejectLimited }) {
  const handle = (fn) => async (req, res) => {
    try {
      const spark = registry.getSpark(req.params.id);
      if (!spark) return res.status(404).json({ error: "Spark not found" });
      const unsupported = cpuClockUnsupportedReason(spark);
      if (unsupported) return res.status(400).json({ error: unsupported });
      await fn(spark, req, res);
    } catch (err) {
      const known = Number.isInteger(err?.status);
      res.status(known ? err.status : 500).json({ error: known ? err.message : "CPU clock action failed", code: err?.code });
    }
  };

  app.get(
    "/api/sparks/:id/cpu-clock",
    handle(async (spark, req, res) => {
      if (!allowRead(req)) return rejectLimited(res, "Too many requests");
      res.json(await manager.status(spark));
    })
  );

  app.put(
    "/api/sparks/:id/cpu-clock",
    handle(async (spark, req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many CPU clock changes, try again in a minute");
      const out = await manager.apply(spark, req.body);
      recordEvent({
        type: "cpu.clock.set",
        severity: "info",
        sparkId: spark.id,
        message: `CPU frequency capped at ${out.maxMHz} MHz${out.persist ? ` (kept after reboot${keptText(out.persistKind)})` : ""}`,
      });
      res.json({ success: true, ...out });
    })
  );

  app.delete(
    "/api/sparks/:id/cpu-clock",
    handle(async (spark, req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many CPU clock changes, try again in a minute");
      await manager.reset(spark);
      recordEvent({ type: "cpu.clock.reset", severity: "info", sparkId: spark.id, message: "CPU frequency cap removed" });
      res.json({ success: true });
    })
  );
}

/**
 * POST /api/sparks/cpu-clock-all — body `{ maxMHz, persist? }` or
 * `{ reset: true }`. One limiter hit per batch; one Activity event per unit.
 */
export function registerCpuClockFleetRoute(
  app,
  { manager, registry, recordEvent, allowChange, rejectLimited, fleetDeadlineMs = CPU_FLEET_DEADLINE_MS }
) {
  app.post("/api/sparks/cpu-clock-all", async (req, res) => {
    const { maxMHz, persist, reset } = req.body ?? {};
    const wantsReset = reset === true;
    if (wantsReset === (maxMHz !== undefined)) {
      return res.status(400).json({ error: "Send either { maxMHz } or { reset: true }, not both" });
    }
    if (!wantsReset) {
      try {
        parseCpuCapRequest({ maxMHz, persist });
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }
    if (!allowChange(req)) return rejectLimited(res, "Too many CPU clock changes, try again in a minute");
    const results = [];
    const deadline = Date.now() + fleetDeadlineMs;
    for (const spark of registry.sparks) {
      if (Date.now() > deadline) {
        results.push({ id: spark.id, ok: false, error: "Not attempted: the fleet change ran out of time before this unit" });
        continue;
      }
      const unsupported = cpuClockUnsupportedReason(spark);
      if (unsupported) {
        results.push({ id: spark.id, ok: true, supported: false, reason: unsupported });
        continue;
      }
      try {
        if (wantsReset) {
          await manager.reset(spark);
          recordEvent({
            type: "cpu.clock.reset",
            severity: "info",
            sparkId: spark.id,
            message: "Fleet reset: CPU frequency cap removed",
          });
          results.push({ id: spark.id, ok: true, maxMHz: null, persistKind: "none" });
        } else {
          const out = await manager.apply(spark, { maxMHz, persist: persist === true });
          recordEvent({
            type: "cpu.clock.set",
            severity: "info",
            sparkId: spark.id,
            message: `Fleet cap: CPU frequency capped at ${out.maxMHz} MHz${out.persist ? ` (kept after reboot${keptText(out.persistKind)})` : ""}`,
          });
          results.push({ id: spark.id, ok: true, maxMHz: out.maxMHz, persistKind: out.persistKind });
        }
      } catch (err) {
        if (err?.code === "no-cpupower" || err?.code === "no-cpufreq") {
          results.push({ id: spark.id, ok: true, supported: false, reason: err.message });
        } else {
          results.push({ id: spark.id, ok: false, error: err?.message || String(err) });
        }
      }
    }
    const applied = results.filter((r) => r.ok && r.supported !== false).length;
    res.json({ success: results.every((r) => r.ok) && applied > 0, applied, results });
  });
}
