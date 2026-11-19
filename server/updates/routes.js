/**
 * /api/updates/* and /api/sparks/:id/updates/*: the Updates page. Registered after the auth and
 * Host/Origin middleware, so a token (when SPARKDASH_TOKEN is set) is required exactly as for
 * power actions. Anything that changes a unit (check, refresh, install, service toggle) uses the
 * destructive limiter; reads use the test limiter. The two job polls are the exception: cheap
 * in-memory reads the page follows every second, deliberately un-limited (see storage's scan poll).
 */
import { passwordAllowed } from "../gpuclock/routes.js";
import { parseSudoPassword } from "./commands.js";

/**
 * @param {object} app
 * @param {{ manager: object, registry: object, recordEvent: Function, allowRead: Function,
 *   allowChange: Function, rejectLimited: Function, allowPlainPassword?: () => boolean }} deps
 */
export function registerUpdatesRoutes(app, { manager, registry, recordEvent = () => {}, allowRead, allowChange, rejectLimited, allowPlainPassword = () => false }) {
  /** Errors from the manager carry a status and a curated message; anything else stays generic. */
  const mapError = (res, err) => {
    const known = Number.isInteger(err?.status);
    res.status(known ? err.status : 500).json({
      error: known ? err.message : "Update action failed",
      code: err?.code,
      // needs_confirmation: the Remv list the page must show before retrying with confirmRemovals.
      ...(Array.isArray(err?.removals) ? { removals: err.removals } : {}),
    });
  };

  /** Routes under /api/sparks/:id: the registry entry comes first, 404 when unknown. */
  const handle = (fn) => async (req, res) => {
    try {
      const spark = registry.getSpark(req.params.id);
      if (!spark) return res.status(404).json({ error: "Spark not found" });
      await fn(spark, req, res);
    } catch (err) {
      mapError(res, err);
    }
  };

  /** Fleet-wide routes under /api/updates: no unit to resolve. */
  const handleGlobal = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      mapError(res, err);
    }
  };

  /** A typed sudo password may only cross https or stay on the machine itself, unless Settings allows plain http. */
  const refuseInsecurePassword = (req, res) => {
    if (!req.body?.sudoPassword || passwordAllowed(req, allowPlainPassword())) return false;
    res.status(400).json({
      error: "Open the dashboard over https or from the Spark itself to type a sudo password here, turn on Settings → Allow sudo password over plain http, or run the command on the Spark.",
      code: "insecure-transport",
    });
    return true;
  };

  const name = (spark) => spark.name || spark.id;

  // The nav dot and the page header, from the last checks only — nothing runs here.
  app.get(
    "/api/updates/summary",
    handleGlobal(async (req, res) => {
      if (!allowRead(req)) return rejectLimited(res, "Too many requests");
      res.json(manager.summary());
    })
  );

  app.get(
    "/api/sparks/:id/updates",
    handle(async (spark, req, res) => {
      if (!allowRead(req)) return rejectLimited(res, "Too many requests");
      res.json(manager.detail(spark));
    })
  );

  // The sudo-free check, now. 409 unit-busy while an install job holds the unit.
  app.post(
    "/api/sparks/:id/updates/check",
    handle(async (spark, req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many update requests, try again in a minute");
      res.json(await manager.check(spark));
    })
  );

  // sudo apt-get update (three tries) + fwupdmgr refresh, then the check. Password used once.
  app.post(
    "/api/sparks/:id/updates/refresh",
    handle(async (spark, req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many update requests, try again in a minute");
      if (refuseInsecurePassword(req, res)) return;
      const sudoPassword = parseSudoPassword(req.body?.sudoPassword);
      res.json(await manager.refresh(spark, { sudoPassword, remember: req.body?.remember === true }));
    })
  );

  // Start the install job. Removals the last simulation showed are gated until confirmed.
  app.post(
    "/api/sparks/:id/updates/install",
    handle(async (spark, req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many update requests, try again in a minute");
      if (refuseInsecurePassword(req, res)) return;
      const sudoPassword = parseSudoPassword(req.body?.sudoPassword);
      const started = manager.install(spark, { sudoPassword, confirmRemovals: req.body?.confirmRemovals === true });
      recordEvent({ type: "updates.install", severity: "info", message: `Started the software update on ${name(spark)}` });
      res.status(202).json(started);
    })
  );

  // Follow the install job (1 s polls, like the storage scan poll: no limiter).
  app.get(
    "/api/sparks/:id/updates/job",
    handle(async (spark, _req, res) => {
      res.json(manager.job(spark));
    })
  );

  // The fleet job: every Linux Spark unit, one at a time, the same sudo password used once per unit.
  app.post(
    "/api/updates/install-all",
    handleGlobal(async (req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many update requests, try again in a minute");
      if (refuseInsecurePassword(req, res)) return;
      const sudoPassword = parseSudoPassword(req.body?.sudoPassword);
      const started = manager.installAll({ sudoPassword });
      recordEvent({ type: "updates.install-all", severity: "info", message: "Started the software update on all Sparks" });
      res.status(202).json(started);
    })
  );

  // The fleet index refresh: the same shared fleet job as install-all (a running job of either
  // kind refuses the other), running the sudo refresh + fresh check on every unit in turn.
  app.post(
    "/api/updates/refresh-all",
    handleGlobal(async (req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many update requests, try again in a minute");
      if (refuseInsecurePassword(req, res)) return;
      const sudoPassword = parseSudoPassword(req.body?.sudoPassword);
      const started = manager.refreshAll({ sudoPassword, remember: req.body?.remember === true });
      recordEvent({ type: "updates.refresh-all", severity: "info", message: "Started the index refresh on all Sparks" });
      res.status(202).json(started);
    })
  );

  app.get(
    "/api/updates/install-all",
    handleGlobal(async (_req, res) => {
      res.json(manager.fleetJob());
    })
  );

  // The DGX Dashboard services: status unprivileged; on/off needs the administrator password.
  app.get(
    "/api/sparks/:id/updates/dashboard-service",
    handle(async (spark, req, res) => {
      if (!allowRead(req)) return rejectLimited(res, "Too many requests");
      res.json(await manager.dashboardService(spark));
    })
  );

  app.post(
    "/api/sparks/:id/updates/dashboard-service",
    handle(async (spark, req, res) => {
      if (!allowChange(req)) return rejectLimited(res, "Too many update requests, try again in a minute");
      if (refuseInsecurePassword(req, res)) return;
      const sudoPassword = parseSudoPassword(req.body?.sudoPassword);
      // Anything but a real boolean must not silently disable both units.
      if (typeof req.body?.enabled !== "boolean") {
        return res.status(400).json({ error: "enabled must be true or false" });
      }
      const enabled = req.body.enabled;
      const out = await manager.setDashboardService(spark, { enabled, sudoPassword });
      recordEvent({
        type: "updates.dashboard-service",
        severity: "info",
        message: `Turned the DGX Dashboard services ${enabled ? "on" : "off"} on ${name(spark)}`,
      });
      res.json(out);
    })
  );
}
