import test from "node:test";
import assert from "node:assert/strict";
import {
  ClusterRoleCoordinator,
  planClusterRoles,
  diffSparkRole,
} from "../ClusterRoleCoordinator.js";

// The operator's RP4 fleet and the three kits that rotate over it.
const MODEL_TP4 = { id: "tp4", name: "TP4 4-way", sparkId: "spark1", nodes: ["spark1", "spark2", "spark3", "spark4"], position: 1 };
const MODEL_TP2_A = { id: "tp2a", name: "TP2 left", sparkId: "spark1", nodes: ["spark1", "spark2"], position: 2 };
const MODEL_TP2_B = { id: "tp2b", name: "TP2 right", sparkId: "spark3", nodes: ["spark3", "spark4"], position: 3 };
const MODEL_SOLO = { id: "solo", name: "Solo", sparkId: "spark9", nodes: [], position: 4 };

const asHeld = (ids) => (m) => ids.includes(m.id);

test("plan: a running 4-way makes the head Head and the rest Workers of it", () => {
  const plan = planClusterRoles([MODEL_TP4], asHeld(["tp4"]));
  assert.deepEqual(plan.get("spark1"), { role: "head", workerHeadId: null, workerLabel: null });
  for (const s of ["spark2", "spark3", "spark4"]) {
    assert.deepEqual(plan.get(s), { role: "worker", workerHeadId: "spark1", workerLabel: "TP4 4-way" });
  }
});

test("plan: two concurrent 2-way clusters each own their head and worker", () => {
  const plan = planClusterRoles([MODEL_TP2_A, MODEL_TP2_B], asHeld(["tp2a", "tp2b"]));
  assert.equal(plan.get("spark1").role, "head");
  assert.deepEqual(plan.get("spark2"), { role: "worker", workerHeadId: "spark1", workerLabel: "TP2 left" });
  assert.equal(plan.get("spark3").role, "head");
  assert.deepEqual(plan.get("spark4"), { role: "worker", workerHeadId: "spark3", workerLabel: "TP2 right" });
});

test("plan: nothing held → empty plan; unmanaged Sparks are never in scope", () => {
  const plan = planClusterRoles([MODEL_TP2_A, MODEL_SOLO], () => false);
  assert.equal(plan.size, 0);
  const withSolo = planClusterRoles([MODEL_TP2_A, MODEL_SOLO], asHeld(["solo"]));
  assert.equal(withSolo.get("spark9").role, "head", "a solo model owns only its head Spark");
  assert.equal(withSolo.has("spark2"), false, "spark2 belongs to a model that is down — out of claim, into fallback");
});

test("plan: a model mid-start (not serving yet) already claims its cluster", () => {
  // isHeld is fed by status.running OR a mutating job in flight — the plan
  // only knows the predicate, so test the wiring at reconcile level instead.
  const plan = planClusterRoles([MODEL_TP2_A], asHeld(["tp2a"]));
  assert.equal(plan.get("spark2").role, "worker");
});

test("diff: worker released to standalone re-arms its LLM monitoring", () => {
  const worker = { role: "worker", workerHeadId: "spark1", workerLabel: "TP4 4-way", llmMonitoring: false };
  assert.deepEqual(diffSparkRole(worker, { role: "standalone", workerHeadId: null, workerLabel: null }), {
    role: "standalone",
    llmMonitoring: true,
  });
});

test("diff: aligned units need no patch at all", () => {
  const head = { role: "head" };
  assert.equal(diffSparkRole(head, { role: "head", workerHeadId: null, workerLabel: null }), null);
  const worker = { role: "worker", workerHeadId: "spark1", workerLabel: "TP2 left", llmMonitoring: false };
  assert.equal(diffSparkRole(worker, { role: "worker", workerHeadId: "spark1", workerLabel: "TP2 left" }), null);
});

test("plan: remote-launch kit — scripts on spark1, cluster heads from spark3", () => {
  // GLM's repo lives on spark1; start.sh boots the cluster on 3+4, 3 leading.
  const glm = { id: "glm", name: "GLM remote", sparkId: "spark1", nodes: ["spark3", "spark4"], headSparkId: "spark3", position: 5 };
  const plan = planClusterRoles([glm], asHeld(["glm"]));
  assert.deepEqual(plan.get("spark3"), { role: "head", workerHeadId: null, workerLabel: null });
  assert.deepEqual(plan.get("spark4"), { role: "worker", workerHeadId: "spark3", workerLabel: "GLM remote" });
  assert.equal(plan.has("spark1"), false, "the script host runs nothing — no claim, no role change");
});

test("reconcile: remote-launch GLM leaves the script Spark alone", () => {
  const sparks = {
    spark1: { role: "standalone", llmMonitoring: true }, // script host, unheld
    spark3: { role: "head", llmMonitoring: true }, // hand-set from an earlier run
    spark4: { role: "standalone", llmMonitoring: true },
  };
  const glm = { id: "glm", name: "GLM remote", sparkId: "spark1", nodes: ["spark3", "spark4"], headSparkId: "spark3", position: 1 };
  const coord = new ClusterRoleCoordinator({
    getModels: () => [glm],
    status: () => ({ glm: { running: true } }),
    jobRunning: () => false,
    getSpark: (id) => sparks[id] ?? null,
    updateSpark: (id, patch) => Object.assign(sparks[id], patch),
    log: () => {},
  });
  const changed = coord.reconcile();
  assert.equal(sparks.spark3.role, "head", "declared head leads");
  assert.equal(sparks.spark4.role, "worker");
  assert.equal(sparks.spark4.workerHeadId, "spark3");
  assert.equal(sparks.spark4.workerLabel, "GLM remote");
  assert.equal(sparks.spark1.role, "standalone", "spark1 is not in the occupancy — untouched");
  assert.equal(changed, 1, "spark3 was already head; only spark4 needed a patch");
});

test("diff: retargeting a worker repoints its head and label", () => {
  const worker = { role: "worker", workerHeadId: "spark1", workerLabel: "TP4 4-way", llmMonitoring: false };
  assert.deepEqual(diffSparkRole(worker, { role: "worker", workerHeadId: "spark3", workerLabel: "TP2 right" }), {
    workerHeadId: "spark3",
    workerLabel: "TP2 right",
  });
});

test("reconcile: the TP4 → 2×TP2 → TP2-right rotation moves the cards with the models", () => {
  const sparks = {
    spark1: { role: "standalone", llmMonitoring: true },
    spark2: { role: "standalone", llmMonitoring: true },
    spark3: { role: "standalone", llmMonitoring: true },
    spark4: { role: "standalone", llmMonitoring: true },
    spark5: { role: "worker", workerHeadId: "spark1", workerLabel: "old", llmMonitoring: false }, // outside every model — never touched
  };
  const models = [MODEL_TP4, MODEL_TP2_A, MODEL_TP2_B];
  const status = {};
  const jobRunning = { current: new Set() };
  const coord = new ClusterRoleCoordinator({
    getModels: () => models,
    status: () => status,
    jobRunning: (id) => jobRunning.current.has(id),
    getSpark: (id) => sparks[id] ?? null,
    updateSpark: (id, patch) => Object.assign(sparks[id], patch),
    log: () => {},
  });

  // 1. TP4 up: 1 head, 2–4 workers of it.
  status.tp4 = { running: true };
  coord.reconcile();
  assert.equal(sparks.spark1.role, "head");
  assert.equal(sparks.spark2.role, "worker");
  assert.equal(sparks.spark2.workerHeadId, "spark1");
  assert.equal(sparks.spark2.workerLabel, "TP4 4-way");
  assert.equal(sparks.spark4.workerLabel, "TP4 4-way");

  // 2. TP4 down, TP2-A starts (job in flight): 1+2 held, 3+4 back to standalone.
  delete status.tp4;
  jobRunning.current.add("tp2a");
  coord.reconcile();
  assert.equal(sparks.spark1.role, "head");
  assert.equal(sparks.spark2.role, "worker");
  assert.equal(sparks.spark2.workerLabel, "TP2 left");
  assert.equal(sparks.spark3.role, "standalone", "freed by the stopped TP4");
  assert.equal(sparks.spark3.llmMonitoring, true, "a freed unit probes its LLM again");
  assert.equal(sparks.spark4.role, "standalone");
  // The unit no model names keeps its hand-set role.
  assert.equal(sparks.spark5.role, "worker");

  // 3. TP2-B up: 3 becomes the second head, 4 its worker; the left pair is untouched.
  jobRunning.current.delete("tp2a");
  status.tp2a = { running: true };
  status.tp2b = { running: true };
  coord.reconcile();
  assert.equal(sparks.spark1.role, "head");
  assert.equal(sparks.spark2.workerLabel, "TP2 left");
  assert.equal(sparks.spark3.role, "head");
  assert.equal(sparks.spark4.role, "worker");
  assert.equal(sparks.spark4.workerHeadId, "spark3");
  assert.equal(sparks.spark4.workerLabel, "TP2 right");

  // 4. Everything stopped: managed units fall back, the foreign worker stays.
  delete status.tp2a;
  delete status.tp2b;
  coord.reconcile();
  for (const id of ["spark1", "spark2", "spark3", "spark4"]) {
    assert.equal(sparks[id].role, "standalone", `${id} freed`);
  }
  assert.equal(sparks.spark5.role, "worker");
});

test("reconcile: no-op passes never rewrite sparks.json (byte-stable quiet fleet)", () => {
  const sparks = {
    spark1: { role: "head", llmMonitoring: true },
    spark2: { role: "worker", workerHeadId: "spark1", workerLabel: "TP2 left", llmMonitoring: false },
  };
  const coord = new ClusterRoleCoordinator({
    getModels: () => [MODEL_TP2_A],
    status: () => ({ tp2a: { running: true } }),
    jobRunning: () => false,
    getSpark: (id) => sparks[id] ?? null,
    updateSpark: () => assert.fail("must not write an aligned fleet"),
    log: () => {},
  });
  assert.equal(coord.reconcile(), 0);
});

test("reconcile: inert without the updateSpark hook (tests, standalone use)", () => {
  const coord = new ClusterRoleCoordinator({
    getModels: () => [MODEL_TP2_A],
    status: () => ({ tp2a: { running: true } }),
    getSpark: () => ({ role: "standalone" }),
  });
  assert.equal(coord.reconcile(), 0);
});

test("reconcile: a removed Spark is skipped, not fatal", () => {
  const coord = new ClusterRoleCoordinator({
    getModels: () => [MODEL_TP2_A],
    status: () => ({ tp2a: { running: true } }),
    getSpark: (id) => (id === "spark1" ? { role: "standalone", llmMonitoring: true } : null),
    updateSpark: (id) => {
      if (id === "spark2") throw new Error("Spark spark2 not found");
    },
    log: () => {},
  });
  assert.doesNotThrow(() => coord.reconcile());
});
