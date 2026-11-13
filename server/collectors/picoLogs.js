/**
 * Pico (dsgb10) telemetry from the engine's own logs.
 *
 * Pico serves only `/health`, `/v1/models` and `/v1/chat/completions`: it publishes no
 * counters, gauges or stats endpoint. Its rank-0 process does log one line per finished
 * request with the prompt/cached/completion token counts and the measured prefill and
 * decode rates, and the front-end logs the same completion from its own side. That line is
 * the only live telemetry the engine offers, so the probe reads it over SSH from the head.
 *
 * The read is incremental: every poll asks for the bytes after the last consumed offset
 * plus the file size. A file shorter than that offset means the engine restarted or the
 * log rotated — the counters restart from zero, exactly as the engine's own counters do.
 * A parse miss is silence, never a fabricated rate.
 *
 * Line shapes are the kit's own (`serve:` on rank 0, `req ... session` on the front-end);
 * both were captured from a live DeepSeek-V4.1-Flash-1017 service on four DGX Sparks.
 */
import { sshExec } from "./ssh.js";

/** Rank 0's engine log: prompt/cached tokens plus measured prefill and decode rates. */
export const PICO_RANK_LOG = "$HOME/dsgb10/service/logs/rank.0.log";
/** The front-end log: prompt/cached/completion tokens, TTFT and decode rate. */
export const PICO_FRONT_LOG = "$HOME/dsgb10/service/logs/front.log";

const MAX_READ_BYTES = 1 << 20;
const DEFAULT_MIN_INTERVAL_MS = 500;

/** `serve: req 129 session …: prompt 62124, reused 61764 (live), prefill 203.7 ms (1767 tok/s), 200 tokens in 2403.0 ms (82.8 tok/s), stop; store 1897.2 MiB; …` */
const RANK_COMPLETION =
  /^serve: req (\d+) session \S+: prompt (\d+), reused (\d+) \(\w+\), prefill ([\d.]+) ms \(([\d.]+) tok\/s\), (\d+) tokens in ([\d.]+) ms \(([\d.]+) tok\/s\), \w+; store ([\d.]+) MiB/;

/** `req 100 session …: prompt 115945 (cached 114041), completion 396, tool_calls; ttft 0.491 s, 58.2 tok/s` */
const FRONT_COMPLETION =
  /^req (\d+) session \d+: prompt (\d+)(?: \(cached (\d+)\))?, completion (\d+), \w+; ttft ([\d.]+) s, ([\d.]+) tok\/s$/;

/**
 * `serve: batch of 3: 94 steps in 4962.0 ms, 53.12 ms a step (median); req, tokens, end: 456 370 stop, 455 161 stop, 433 256 paused; drafts: …`
 *
 * One line per finished batch: the tokens each request produced in that batch and the
 * batch's wall time. `tokens / time` is the engine's aggregate decode rate across every
 * concurrent request, which a single completion line's per-request tok/s cannot show.
 */
const RANK_BATCH =
  /^serve: batch of (\d+): (\d+) steps in ([\d.]+) ms, [\d.]+ ms a step[^;]*; req, tokens, end: (.*?)(?:; drafts:|$)/;

/** The log path is operator configuration; keep it to a plain path (no shell metacharacters). */
function shellPath(path) {
  if (!/^[A-Za-z0-9_@%+=:,./~$ -]+$/.test(path)) {
    throw new Error("Pico log path contains unsupported characters");
  }
  return `"${path}"`;
}

function readCommand(path, offset, maxBytes) {
  return [
    `f=${shellPath(path)}`,
    `[ -r "$f" ] || { echo __pico_missing__; exit 0; }`,
    `s=$(stat -c %s "$f" 2>/dev/null || wc -c < "$f")`,
    `m=$(stat -c %Y "$f" 2>/dev/null || echo 0)`,
    `o=${offset}`,
    `t=0`,
    // 1: the file is shorter than the consumed offset — the engine restarted.
    `if [ "$s" -lt "$o" ]; then o=0; t=1; fi`,
    // 2: a backlog bigger than one read; skip to its tail (the first line may be partial).
    `if [ $((s-o)) -gt ${maxBytes} ]; then o=$((s-${maxBytes})); t=2; fi`,
    `printf '__pico %s %s %s %s\\n' "$s" "$o" "$t" "$m"`,
    `tail -c +$((o+1)) "$f"`,
    // The front-end's admin socket knows the live occupancy; the log only knows completions.
    `b="$HOME/dsgb10/service/bin/dsfront"`,
    `a="$HOME/dsgb10/service/run/front.admin"`,
    `if [ -x "$b" ] && [ -S "$a" ]; then`,
    `  printf '\\n__pico_gate__ %s\\n' "$("$b" admin --socket "$a" status 2>/dev/null)"`,
    `else`,
    `  printf '\\n__pico_gate__\\n'`,
    `fi`,
    `printf '__pico_end__\\n'`,
  ].join("\n");
}

/**
 * Parse the front-end gate's one-line status: `held 0 in_flight 8 waiting 0 idle_s …`.
 * @param {string} line
 * @returns {{ running: number, waiting: number } | null}
 */
export function parsePicoGateLine(line) {
  const m = /held (\d+) in_flight (\d+) waiting (\d+)/.exec(line);
  if (!m) return null;
  return { running: Number(m[2]), waiting: Number(m[3]) };
}

/**
 * Parse one rank-0 completion line.
 * @param {string} line
 * @returns {{ promptTokens: number, cachedTokens: number, completionTokens: number, prefillTps: number, decodeTps: number, storeMiB: number } | null}
 */
export function parsePicoRankLine(line) {
  const m = RANK_COMPLETION.exec(line);
  if (!m) return null;
  const prefillTps = Number(m[5]);
  const decodeTps = Number(m[8]);
  if (!Number.isFinite(prefillTps) || !Number.isFinite(decodeTps)) return null;
  return {
    promptTokens: Number(m[2]),
    cachedTokens: Number(m[3]),
    completionTokens: Number(m[6]),
    prefillTps,
    decodeTps,
    storeMiB: Number(m[9]),
  };
}

/**
 * Parse one front-end completion line.
 * @param {string} line
 * @returns {{ promptTokens: number, cachedTokens: number | null, completionTokens: number, prefillTps: null, decodeTps: number, ttftSeconds: number } | null}
 */
export function parsePicoFrontLine(line) {
  const m = FRONT_COMPLETION.exec(line);
  if (!m) return null;
  const decodeTps = Number(m[6]);
  const ttftSeconds = Number(m[5]);
  if (!Number.isFinite(decodeTps) || !Number.isFinite(ttftSeconds)) return null;
  return {
    promptTokens: Number(m[2]),
    cachedTokens: m[3] == null ? null : Number(m[3]),
    completionTokens: Number(m[4]),
    prefillTps: null,
    decodeTps,
    ttftSeconds,
  };
}

/** One line of the engine's log, whichever file it came from. */
export function parsePicoCompletionLine(line, format = "rank") {
  return format === "front" ? parsePicoFrontLine(line) : parsePicoRankLine(line);
}

/**
 * Parse one rank-0 batch line into the engine's aggregate decode rate.
 * @param {string} line
 * @returns {{ batchSize: number, steps: number, ms: number, tokens: number, decodeTps: number } | null}
 */
export function parsePicoBatchLine(line) {
  const m = RANK_BATCH.exec(line);
  if (!m) return null;
  const steps = Number(m[2]);
  const ms = Number(m[3]);
  if (!(steps > 0) || !(ms > 0)) return null;
  let tokens = 0;
  const item = /(\d+)\s+(\d+)\s+\w+/g;
  let match;
  while ((match = item.exec(m[4])) !== null) tokens += Number(match[2]);
  if (!(tokens > 0)) return null;
  return {
    batchSize: Number(m[1]),
    steps,
    ms,
    tokens,
    decodeTps: Math.round((tokens / (ms / 1000)) * 10) / 10,
  };
}

/**
 * Incremental reader for a Pico log on the head unit.
 *
 * `poll()` never throws: an unreachable host or a missing file keeps the last snapshot so
 * a transient SSH failure does not blank telemetry that is still valid.
 */
export class PicoLogTail {
  /**
   * @param {object} spark unit configuration (SSH target and credentials)
   * @param {{ path?: string, exec?: Function, now?: () => number, maxBytes?: number, minIntervalMs?: number }} [options]
   */
  constructor(spark, options = {}) {
    this.spark = spark;
    this.path = options.path || PICO_RANK_LOG;
    this._exec = typeof options.exec === "function" ? options.exec : sshExec;
    this._now = typeof options.now === "function" ? options.now : Date.now;
    this._maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : MAX_READ_BYTES;
    this._minIntervalMs = Number.isFinite(options.minIntervalMs)
      ? options.minIntervalMs
      : DEFAULT_MIN_INTERVAL_MS;
    this._format = /(^|\/)front\.log$/.test(this.path) ? "front" : "rank";
    this._offset = 0;
    this._carry = "";
    this._totals = { promptTokens: 0, cachedTokens: 0, completionTokens: 0 };
    /** @type {ReturnType<typeof parsePicoRankLine> | null} */
    this._last = null;
    /** Epoch ms of the newest completion we have seen; null until one is parsed. */
    this._lastAt = null;
    /** @type {ReturnType<typeof parsePicoBatchLine> | null} */
    this._batch = null;
    /** Epoch ms of the newest batch line; null until one is parsed. */
    this._batchAt = null;
    /** Live gate occupancy: requests running / waiting. */
    this._gate = null;
    this._lastReadAt = 0;
    this._snapshot = null;
  }

  /**
   * Read the bytes appended since the previous poll.
   * @returns {Promise<{ available: true, last: object | null, lastAt: number | null, totals: { promptTokens: number, cachedTokens: number, completionTokens: number } } | null>}
   */
  async poll() {
    const now = this._now();
    if (this._snapshot && now - this._lastReadAt < this._minIntervalMs) return this._snapshot;
    this._lastReadAt = now;

    let out;
    try {
      out = await this._exec(this.spark, readCommand(this.path, this._offset, this._maxBytes), {
        timeoutMs: 8000,
      });
    } catch {
      return this._snapshot;
    }
    if (typeof out !== "string" || !out.startsWith("__pico ")) return this._snapshot;

    const markerEnd = out.indexOf("\n");
    const marker = out.slice(0, markerEnd).trim().split(/\s+/);
    const size = Number(marker[1]);
    const trunc = Number(marker[3]);
    const mtime = Number(marker[4]);
    if (!Number.isFinite(size) || markerEnd < 0) return this._snapshot;

    const end = out.lastIndexOf("__pico_end__");
    const gateAt = out.indexOf("__pico_gate__");
    const body = out.slice(markerEnd + 1, gateAt >= 0 ? gateAt : end >= 0 ? end : undefined);
    this._gate = gateAt >= 0
      ? parsePicoGateLine(out.slice(gateAt + "__pico_gate__".length, end > gateAt ? end : undefined).trim())
      : null;
    const firstRead = this._lastAt == null;

    if (trunc === 1) {
      // The engine restarted (or the log rotated): its counters restart too.
      this._totals = { promptTokens: 0, cachedTokens: 0, completionTokens: 0 };
      this._last = null;
      this._batch = null;
      this._carry = "";
    }

    const lines = (this._carry + body).split("\n");
    this._carry = lines.pop() ?? "";
    if (trunc === 2) lines.shift(); // a read clamped to the tail starts mid-line

    let parsed = 0;
    let parsedBatch = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      const event = parsePicoCompletionLine(trimmed, this._format);
      if (event) {
        parsed += 1;
        this._totals.promptTokens += event.promptTokens;
        if (event.cachedTokens != null) this._totals.cachedTokens += event.cachedTokens;
        this._totals.completionTokens += event.completionTokens;
        this._last = event;
        continue;
      }
      if (this._format !== "rank") continue;
      const batch = parsePicoBatchLine(trimmed);
      if (!batch) continue;
      parsedBatch += 1;
      this._batch = batch;
    }
    // A backlog read happened before this poll: the newest line is at most as old as
    // the file's mtime. Live reads land now.
    const stamp = firstRead && Number.isFinite(mtime) && mtime > 0
      ? Math.min(now, mtime * 1000)
      : now;
    if (parsed > 0) this._lastAt = stamp;
    if (parsedBatch > 0) this._batchAt = stamp;
    this._offset = size;

    this._snapshot = {
      available: true,
      last: this._last,
      lastAt: this._lastAt,
      batch: this._batch,
      batchAt: this._batchAt,
      gate: this._gate,
      totals: { ...this._totals },
    };
    return this._snapshot;
  }
}
