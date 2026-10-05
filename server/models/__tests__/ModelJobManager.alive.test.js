import test from "node:test";
import assert from "node:assert/strict";
import os from "os";
import fs from "fs";
import path from "path";
import { ModelJobManager } from "../ModelJobManager.js";
import { spawnOnTarget } from "../hostExec.js";

const LOCAL = { id: "loc", name: "local", lanIp: "127.0.0.1", isLocal: true, ssh: null };
// No ssh config + isLocal → spawnOnHost's plain `sh -c` fallback — a real spawn
// with no network and no docker involved.

const GLM = {
  id: "glm",
  name: "GLM",
  dir: "/repos/glm",
  startScript: "start.sh",
  stopScript: "stop.sh",
  restartScript: null,
  logsScript: null,
  startArgs: [],
  container: "glm53-flash-tf",
  port: 8000,
  sparkId: "loc",
};

function makeManager(model) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modeljobs-alive-"));
  return new ModelJobManager({
    activePath: path.join(dir, "active.json"),
    getModel: () => model,
    getSpark: () => LOCAL,
  });
}

/** A real model dir whose script prints one line, slowly enough to poll mid-run. */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modelrepo-"));
  fs.writeFileSync(path.join(dir, "slow-logs.sh"), "#!/bin/sh\necho line-one\nsleep 5\n");
  return dir;
}

// ─── alive: spawned liveness, not job status ───────────────
test("spawnOnTarget reports the live child through onSpawn and it dies with the command", async () => {
  let child = null;
  const res = await spawnOnTarget({ kind: "local", key: "local:loc", label: "local" }, "exit 0", {
    onSpawn: (c) => (child = c),
  });
  assert.equal(res.code, 0);
  assert.ok(child, "onSpawn fired after a successful spawn");
  assert.equal(child.pid > 0, true);

  // A failed resolution never spawns → the hook must not fire.
  let never = null;
  await spawnOnTarget({ kind: null, error: "nope" }, "exit 0", { onSpawn: (c) => (never = c) });
  assert.equal(never, null);
});

test("a running tail exposes alive=true; after it settles alive flips false — a silent-but-healthy tail is distinguishable from a dead one", async () => {
  const dir = makeRepo();
  const m = makeManager({ ...GLM, dir, logsScript: "slow-logs.sh" });
  const { jobId } = m.start("glm", "logs");

  // Mid-run: the ssh/sh process is still attached.
  const running = m.getJob(jobId);
  assert.equal(running.status, "running");
  assert.equal(running.alive, true, "alive while the spawned process runs");

  m.cancel(jobId);
  await m.jobs.get(jobId).done;

  const settled = m.getJob(jobId);
  assert.equal(settled.status, "cancelled");
  assert.equal(settled.alive, false, "alive=false once the process is gone");

  // Output arrived → the cursor advanced past the start.
  assert.ok((settled.totalChars ?? 0) > 0);
  assert.ok(settled.lastOutputAt >= settled.startedAt);
});

test("a job that was never spawned here (recovered record) reports alive=null, not false", () => {
  const m = makeManager(GLM);
  const { jobId } = m.start("glm", "logs");
  // Simulate the boot-recovery shape: the record is public, no _child handle.
  const job = m.jobs.get(jobId);
  delete job._child;
  assert.equal(m.peek(jobId).alive, null);
});

test("lastOutputAt only moves when output actually arrives", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modelrepo-silent-"));
  // A tail that produces nothing: liveness must hold while lastOutputAt stays.
  fs.writeFileSync(path.join(dir, "silent.sh"), "#!/bin/sh\nsleep 5\n");
  const m = makeManager({ ...GLM, dir, logsScript: "silent.sh" });
  const { jobId } = m.start("glm", "logs");
  const job = m.jobs.get(jobId);
  const startedAt = job.lastOutputAt;

  await new Promise((r) => setTimeout(r, 120));
  const polled = m.getJob(jobId);
  assert.equal(polled.alive, true, "silent tail is still attached");
  assert.equal(job.lastOutputAt, startedAt, "no new lines → no new lastOutputAt");
  m.cancel(jobId);
  await job.done;
});
