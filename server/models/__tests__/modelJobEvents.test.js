import test from "node:test";
import assert from "node:assert/strict";
import os from "os";
import fs from "fs";
import path from "path";
import { ModelJobManager } from "../ModelJobManager.js";
import { ModelScheduler } from "../ModelScheduler.js";

/**
 * The Model Loader must land in the fleet event log (Activity page) the way the
 * per-Spark LLM launcher does: one `model.<action>.requested` per accepted job,
 * one terminal `model.<action>.<stage>` per finished job, `model.job.recovered`
 * for a checkpoint promoted at boot, and the scheduler's own
 * `model.schedule.*` decisions — with a cooldown on repeats.
 *
 * Isolation follows the sibling tests: every path the modules write goes to a
 * fresh temp dir through the constructor options (activePath / statePath), so
 * nothing here can read or touch the live config/ files.
 *
 * Takeover chains (startExclusive) additionally log EVERY incumbent they
 * stop: a chained `model.stop.requested` per stop step before the target's
 * start event, and a terminal `model.stop.<stage>` per step at settle,
 * attributed chunk by chunk (fail-closed — an unproven stop never says
 * finished).
 */

// isLocal + no ssh config → spawnOnHost's plain `sh -c` path: a real spawn with
// no network and no docker involved (same trick as ModelJobManager.alive.test.js).
const LOCAL = { id: "loc", name: "local", lanIp: "127.0.0.1", isLocal: true, ssh: null };

function model(over = {}) {
  return {
    id: "glm",
    name: "GLM",
    dir: "/repos/glm",
    startScript: "start.sh",
    stopScript: "stop.sh",
    restartScript: "restart.sh",
    logsScript: "logs.sh",
    startArgs: [],
    container: "glm-head",
    port: 8000,
    sparkId: "loc",
    ...over,
  };
}

/** A repo dir whose scripts are real files with the given bodies. */
function repo(scripts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-events-repo-"));
  for (const [name, body] of Object.entries(scripts)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

/** Manager on a temp checkpoint path, collecting everything it emits. */
function makeManager(models, { sparks = { loc: LOCAL }, onEvent, onChange } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-events-"));
  const events = [];
  const m = new ModelJobManager({
    activePath: path.join(dir, "active.json"),
    getModel: (id) => models.find((x) => x.id === id) || null,
    getSpark: (id) => sparks[id] || null,
    onEvent: onEvent || ((e) => events.push(e)),
    onChange: onChange || (() => {}),
  });
  return { m, events };
}

/** No host exec: the request-side tests only need the accepted-job path. */
function stubSpawn(m) {
  m._spawnJob = async () => {};
}

// Extra isLocal Sparks: distinct ids → distinct resolveRunTarget keys
// ("local:loc2"…), so a chain whose models live on them really splits into
// several chunks (same convention as the alive/ssh tests' spark maps).
const LOCAL2 = { id: "loc2", name: "local2", lanIp: "127.0.0.1", isLocal: true, ssh: null };
const LOCAL3 = { id: "loc3", name: "local3", lanIp: "127.0.0.1", isLocal: true, ssh: null };
const LOCAL4 = { id: "loc4", name: "local4", lanIp: "127.0.0.1", isLocal: true, ssh: null };
const LOCALS = { loc: LOCAL, loc2: LOCAL2, loc3: LOCAL3, loc4: LOCAL4 };

/** Resolve once the running job's transcript contains `needle` (real spawns). */
function waitForTranscript(job, needle, budgetMs = 15_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const text = job.transcript.read(null).text;
      if (text.includes(needle)) return resolve();
      if (job.status !== "running") {
        return reject(new Error(`job settled before "${needle}" appeared:\n${text}`));
      }
      if (Date.now() - started > budgetMs) {
        return reject(new Error(`transcript never showed "${needle}":\n${text}`));
      }
      setTimeout(tick, 15);
    };
    tick();
  });
}

// ─── requested events ─────────────────────────────────────
test("start() records exactly one model.start.requested (info) naming the model", () => {
  const dir = repo({ "start.sh": "#!/bin/sh\necho up\n" });
  const { m, events } = makeManager([model({ dir })]);
  stubSpawn(m);
  const { jobId } = m.start("glm", "start");

  assert.equal(events.length, 1, "a job that is still running has no terminal event yet");
  const e = events[0];
  assert.equal(e.type, "model.start.requested");
  assert.equal(e.severity, "info");
  assert.equal(e.message, "Starting GLM");
  assert.equal(e.sparkId, "loc", "the model's Spark rides along so the Activity filter finds it");
  assert.deepEqual(e.data, { modelId: "glm", action: "start", source: "manual", jobId });
});

test("stop / restart / logs each announce themselves with the launcher's verbs", () => {
  const dir = repo({ "stop.sh": "#!/bin/sh\n", "restart.sh": "#!/bin/sh\n", "logs.sh": "#!/bin/sh\n" });
  // One manager per action: a stubbed (never-settling) stop would otherwise
  // hold the Spark claim and 409 the restart behind it.
  const lines = [];
  for (const action of ["stop", "restart", "logs"]) {
    const { m, events } = makeManager([model({ dir })]);
    stubSpawn(m);
    m.start("glm", action);
    lines.push(...events.map((e) => [e.type, e.severity, e.message]));
  }
  assert.deepEqual(
    lines,
    [
      ["model.stop.requested", "info", "Stopping GLM"],
      ["model.restart.requested", "info", "Restarting GLM"],
      ["model.logs.requested", "info", "Opening output of GLM"],
    ]
  );
});

test("startExclusive() logs a chained stop per incumbent and carries stopFirstIds on the start", () => {
  const dir = repo({ "start.sh": "#!/bin/sh\n", "stop.sh": "#!/bin/sh\n" });
  const ds = model({ id: "ds", name: "DeepSeek", container: "ds-head", dir });
  const { m, events } = makeManager([model({ dir }), ds]);
  stubSpawn(m);
  const { jobId } = m.startExclusive("glm", ["ds"], { source: "scheduler" });

  // The stops come first, then the target's own event — in chain order.
  assert.deepEqual(events.map((e) => e.type), ["model.stop.requested", "model.start.requested"]);
  assert.deepEqual(
    [events[0].severity, events[0].message, events[0].sparkId],
    ["info", "Stopping DeepSeek", "loc"],
    "the launcher's own verb, on the INCUMBENT's Spark"
  );
  assert.deepEqual(events[0].data, {
    modelId: "ds",
    action: "stop",
    source: "scheduler",
    jobId,
    chained: true,
  });
  assert.equal(events[1].message, "Starting GLM");
  assert.deepEqual(events[1].data, {
    modelId: "glm",
    action: "start",
    source: "scheduler",
    jobId,
    stopFirstIds: ["ds"],
  });
});

// ─── takeover-chain stop events ───────────────────────────
test("a happy chain logs every stop before the start and one terminal per stop", async () => {
  const dirT = repo({ "start.sh": "#!/bin/sh\necho serving\n" });
  const dirA = repo({ "stop.sh": "#!/bin/sh\necho alpha down\n" });
  const dirB = repo({ "stop.sh": "#!/bin/sh\necho beta down\n" });
  const models = [
    model({ dir: dirT }),
    model({ id: "alpha", name: "Alpha", dir: dirA, sparkId: "loc2", container: "alpha-head", port: 8001 }),
    model({ id: "beta", name: "Beta", dir: dirB, sparkId: "loc3", container: "beta-head", port: 8002 }),
  ];
  const { m, events } = makeManager(models, { sparks: LOCALS });
  // Three Sparks → three chunks, exercising per-chunk attribution.
  const { jobId } = m.startExclusive("glm", ["alpha", "beta"], { source: "pr-companion" });
  await m.jobs.get(jobId).done;

  assert.deepEqual(events.map((e) => e.type), [
    "model.stop.requested",
    "model.stop.requested",
    "model.start.requested",
    "model.start.finished",
    "model.stop.finished",
    "model.stop.finished",
  ], "the ring reads the stops, then the start; terminals match the chain's order");

  assert.deepEqual(
    events.slice(0, 2).map((e) => [e.severity, e.message, e.sparkId]),
    [
      ["info", "Stopping Alpha", "loc2"],
      ["info", "Stopping Beta", "loc3"],
    ]
  );
  for (const e of events.slice(0, 2)) {
    assert.equal(e.data.chained, true);
    assert.equal(e.data.jobId, jobId, "one job did the whole chain");
    assert.equal(e.data.source, "pr-companion");
    assert.equal(e.data.action, "stop");
  }
  assert.equal(events[0].data.modelId, "alpha");
  assert.equal(events[1].data.modelId, "beta");

  assert.equal(events[3].message, "GLM: start script finished", "the target's own terminal still fires");
  assert.deepEqual(
    events.slice(4).map((e) => [e.severity, e.message]),
    [
      ["success", "Alpha: stop script finished"],
      ["success", "Beta: stop script finished"],
    ]
  );
  for (const e of events.slice(4)) {
    assert.equal(e.data.chained, true);
    assert.equal(e.data.jobId, jobId);
    assert.equal(e.data.chainJobStatus, "done");
    assert.ok(!("chainError" in e.data), "a proven stop carries no error");
  }
});

test("a failing stop fails only its own chunk; later chunks still run and report their own outcome", async () => {
  // Beta's stop fails (exit 3) and GLM's start then hits the port Beta still
  // holds (exit 9) — the last chunk's failure is what the job settles on.
  const dirT = repo({ "start.sh": "#!/bin/sh\nexit 9\n" });
  const dirA = repo({ "stop.sh": "#!/bin/sh\n" });
  const dirB = repo({ "stop.sh": "#!/bin/sh\necho 'docker: no such container' >&2\nexit 3\n" });
  const dirC = repo({ "stop.sh": "#!/bin/sh\n" });
  const models = [
    model({ dir: dirT }),
    model({ id: "alpha", name: "Alpha", dir: dirA, sparkId: "loc2", container: "a", port: 8001 }),
    model({ id: "beta", name: "Beta", dir: dirB, sparkId: "loc3", container: "b", port: 8002 }),
    model({ id: "gamma", name: "Gamma", dir: dirC, sparkId: "loc4", container: "c", port: 8003 }),
  ];
  const { m, events } = makeManager(models, { sparks: LOCALS });
  const { jobId } = m.startExclusive("glm", ["alpha", "beta", "gamma"], { source: "manual" });
  await m.jobs.get(jobId).done;

  assert.deepEqual(events.map((e) => e.type), [
    "model.stop.requested",
    "model.stop.requested",
    "model.stop.requested",
    "model.start.requested",
    "model.start.failed",
    "model.stop.finished",
    "model.stop.failed",
    "model.stop.finished",
  ]);
  assert.deepEqual(
    events.slice(5).map((e) => [e.severity, e.message]),
    [
      ["success", "Alpha: stop script finished"],
      ["error", "Beta: stop script failed"],
      ["success", "Gamma: stop script finished"],
    ]
  );
  // Each chunk reports for itself: the chained commands are ";"-joined and
  // the chunk loop only breaks on cancel/timeout, so Gamma's chunk really
  // ran after Beta's failure — its exit 0 proves Gamma down (finished),
  // while Beta's non-zero chunk marks ITS steps failed (not proven down).
  assert.equal(events[5].data.chained, true);
  assert.equal(events[6].data.chained, true);
  assert.equal(events[6].data.jobId, jobId);
  assert.match(
    events[6].data.chainError,
    /exited with code 9/,
    "the chain's own failure rides along on the unproven stop"
  );
  assert.equal(events[7].data.chained, true);
  assert.ok(!("chainError" in events[7].data), "a stop its chunk proved carries no error");
  assert.equal(events[4].type, "model.start.failed", "the chain job's own terminal still fires");
});

test("cancelling a chain mid-flight settles every stop step as cancelled", async () => {
  const dirT = repo({ "start.sh": "#!/bin/sh\necho serving\ntail -f /dev/null\n" });
  const dirA = repo({ "stop.sh": "#!/bin/sh\nsleep 5\n" });
  const dirB = repo({ "stop.sh": "#!/bin/sh\nsleep 5\n" });
  const models = [
    model({ dir: dirT }),
    model({ id: "alpha", name: "Alpha", dir: dirA, sparkId: "loc2", container: "a", port: 8001 }),
    model({ id: "beta", name: "Beta", dir: dirB, sparkId: "loc3", container: "b", port: 8002 }),
  ];
  const { m, events } = makeManager(models, { sparks: LOCALS });
  const { jobId } = m.startExclusive("glm", ["alpha", "beta"], { source: "manual" });
  // Cancel before any chunk can complete: Alpha's chunk dies mid-flight
  // (attributed cancelled), Beta's chunk never resolves (falls back to the
  // job's cancelled outcome) — both must read as cancelled either way.
  m.cancel(jobId);
  await m.jobs.get(jobId).done;

  assert.deepEqual(events.map((e) => e.type), [
    "model.stop.requested",
    "model.stop.requested",
    "model.start.requested",
    "model.start.cancelled",
    "model.stop.cancelled",
    "model.stop.cancelled",
  ]);
  assert.equal(events[3].message, "GLM: start script cancelled", "the chain job's own terminal");
  assert.deepEqual(
    events.slice(4).map((e) => [e.severity, e.message]),
    [
      ["info", "Alpha: stop script cancelled"],
      ["info", "Beta: stop script cancelled"],
    ]
  );
  for (const e of events.slice(4)) {
    assert.equal(e.data.chained, true);
    assert.equal(e.data.jobId, jobId);
    assert.equal(e.data.chainJobStatus, "cancelled");
    assert.match(e.data.chainError, /Cancelled/);
  }
});

test("a chain released on readiness credits every stop step as finished", async () => {
  const dirT = repo({ "start.sh": "#!/bin/sh\necho serving\ntail -f /dev/null\n" });
  const dirA = repo({ "stop.sh": "#!/bin/sh\n" });
  const dirB = repo({ "stop.sh": "#!/bin/sh\n" });
  const models = [
    model({ dir: dirT }),
    model({ id: "alpha", name: "Alpha", dir: dirA, sparkId: "loc2", container: "a", port: 8001 }),
    model({ id: "beta", name: "Beta", dir: dirB, sparkId: "loc3", container: "b", port: 8002 }),
  ];
  const { m, events } = makeManager(models, { sparks: LOCALS });
  const { jobId } = m.startExclusive("glm", ["alpha", "beta"], { source: "scheduler" });
  const job = m.jobs.get(jobId);
  // Wait until the target's own script is the chunk in flight (its echo has
  // landed) — only then is the readiness release the real thing.
  await waitForTranscript(job, "serving");
  assert.equal(m.releaseReadyStart("glm"), true);
  await job.done;

  assert.deepEqual(events.map((e) => e.type), [
    "model.stop.requested",
    "model.stop.requested",
    "model.start.requested",
    "model.start.finished",
    "model.stop.finished",
    "model.stop.finished",
  ]);
  assert.equal(events[3].data.jobStatus, "done", "the readiness release is a success, not a cancel");
  assert.deepEqual(
    events.slice(4).map((e) => [e.severity, e.message]),
    [
      ["success", "Alpha: stop script finished"],
      ["success", "Beta: stop script finished"],
    ]
  );
});

test("a single-chunk chain charges its exit code to every stop step sharing the chunk", async () => {
  // The dominant UI shape: incumbents share the target's Spark → ONE chunk
  // [stop alpha; stop beta; start glm], ";"-joined. The chunk's exit code
  // is the LAST step's (the start's 9), and per-step codes are not
  // provable in one merged stream — so the chunk's failure decides for
  // every stop step in it: neither incumbent is proven down.
  const dirT = repo({ "start.sh": "#!/bin/sh\nexit 9\n" });
  const dirA = repo({ "stop.sh": "#!/bin/sh\n" });
  const dirB = repo({ "stop.sh": "#!/bin/sh\n" });
  const models = [
    model({ dir: dirT }),
    model({ id: "alpha", name: "Alpha", dir: dirA, container: "a", port: 8001 }),
    model({ id: "beta", name: "Beta", dir: dirB, container: "b", port: 8002 }),
  ];
  const { m, events } = makeManager(models);
  const { jobId } = m.startExclusive("glm", ["alpha", "beta"], { source: "manual" });
  await m.jobs.get(jobId).done;

  assert.deepEqual(events.map((e) => e.type), [
    "model.stop.requested",
    "model.stop.requested",
    "model.start.requested",
    "model.start.failed",
    "model.stop.failed",
    "model.stop.failed",
  ]);
  assert.deepEqual(
    events.slice(4).map((e) => [e.severity, e.message]),
    [
      ["error", "Alpha: stop script failed"],
      ["error", "Beta: stop script failed"],
    ],
    "no '(exit N)' — the step is not its own exit code, the chunk is"
  );
  for (const e of events.slice(4)) {
    assert.equal(e.data.chained, true);
    assert.equal(e.data.jobId, jobId);
    assert.match(e.data.chainError, /exited with code 9/);
  }
});

test("a single-chunk readiness release credits the stops sharing the target's chunk as finished", async () => {
  // Regression pin for the last-chunk gate in _attributeChainStops: the
  // release lands on the chain's ONLY chunk — the one holding both stops
  // and the target's tail. The ";-joined" command provably ran the stop
  // scripts before the tail that answered readiness, so the gated ready
  // branch must settle them finished; without it the aborted chunk would
  // report both stops "cancelled" — a lie.
  const dirT = repo({ "start.sh": "#!/bin/sh\necho serving\ntail -f /dev/null\n" });
  const dirA = repo({ "stop.sh": "#!/bin/sh\n" });
  const dirB = repo({ "stop.sh": "#!/bin/sh\n" });
  const models = [
    model({ dir: dirT }),
    model({ id: "alpha", name: "Alpha", dir: dirA, container: "a", port: 8001 }),
    model({ id: "beta", name: "Beta", dir: dirB, container: "b", port: 8002 }),
  ];
  const { m, events } = makeManager(models);
  const { jobId } = m.startExclusive("glm", ["alpha", "beta"], { source: "scheduler" });
  const job = m.jobs.get(jobId);
  await waitForTranscript(job, "serving");
  assert.equal(m.releaseReadyStart("glm"), true);
  await job.done;

  assert.deepEqual(events.map((e) => e.type), [
    "model.stop.requested",
    "model.stop.requested",
    "model.start.requested",
    "model.start.finished",
    "model.stop.finished",
    "model.stop.finished",
  ]);
  assert.equal(events[3].data.jobStatus, "done");
  assert.deepEqual(
    events.slice(4).map((e) => [e.severity, e.message]),
    [
      ["success", "Alpha: stop script finished"],
      ["success", "Beta: stop script finished"],
    ]
  );
});

test("a stale readiness release mid-stop-chunk settles stops cancelled/failed — never finished", async () => {
  // Gate pin for _attributeChainStops AND the never-finished edge of the
  // _emitChainStopTerminals fallback: releaseReadyStart has no sawDown gate
  // for plain starts, so a stale target container can answer the probe
  // while stop chunk 0 is still in flight. The release lands on a NON-final
  // chunk → the gate is false: Alpha's killed stop reports cancelled (not
  // the lie of finished), Beta's chunk never resolves → null → the done
  // job's fallback reports failed, because the chain never proved it.
  const dirT = repo({ "start.sh": "#!/bin/sh\necho serving\n" });
  const dirA = repo({ "stop.sh": "#!/bin/sh\nsleep 0.4\n" });
  const dirB = repo({ "stop.sh": "#!/bin/sh\n" });
  const models = [
    model({ dir: dirT }),
    model({ id: "alpha", name: "Alpha", dir: dirA, sparkId: "loc2", container: "a", port: 8001 }),
    model({ id: "beta", name: "Beta", dir: dirB, sparkId: "loc3", container: "b", port: 8002 }),
  ];
  const { m, events } = makeManager(models, { sparks: LOCALS });
  const { jobId } = m.startExclusive("glm", ["alpha", "beta"], { source: "manual" });
  // Immediate release — Alpha's sleep 0.4 keeps chunk 0 in flight, so the
  // abort lands there deterministically (same synchronous block, the child
  // cannot have closed yet).
  assert.equal(m.releaseReadyStart("glm"), true);
  await m.jobs.get(jobId).done;

  assert.deepEqual(events.map((e) => e.type), [
    "model.stop.requested",
    "model.stop.requested",
    "model.start.requested",
    "model.start.finished",
    "model.stop.cancelled",
    "model.stop.failed",
  ]);
  assert.equal(events[3].data.jobStatus, "done", "the release still settles the JOB done");
  assert.deepEqual(
    events.slice(4).map((e) => [e.severity, e.message]),
    [
      ["info", "Alpha: stop script cancelled"],
      ["error", "Beta: stop script failed"],
    ],
    "killed-in-flight → cancelled; never-run and unproven → failed; finished is off the table"
  );
  for (const e of events.slice(4)) {
    assert.equal(e.data.chained, true);
    assert.equal(e.data.jobId, jobId);
    // A ready-settled job carries no error, so the non-finished events
    // expose the key as null rather than a bogus reason.
    assert.equal(e.data.chainError, null);
  }
});

// ─── terminal events (real exit codes) ────────────────────
test("a start script that exits non-zero settles as model.start.failed (error), once", async () => {
  const dir = repo({ "start.sh": "#!/bin/sh\necho boom >&2\nexit 3\n" });
  const { m, events } = makeManager([model({ dir })]);
  const { jobId } = m.start("glm", "start");
  await m.jobs.get(jobId).done;

  assert.deepEqual(events.map((e) => e.type), ["model.start.requested", "model.start.failed"]);
  const e = events[1];
  assert.equal(e.severity, "error");
  assert.equal(e.message, "GLM: start script failed (exit 3)");
  assert.equal(e.data.jobId, jobId);
  assert.equal(e.data.exitCode, 3);
  assert.equal(e.data.jobStatus, "done", "job status ignores the code; the event must not");
});

test("a start script that exits 0 settles as model.start.finished (success)", async () => {
  const dir = repo({ "start.sh": "#!/bin/sh\necho serving\n" });
  const { m, events } = makeManager([model({ dir })]);
  const { jobId } = m.start("glm", "start");
  await m.jobs.get(jobId).done;

  assert.deepEqual(events.map((e) => e.type), ["model.start.requested", "model.start.finished"]);
  assert.equal(events[1].severity, "success");
  assert.equal(events[1].message, "GLM: start script finished");
  assert.equal(events[1].data.exitCode, 0);
});

test("a cancelled job mirrors the launcher's cancelled severity (info), emitted once", async () => {
  const dir = repo({ "start.sh": "#!/bin/sh\necho line\nsleep 5\n" });
  const { m, events } = makeManager([model({ dir })]);
  const { jobId } = m.start("glm", "start");
  m.cancel(jobId);
  await m.jobs.get(jobId).done;
  // The once-only guard: a second terminal emission for the same job is dropped.
  m._emitTerminal(m.jobs.get(jobId));
  m._emitTerminal(m.jobs.get(jobId));

  const terminal = events.filter((e) => e.type.startsWith("model.start.") && e.type !== "model.start.requested");
  assert.equal(terminal.length, 1, JSON.stringify(events.map((e) => e.type)));
  assert.equal(terminal[0].type, "model.start.cancelled");
  assert.equal(terminal[0].severity, "info");
  assert.equal(terminal[0].message, "GLM: start script cancelled");
});

// ─── boot recovery ────────────────────────────────────────
test("an interrupted checkpoint promotes to model.job.recovered (warn) per job", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-events-recover-"));
  const activePath = path.join(dir, "active.json");
  fs.writeFileSync(
    activePath,
    JSON.stringify({
      jobs: [
        { jobId: "job-1", modelId: "glm", model: "GLM", action: "start", status: "running", source: "manual", nodes: ["loc"], sparkId: "sparkSnap" },
        { jobId: "job-2", modelId: "ds", model: "DeepSeek", action: "stop", status: "running", source: "scheduler", nodes: ["loc"] },
        { jobId: "job-3", modelId: "gone", model: "Gone", action: "restart", status: "running", source: "manual", nodes: ["loc"] },
      ],
    })
  );
  const events = [];
  new ModelJobManager({
    activePath,
    getModel: (id) => (id === "ds" ? { id: "ds", name: "DeepSeek", sparkId: "sparkReg" } : null),
    getSpark: () => null,
    onEvent: (e) => events.push(e),
  });

  assert.deepEqual(
    events.map((e) => [e.type, e.severity]),
    [
      ["model.job.recovered", "warn"],
      ["model.job.recovered", "warn"],
      ["model.job.recovered", "warn"],
    ]
  );
  assert.match(events[0].message, /^GLM: interrupted start job/);
  assert.equal(events[0].data.modelId, "glm");
  assert.equal(events[0].data.jobId, "job-1");
  assert.match(events[1].message, /DeepSeek: interrupted stop job/);
  // Checkpoints written by publicJob carry no sparkId: the snapshot wins when
  // it has one, the registry fills it in otherwise, and a deleted card is null.
  assert.equal(events[0].sparkId, "sparkSnap");
  assert.equal(events[1].sparkId, "sparkReg");
  assert.equal(events[2].sparkId, null);
  assert.equal(events[2].data.modelId, "gone");
});

test("a throwing event sink never breaks a job path", () => {
  const dir = repo({ "start.sh": "#!/bin/sh\n" });
  const { m } = makeManager([model({ dir })], {
    onEvent: () => {
      throw new Error("event log is down");
    },
  });
  stubSpawn(m);
  assert.doesNotThrow(() => m.start("glm", "start"));
});

// ─── the state-change hook that sits next to onEvent ──────
test("the onChange hook ModelLauncher passes for the WS broadcast really fires", async () => {
  const dir = repo({ "start.sh": "#!/bin/sh\necho up\n" });
  let changes = 0;
  const { m, events } = makeManager([model({ dir })], { onChange: () => changes++ });
  // A fresh manager has no notify timestamp, so the 250 ms throttle is cold.
  const { jobId } = m.start("glm", "start");
  assert.ok(changes >= 1, "accepting a job must notify the server (the hook was declared but never assigned)");
  await m.jobs.get(jobId).done; // settling notifies again, unthrottled
  assert.ok(changes >= 2, `settling notifies too (got ${changes})`);
  assert.equal(events.at(-1).type, "model.start.finished", "the job still settles normally");
});

// ─── scheduler events + anti-spam ─────────────────────────
const TZ = "Europe/Prague";
/** Weekday 2026-01-05 02:00 local, inside an 18:00→08:00 night window. */
const NIGHT_NOW = Date.UTC(2026, 0, 5, 1, 0, 0);

/** jobs.start throws `fail` for every call; records how often it was asked. */
class FailingJobs {
  constructor(fail) {
    this.jobs = new Map();
    this.fail = fail;
    this.calls = [];
  }
  start(modelId, action, meta) {
    this.calls.push({ modelId, action, source: meta?.source });
    if (this.fail) throw new Error(this.fail);
    const jobId = `job-${this.calls.length}`;
    this.jobs.set(jobId, { done: Promise.resolve() });
    return { jobId };
  }
}

function makeScheduler({ jobs, models, status, clock }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-events-sched-"));
  const registry = {
    models,
    getModel(id) {
      return this.models.find((m) => m.id === id) || null;
    },
  };
  const events = [];
  const sched = new ModelScheduler({
    registry,
    jobs,
    status: () => status,
    getConfig: () => ({ enabled: true, tz: TZ }),
    statePath: path.join(dir, "state.json"),
    tz: TZ,
    log: () => {},
    onEvent: (e) => events.push(e),
    now: () => clock.value,
    eventCooldownMs: 10 * 60_000,
  });
  return { sched, events };
}

const NIGHT = [{ start: "18:00", end: "08:00" }];
// sparkId on the card is what every scheduler event must carry, so the Activity
// page filters by unit and recordEvent can resolve the sparkName.
const managed = (id, name, sparkId = "sparkA") => ({ id, name, sparkId, schedule: { enabled: true, weekday: NIGHT, weekend: [] } });
const unmanaged = (id, name) => ({ id, name, sparkId: "sparkB", schedule: { enabled: false, weekday: [], weekend: [] } });

test("the scheduler reports the start it initiates, and repeats of the SAME failure are throttled", async () => {
  const jobs = new FailingJobs("port 8000 already in use");
  const clock = { value: NIGHT_NOW };
  const { sched, events } = makeScheduler({ jobs, models: [managed("glm", "GLM")], status: {}, clock });

  for (const step of [0, 30_000, 60_000]) {
    clock.value = NIGHT_NOW + step;
    await sched.runTick(clock.value);
  }
  assert.equal(jobs.calls.length, 3, "the tick keeps trying; only the log line is throttled");
  assert.equal(events.length, 1, "30 s ticks must not flood the 2000-entry ring");
  const e = events[0];
  assert.equal(e.type, "model.schedule.start.failed");
  assert.equal(e.severity, "error");
  assert.equal(e.message, "Scheduled start of GLM failed: port 8000 already in use");
  assert.equal(e.sparkId, "sparkA", "the event is attributed to the model's Spark");
  assert.deepEqual(e.data, {
    modelId: "glm",
    action: "start",
    source: "scheduler",
    sparkId: "sparkA",
    error: "port 8000 already in use",
  });

  // A CHANGED reason is new information → emitted straight away again.
  jobs.fail = "Spark \"loc\" is offline";
  clock.value = NIGHT_NOW + 90_000;
  await sched.runTick(clock.value);
  assert.equal(events.length, 2);
  assert.equal(events[1].data.error, 'Spark "loc" is offline');

  // Same new reason again inside the cooldown → still one line for it.
  clock.value = NIGHT_NOW + 120_000;
  await sched.runTick(clock.value);
  assert.equal(events.length, 2);

  // Once the cooldown has passed the standing failure is worth saying again.
  clock.value = NIGHT_NOW + 90_000 + 10 * 60_000;
  await sched.runTick(clock.value);
  assert.equal(events.length, 3);
});

test("the scheduler reports its own actions once per cooldown; the per-job events carry every retry", async () => {
  const jobs = new FailingJobs(null);
  const clock = { value: NIGHT_NOW };
  const { sched, events } = makeScheduler({
    jobs,
    models: [managed("glm", "GLM"), unmanaged("other", "Other")],
    // GLM is the window owner and down (self-heal start); Other runs by hand.
    status: { other: { running: true } },
    clock,
  });

  // Blocked: the manually started model holds the GPU. Nothing is started, so
  // the decision is logged once (first occurrence) and then throttled.
  clock.value = NIGHT_NOW;
  await sched.runTick(clock.value);
  clock.value = NIGHT_NOW + 30_000;
  await sched.runTick(clock.value);
  assert.equal(jobs.calls.length, 0);
  assert.deepEqual(
    events.map((e) => [e.type, e.severity]),
    [["model.schedule.blocked", "warn"]]
  );
  assert.match(events[0].message, /^Cannot start GLM: Other running without a schedule/);
  assert.equal(events[0].sparkId, "sparkA", "the unit the start could not run on");
  assert.deepEqual(events[0].data.blockedBy, ["other"]);

  // The operator stops the manual one → the schedule swaps in its own model and
  // reports both halves of the swap, each on the Spark its card lives on.
  const free = new FailingJobs(null);
  const freeClock = { value: NIGHT_NOW };
  const second = makeScheduler({
    jobs: free,
    models: [managed("glm", "GLM", "sparkA"), managed("other", "Other", "sparkB")],
    status: { other: { running: true } },
    clock: freeClock,
  });
  await second.sched.runTick(freeClock.value);
  assert.deepEqual(
    second.events.map((e) => [e.type, e.severity, e.message, e.sparkId]),
    [
      ["model.schedule.stop", "info", "Scheduled stop of Other", "sparkB"],
      ["model.schedule.start", "info", "Scheduled start of GLM", "sparkA"],
    ]
  );
  assert.deepEqual(second.events[0].data, { modelId: "other", action: "stop", source: "scheduler", sparkId: "sparkB" });
  assert.deepEqual(second.events[1].data, { modelId: "glm", action: "start", source: "scheduler", sparkId: "sparkA" });

  // A start script that fails fast never flips the fake status, so every 30 s
  // tick re-accepts the same job. That retry is the job manager's story
  // (`model.start.requested` + terminal, one pair per job) — the scheduler's
  // own decision is a repeat and stays quiet until the cooldown passes.
  for (const step of [30_000, 60_000]) {
    freeClock.value = NIGHT_NOW + step;
    await second.sched.runTick(freeClock.value);
  }
  // 3 ticks so far (the first plus the two above) × stop + start each.
  assert.equal(free.calls.length, 6, "the window is still honoured on every tick");
  assert.equal(second.events.length, 2, "two more ticks, no new lines in the ring");

  freeClock.value = NIGHT_NOW + 10 * 60_000;
  await second.sched.runTick(freeClock.value);
  assert.equal(free.calls.length, 8, "and the retry past the cooldown ran too");
  assert.deepEqual(
    second.events.slice(2).map((e) => [e.type, e.message]),
    [
      ["model.schedule.stop", "Scheduled stop of Other"],
      ["model.schedule.start", "Scheduled start of GLM"],
    ],
    "past the cooldown the standing schedule says it again"
  );
});

test("a scheduler whose event sink throws still completes the tick", async () => {
  const jobs = new FailingJobs("nope");
  const clock = { value: NIGHT_NOW };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-events-sched-"));
  const models = [managed("glm", "GLM")];
  const sched = new ModelScheduler({
    registry: {
      models,
      getModel(id) {
        return models.find((m) => m.id === id) || null;
      },
    },
    jobs,
    status: () => ({}),
    getConfig: () => ({ enabled: true, tz: TZ }),
    statePath: path.join(dir, "state.json"),
    tz: TZ,
    log: () => {},
    onEvent: () => {
      throw new Error("event log is down");
    },
    now: () => clock.value,
  });
  const d = await sched.runTick(clock.value);
  assert.equal(d.action, "start");
});
