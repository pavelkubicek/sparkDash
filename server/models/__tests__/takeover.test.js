import test from "node:test";
import assert from "node:assert/strict";
import { planTakeover } from "../takeover.js";

// The operator's fleet: two TP2 models on Sparks 1+2 and 3+4, one TP4 across
// all four. Status helpers: proven down vs. the two failure modes of "not
// proven" (unknown verdict, or up).
const DOWN = { running: false, containerUp: false, portUp: false };
const UP = { running: true, containerUp: true, portUp: true, portChecked: true };
const UNKNOWN = { running: false, containerUp: null, portUp: null };

const TP2_A = { id: "tp2a", name: "TP2-A", sparkId: "spark1", nodes: ["spark1", "spark2"], port: 8000 };
const TP2_B = { id: "tp2b", name: "TP2-B", sparkId: "spark3", nodes: ["spark3", "spark4"], port: 8000 };
const TP4 = { id: "tp4", name: "TP4", sparkId: "spark1", nodes: ["spark1", "spark2", "spark3", "spark4"], port: 8000 };
const ALL = [TP2_A, TP2_B, TP4];

test("a second cluster on disjoint Sparks starts without asking — nothing is in its way", () => {
  const { incumbents } = planTakeover(ALL, { tp2a: UP, tp2b: UNKNOWN, tp4: DOWN }, TP2_B);
  assert.deepEqual(incumbents, [], "TP2-A lives on sparks 1+2, not TP2-B's 3+4");
});

test("a takeover lists every model sharing a Spark, with the shared units", () => {
  const { incumbents } = planTakeover(ALL, { tp2a: UP, tp2b: UP, tp4: DOWN }, TP4);
  assert.deepEqual(incumbents, [
    { id: "tp2a", name: "TP2-A", sparks: ["spark1", "spark2"] },
    { id: "tp2b", name: "TP2-B", sparks: ["spark3", "spark4"] },
  ]);
});

test("overlap decides, not mere existence: a model elsewhere that is not proven down is still nobody's business", () => {
  // TP2-A unknown AND running — TP4 still has it on its Sparks → incumbent.
  const a = planTakeover(ALL, { tp2a: UNKNOWN, tp2b: DOWN, tp4: DOWN }, TP4);
  assert.deepEqual(a.incumbents.map((i) => i.id), ["tp2a"]);
  // A model with unknown status OUTSIDE the overlap stays out of the list.
  const b = planTakeover(ALL, { tp2a: DOWN, tp2b: UNKNOWN, tp4: DOWN }, TP2_A);
  assert.deepEqual(b.incumbents, []);
});

test("uncertainty inside the overlap fails closed — only proof of down skips a stop", () => {
  // Container confirmed absent but the port was never answered — that is NOT
  // proof of down (loopback bind, probe timeout), so its stop.sh must run.
  const PORT_UNCHECKED = { running: false, containerUp: false, portUp: null };
  const { incumbents } = planTakeover(ALL, { tp2a: PORT_UNCHECKED, tp2b: DOWN, tp4: DOWN }, TP4);
  assert.deepEqual(incumbents.map((i) => i.id), ["tp2a"], "a missing port verdict is no proof of down");
});
test("head-only models overlap on their single Spark (nodes default)", () => {
  const soloA = { id: "sa", name: "Solo-A", sparkId: "spark1", nodes: [], port: 8000 };
  const soloB = { id: "sb", name: "Solo-B", sparkId: "spark2", nodes: [], port: 8000 };
  assert.deepEqual(planTakeover([soloA, soloB], { sb: UP }, soloA).incumbents, []);
  const clash = planTakeover([soloA, { ...soloB, sparkId: "spark1" }], { sa: UP }, { ...soloB, sparkId: "spark1" });
  assert.deepEqual(clash.incumbents.map((i) => i.id), ["sa"]);
});

test("a card the probe has never answered is not an incumbent — a fresh fleet starts freely", () => {
  assert.deepEqual(planTakeover(ALL, {}, TP4).incumbents, [], "no verdicts yet: nothing observed, nothing held");
  // A model whose own Spark went unplaceable cannot hold anything either.
  const unplaceable = { running: false, containerUp: null, portUp: null, portChecked: false, error: "No Spark assigned" };
  assert.deepEqual(planTakeover(ALL, { tp2b: unplaceable, tp2a: DOWN, tp4: DOWN }, TP4).incumbents, []);
  // Once actually observed, uncertainty counts again.
  const observed = { running: false, containerUp: null, portUp: null, portChecked: true };
  assert.deepEqual(planTakeover(ALL, { tp2b: observed, tp2a: DOWN, tp4: DOWN }, TP4).incumbents.map((i) => i.id), ["tp2b"]);
});
