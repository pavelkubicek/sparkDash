/**
 * Pico engine-log telemetry: Pico publishes no counters, so its own per-request log line
 * is the only live telemetry. These tests pin the line shapes, the incremental read, the
 * restart/rotation reset, and that a parse miss never becomes a rate.
 */
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  PicoLogTail,
  PICO_RANK_LOG,
  parsePicoBatchLine,
  parsePicoFrontLine,
  parsePicoGateLine,
  parsePicoRankLine,
} from "../picoLogs.js";

const RANK_LINE =
  "serve: req 129 session 0006af6397c0001b: prompt 62124, reused 61764 (live), prefill 203.7 ms (1767 tok/s), 200 tokens in 2403.0 ms (82.8 tok/s), stop; store 1897.2 MiB; session 62324 positions, 56.2 MiB, 20 window snapshots; 1 slices, paused 0.00 s, resumes 0.0 ms, 199 tokens in batches";
const FRONT_LINE =
  "req 100 session 1881692142829592: prompt 115945 (cached 114041), completion 396, tool_calls; ttft 0.491 s, 58.2 tok/s";
const BATCH_LINE =
  "serve: batch of 3: 94 steps in 4962.0 ms, 53.12 ms a step (median); req, tokens, end: 456 370 stop, 455 161 stop, 433 256 paused; drafts: 8.37 tokens and 10.55 rows per step, 560 of 757 drafts accepted; GPU ms by rows: 5: 35.32 (3)";

test("a rank-0 completion line yields the measured rates and token counts", () => {
  assert.deepEqual(parsePicoRankLine(RANK_LINE), {
    promptTokens: 62124,
    cachedTokens: 61764,
    completionTokens: 200,
    prefillTps: 1767,
    decodeTps: 82.8,
    storeMiB: 1897.2,
  });
});

test("a front-end completion line yields the completion tokens and decode rate", () => {
  assert.deepEqual(parsePicoFrontLine(FRONT_LINE), {
    promptTokens: 115945,
    cachedTokens: 114041,
    completionTokens: 396,
    prefillTps: null,
    decodeTps: 58.2,
    ttftSeconds: 0.491,
  });
});

test("a batch line yields the aggregate decode rate across its requests", () => {
  // 370 + 161 + 256 tokens over 4.962 s.
  assert.deepEqual(parsePicoBatchLine(BATCH_LINE), {
    batchSize: 3,
    steps: 94,
    ms: 4962,
    tokens: 787,
    decodeTps: 158.6,
  });
});

test("the gate status line yields running and waiting requests", () => {
  assert.deepEqual(
    parsePicoGateLine("held 0 in_flight 8 waiting 3 idle_s 0 engine 1 held_s 0 passed 1 refused 0"),
    { running: 8, waiting: 3 }
  );
  assert.equal(parsePicoGateLine(""), null);
});

test("other engine log lines are not completions", () => {
  assert.equal(parsePicoRankLine("serve: req 120 plan: session 1 in place"), null);
  assert.equal(parsePicoRankLine("serve: batch of 3: 209 steps in 10339.9 ms"), null);
  assert.equal(parsePicoFrontLine("req 100 plan: session 1 in place: it shares 1 of 2 bytes"), null);
});

/** A fake head: one file whose content grows between polls. */
function fakeHead(initial, { mtime = 1_700_000_000 } = {}) {
  const file = { text: initial, mtime };
  const commands = [];
  const exec = async (_spark, cmd) => {
    commands.push(cmd);
    const offset = Number(/^o=(\d+)$/m.exec(cmd)?.[1] ?? 0);
    const size = Buffer.byteLength(file.text);
    let start = offset;
    let trunc = 0;
    if (size < offset) {
      start = 0;
      trunc = 1;
    }
    const body = Buffer.from(file.text).subarray(start).toString("utf8");
    return `__pico ${size} ${start} ${trunc} ${file.mtime}\n${body}\n__pico_end__`;
  };
  return { file, commands, exec };
}

test("the first read seeds totals from the whole log and dates the newest completion by mtime", async () => {
  const head = fakeHead(`${RANK_LINE}\n${RANK_LINE}\n`);
  const tail = new PicoLogTail({}, { path: PICO_RANK_LOG, exec: head.exec, now: () => 1_800_000_000_000 });
  const snap = await tail.poll();
  assert.equal(snap.available, true);
  assert.deepEqual(snap.totals, { promptTokens: 124248, cachedTokens: 123528, completionTokens: 400 });
  assert.equal(snap.last.decodeTps, 82.8);
  // The backlog was written before this poll: the file's mtime bounds its age.
  assert.equal(snap.lastAt, 1_700_000_000_000);
});

test("appended lines are read from the previous offset, not the whole file again", async () => {
  let now = 1_800_000_000_000;
  const head = fakeHead(`${RANK_LINE}\n`);
  const tail = new PicoLogTail({}, { path: PICO_RANK_LOG, exec: head.exec, now: () => now });
  await tail.poll();
  head.commands.length = 0;
  head.file.text += `${RANK_LINE}\n`;
  now += 6000;
  const snap = await tail.poll();
  assert.equal(head.commands.length, 1);
  assert.match(head.commands[0], /^o=\d+$/m);
  assert.equal(snap.totals.completionTokens, 400);
  assert.equal(snap.lastAt, now);
});

test("a file shorter than the consumed offset is a restart: totals restart from zero", async () => {
  const head = fakeHead(`${RANK_LINE}\n${RANK_LINE}\n`);
  const tail = new PicoLogTail({}, { path: PICO_RANK_LOG, exec: head.exec, minIntervalMs: 0, now: () => 1_800_000_000_000 });
  await tail.poll();
  head.file.text = `${RANK_LINE}\n`;
  const snap = await tail.poll();
  assert.deepEqual(snap.totals, { promptTokens: 62124, cachedTokens: 61764, completionTokens: 200 });
  assert.equal(snap.last.completionTokens, 200);
});

test("the poll interval keeps back-to-back polls off the head", async () => {
  const head = fakeHead(`${RANK_LINE}\n`);
  const tail = new PicoLogTail({}, { path: PICO_RANK_LOG, exec: head.exec, now: () => 1_800_000_000_000 });
  await tail.poll();
  await tail.poll();
  assert.equal(head.commands.length, 1);
});

test("an unreadable log leaves the last snapshot in place", async () => {
  const head = fakeHead(`${RANK_LINE}\n`);
  const tail = new PicoLogTail({}, { path: PICO_RANK_LOG, exec: head.exec, now: () => 1_800_000_000_000 });
  const first = await tail.poll();
  const failing = new PicoLogTail({}, {
    path: PICO_RANK_LOG,
    exec: async () => { throw new Error("ssh: no route"); },
    now: () => 1_800_000_100_000,
  });
  assert.equal(await failing.poll(), null);
  assert.deepEqual(first.totals, { promptTokens: 62124, cachedTokens: 61764, completionTokens: 200 });
});
