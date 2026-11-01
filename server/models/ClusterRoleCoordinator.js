/**
 * ClusterRoleCoordinator — keeps the fleet's Spark roles (Head / Worker /
 * Standalone) in step with what the model launcher is actually running.
 *
 * The Models panel knows which Sparks each model occupies; the Spark cards
 * only know the roles persisted in the SparkRegistry. Without this module a
 * unit that fronted a stopped cluster would keep wearing a Worker badge, and
 * the second of two concurrent clusters would never show its Head. The rule:
 * every model that is UP (or mid start/stop job) claims its occupancy — the
 * cluster head becomes Head, the rest Workers of it — and every Spark inside
 * the declared scope that no running model claims falls back to Standalone.
 * Sparks outside the scope (named by no registered model) are never touched.
 *
 * The head is `modelHead()` — the declared cluster head, NOT the Spark the
 * scripts run on: a remote-launch kit (start.sh from spark1, cluster up on
 * 3+4 with 3 as head) leaves spark1 unheld and shows 3 as Head, 4 as Worker.
 *
 * The operator-facing loop closes here: Start TP2 on Sparks 1+2 → 1 becomes
 * Head and 2 Worker; the units 3+4 that a previous TP4 run held return to
 * Standalone the moment nothing runs on them.
 */
import { modelHead, modelOccupancy } from "./ModelRegistry.js";

/** Deterministic claim order: card position, then id. */
function byPosition(a, b) {
  const pa = Number.isInteger(a.position) ? a.position : Number.POSITIVE_INFINITY;
  const pb = Number.isInteger(b.position) ? b.position : Number.POSITIVE_INFINITY;
  return pa !== pb ? pa - pb : String(a.id).localeCompare(String(b.id));
}

/**
 * Pure plan: sparkId → desired role for the Sparks named by any model.
 * `isHeld(modelId)` is true while the model is running or a mutating job for
 * it is in flight (a start that has not served yet already owns its units;
 * a stop in flight still does until it finishes). Two models claiming one
 * unit is a broken config, not a crash: the earlier claim wins and the next
 * probe pass re-plans.
 *
 * @param {object[]} models registry configs
 * @param {(model: object) => boolean} isHeld
 * @returns {Map<string, {role: string, workerHeadId: string|null, workerLabel: string|null}>}
 */
export function planClusterRoles(models, isHeld) {
  const plan = new Map();
  const ordered = [...models].sort(byPosition);
  for (const m of ordered) {
    if (!isHeld(m)) continue;
    const occ = modelOccupancy(m);
    if (!occ.length) continue;
    // The head leads and serves — the declared one, else the first occupied
    // unit. It is not the script host unless the operator said so.
    const declared = modelHead(m);
    const head = declared && occ.includes(declared) ? declared : occ[0];
    for (const sparkId of occ) {
      if (plan.has(sparkId)) continue;
      plan.set(
        sparkId,
        sparkId === head
          ? { role: "head", workerHeadId: null, workerLabel: null }
          : { role: "worker", workerHeadId: head, workerLabel: m.name || m.id }
      );
    }
  }
  return plan;
}

/**
 * The minimal patch that moves a unit to `want`, or null when it is there
 * already (so the caller never rewrites sparks.json on a quiet probe tick).
 * Releasing a unit to Standalone also re-arms its LLM monitoring: a Worker
 * had it force-off by the role normalizer, and a freed unit whose card still
 * hides the LLM panel is not "displayed correctly".
 *
 * @param {object} spark current private Spark config
 * @param {{role: string, workerHeadId: string|null, workerLabel: string|null}} want
 */
export function diffSparkRole(spark, want) {
  const patch = {};
  const have = spark.role ?? (spark.workerNode ? "worker" : "standalone");
  if (have !== want.role) patch.role = want.role;
  if (want.role === "worker") {
    if (spark.workerHeadId !== want.workerHeadId) patch.workerHeadId = want.workerHeadId;
    if (spark.workerLabel !== want.workerLabel) patch.workerLabel = want.workerLabel;
  }
  if (want.role === "standalone" && spark.llmMonitoring === false) patch.llmMonitoring = true;
  return Object.keys(patch).length ? patch : null;
}

export class ClusterRoleCoordinator {
  /**
   * @param {object} deps
   * @param {() => object[]} deps.getModels registry models
   * @param {() => Record<string, object>} deps.status latest probe status map
   * @param {(modelId: string) => boolean} deps.jobRunning mutating job in flight
   * @param {(id: string) => object|null} deps.getSpark private Spark lookup
   * @param {((id: string, patch: object) => void)|null} [deps.updateSpark]
   *   apply a role patch — index.js wires this to SparkRegistry.updateSpark
   *   plus the monitor restart, so collector/probe behaviour follows the role.
   *   Null = the coordinator is inert (unit tests, launcher without fleet).
   * @param {(msg: string) => void} [deps.log]
   */
  constructor(deps) {
    this.getModels = deps.getModels;
    this.status = deps.status || (() => ({}));
    this.jobRunning = deps.jobRunning || (() => false);
    this.getSpark = deps.getSpark || (() => null);
    this.updateSpark = deps.updateSpark || null;
    this.log = deps.log || (() => {});
  }

  /**
   * Apply the plan to the SparkRegistry. Returns the number of units changed.
   * Never throws: a unit that refuses its patch is logged and retried on the
   * next pass (the probe ticks every few seconds anyway).
   */
  reconcile() {
    if (!this.updateSpark) return 0;
    const models = this.getModels();
    const isHeld = (m) =>
      Boolean(this.status()[m.id]?.running) || this.jobRunning(m.id);
    const plan = planClusterRoles(models, isHeld);
    const managed = new Set();
    for (const m of models) for (const s of modelOccupancy(m)) managed.add(s);
    let changed = 0;
    for (const sparkId of managed) {
      const spark = this.getSpark(sparkId);
      if (!spark) continue; // unit removed from the fleet — nothing to configure
      const want = plan.get(sparkId) || {
        role: "standalone",
        workerHeadId: null,
        workerLabel: null,
      };
      const patch = diffSparkRole(spark, want);
      if (!patch) continue;
      try {
        this.updateSpark(sparkId, patch);
        changed += 1;
        this.log(`${sparkId} → ${want.role}${want.role === "worker" ? ` of ${want.workerHeadId} (${want.workerLabel})` : ""}`);
      } catch (err) {
        this.log(`failed to set ${sparkId} to ${want.role}: ${err?.message || err}`);
      }
    }
    return changed;
  }
}
