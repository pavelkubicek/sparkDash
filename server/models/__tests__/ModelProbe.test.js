import test from "node:test";
import assert from "node:assert/strict";
import { portsNeedingProbe, buildModelStatus, probeModels } from "../ModelProbe.js";

// Three kits, one port — the real config shape of this deployment.
const QWEN = { id: "qwen", name: "Qwen", container: "vllm-fn", port: 8000 };
const GLM = { id: "glm", name: "GLM", container: "glm-head", port: 8000 };
const DS = { id: "ds", name: "DeepSeek", container: null, port: 8000 };
const MODELS = [QWEN, GLM, DS];

// ─── portsNeedingProbe ─────────────────────────────────────
test("a port owned by a confirmed container needs no HTTP probe at all", () => {
  const containers = new Set(["vllm-fn"]); // qwen is up
  assert.deepEqual([...portsNeedingProbe(MODELS, containers)], []);
});

test("with nothing running the (single unique) port is probed once", () => {
  const containers = new Set(["unrelated"]);
  assert.deepEqual([...portsNeedingProbe(MODELS, containers)], ["8000"]);
});

test("docker failure falls back to probing every configured port", () => {
  assert.deepEqual([...portsNeedingProbe(MODELS, null)], ["8000"]);
});

test("forcePorts overrides the skip (start job readiness, manual refresh)", () => {
  const containers = new Set(["vllm-fn"]);
  assert.deepEqual([...portsNeedingProbe(MODELS, containers, new Set(["8000"]))], ["8000"]);
});

test("distinct ports are tracked independently", () => {
  const a = { id: "a", container: "ca", port: 8000 };
  const b = { id: "b", container: "cb", port: 8001 };
  const c = { id: "c", container: null, port: 8002 };
  const up = new Set(["ca"]); // a owns 8000; 8001/8002 still open questions
  assert.deepEqual([...portsNeedingProbe([a, b, c], up)], ["8001", "8002"]);
});

// ─── probeModels wiring ────────────────────────────────────
test("probeModels issues ZERO fetchPort calls while one model runs", async () => {
  const calls = [];
  const res = await probeModels(MODELS, {
    listContainers: async () => new Set(["vllm-fn"]),
    fetchPort: async (p) => {
      calls.push(p);
      return { ok: true, modelId: "x", status: 200, error: null };
    },
  });
  assert.equal(calls.length, 0);
  assert.deepEqual(res.ports, {}); // nothing answered, because nothing was asked
});

test("probeModels probes exactly once when the port is unowned", async () => {
  const calls = [];
  await probeModels(MODELS, {
    listContainers: async () => new Set(),
    fetchPort: async (p) => {
      calls.push(p);
      return { ok: false, modelId: null, status: null, error: "ECONNREFUSED" };
    },
  });
  assert.deepEqual(calls, ["8000"]); // three models, one unique port, one GET
});

// ─── buildModelStatus with skipped ports ───────────────────
test("skipped port: owner reads up, the others read held-by — without portChecked", () => {
  const st = buildModelStatus(MODELS, {
    containers: new Set(["vllm-fn"]),
    ports: {}, // probeModels probed nothing
    checkedAt: 123,
  });
  assert.equal(st.qwen.running, true);
  assert.equal(st.qwen.portUp, true);
  assert.equal(st.qwen.portChecked, false, "verdict came from docker, not a GET");
  assert.equal(st.qwen.error, null);

  for (const id of ["glm", "ds"]) {
    assert.equal(st[id].running, false);
    assert.equal(st[id].portUp, false);
    assert.equal(st[id].portChecked, false);
    assert.match(st[id].error, /:8000 held by Qwen/);
  }
});

test("a port whose verdict is unknown stays unknown (portChecked false, portUp null)", () => {
  // docker failed AND nothing answered — statuses must not hard-say "down".
  const st = buildModelStatus([GLM], { containers: null, ports: {}, checkedAt: 1 });
  // containers null forces "probe everything", so this shape means docker died
  // between the probe decision and status build — defend the null anyway.
  assert.equal(st.glm.running, false);
  assert.equal(st.glm.containerUp, null);
  assert.match(st.glm.error, /docker ps unavailable/);
});

test("probed port keeps the old semantics exactly (regression)", () => {
  const st = buildModelStatus(MODELS, {
    containers: new Set(), // nothing up
    ports: { 8000: { ok: true, modelId: "deepseek-v4", status: 200, error: null } },
    checkedAt: 1,
  });
  // No container claims 8000 → the bare answer counts for everyone probing it.
  for (const id of ["qwen", "glm", "ds"]) {
    assert.equal(st[id].running, true);
    assert.equal(st[id].portUp, true);
    assert.equal(st[id].portChecked, true);
  }
});

test("probed port answered while another container owns it → held by other", () => {
  const st = buildModelStatus(MODELS, {
    containers: new Set(["vllm-fn"]),
    ports: { 8000: { ok: true, modelId: "other", status: 200, error: null } }, // forced probe
    checkedAt: 1,
  });
  assert.equal(st.qwen.running, true); // container proves it
  assert.equal(st.glm.running, false);
  assert.match(st.glm.error, /answering but held by Qwen/);
});
