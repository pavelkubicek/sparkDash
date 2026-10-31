/**
 * Runs the CPU maximum-frequency programs on a unit. Same transport as the GPU
 * clock manager (local host mount namespace or SSH with `sudo -n`), one action
 * per unit at a time, Linux Spark units only.
 */
import { runProgram } from "../gpuclock/GpuClockManager.js";
import {
  buildCpuApplyProgram,
  buildCpuResetProgram,
  buildCpuStatusProgram,
  parseCpuCapRequest,
  parseCpuProgramOutput,
} from "./commands.js";

const ACTION_TIMEOUT_MS = 45_000;
const STATUS_TIMEOUT_MS = 15_000;
const HOLD_AFTER_TRANSPORT_ERROR_MS = 30_000;

const CODE_STATUS = {
  "no-sudo": 409,
  "no-cpupower": 409,
  "no-cpufreq": 409,
  busy: 409,
  "lock-failed": 409,
  range: 400,
  "bad-output": 502,
  "cpupower-failed": 422,
  "service-failed": 422,
  "cron-failed": 422,
  "marker-failed": 422,
};

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

/** Why this unit cannot take a CPU cap, or null when it can. */
export function cpuClockUnsupportedReason(spark) {
  if (!spark) return "Spark not found";
  if (spark.kind === "host") return "CPU clock caps are only supported on Spark units";
  if (spark.platform === "windows" || spark.platform === "darwin") {
    return "CPU clock caps are only supported on Linux Spark units";
  }
  return null;
}

export function assertCpuSupported(spark) {
  const reason = cpuClockUnsupportedReason(spark);
  if (reason) throw httpError(spark ? 400 : 404, reason);
}

export class CpuClockManager {
  constructor({ run = runProgram, paths = {}, holdMs = HOLD_AFTER_TRANSPORT_ERROR_MS, now = Date.now } = {}) {
    this._run = run;
    this._now = now;
    this._holdMs = holdMs;
    this._paths = paths;
    /** @type {Set<string>} */
    this._busy = new Set();
  }

  async _exec(spark, program, timeoutMs) {
    let out;
    try {
      out = await this._run(spark, program, { timeoutMs, input: null });
    } catch (err) {
      const detail = String(err.message || err).slice(0, 200);
      const e = httpError(502, `Could not reach ${spark.name || spark.id}: ${detail}`);
      e.holdBusy = true;
      throw e;
    }
    return parseCpuProgramOutput(out);
  }

  _fail(res) {
    const status = CODE_STATUS[res.CODE] ?? 500;
    return httpError(status, res.MSG || "The unit refused the request", res.CODE);
  }

  async _exclusive(spark, fn) {
    if (this._busy.has(spark.id)) throw httpError(409, "Another CPU clock action is still running on this unit");
    this._busy.add(spark.id);
    let hold = false;
    try {
      return await fn();
    } catch (err) {
      hold = err?.holdBusy === true;
      throw err;
    } finally {
      if (hold && this._holdMs > 0) {
        setTimeout(() => this._busy.delete(spark.id), this._holdMs).unref?.();
      } else {
        this._busy.delete(spark.id);
      }
    }
  }

  /** Read-only: limits, recorded cap, sudo and the state of both boot hooks. */
  async status(spark) {
    assertCpuSupported(spark);
    const res = await this._exec(spark, buildCpuStatusProgram(this._paths), STATUS_TIMEOUT_MS);
    if (res.RESULT !== "ok") {
      if (res.CODE === "no-cpupower" || res.CODE === "no-cpufreq") {
        return { supported: false, reason: res.MSG };
      }
      throw this._fail(res);
    }
    const num = (v) => (/^\d+$/.test(v ?? "") ? Number(v) : null);
    return {
      supported: true,
      hwMaxMHz: num(res.HWMAX),
      currentMaxMHz: num(res.CURMAX),
      capMHz: num(res.CAP),
      sudo: ["root", "yes", "no"].includes(res.SUDO) ? res.SUDO : "no",
      persistKind: ["unit", "cron", "none"].includes(res.PERSIST_KIND) ? res.PERSIST_KIND : "none",
      service: {
        installed: res.SVC_INSTALLED === "1",
        maxMHz: num(res.SVC_CLOCKS),
        enabled: res.SVC_ENABLED || null,
        active: res.SVC_ACTIVE || null,
      },
      cron: {
        installed: res.CRON_INSTALLED === "1",
        maxMHz: num(res.CRON_CLOCKS),
        failed: res.CRON_FAILED === "1",
      },
    };
  }

  /** Apply a cap now; `persist` installs the boot hook this unit can take. */
  async apply(spark, body) {
    assertCpuSupported(spark);
    const req = parseCpuCapRequest(body);
    return this._exclusive(spark, async () => {
      const res = await this._exec(spark, buildCpuApplyProgram(req, this._paths), ACTION_TIMEOUT_MS);
      if (res.RESULT !== "ok") throw this._fail(res);
      const persisted = res.PERSIST === "1";
      return {
        maxMHz: Number(res.CAP) || req.maxMHz,
        persist: persisted,
        persistKind: persisted ? (res.PERSIST_KIND === "cron" ? "cron" : "unit") : "none",
      };
    });
  }

  /** Restore the hardware maximum and remove both hooks and the marker. */
  async reset(spark) {
    assertCpuSupported(spark);
    return this._exclusive(spark, async () => {
      const res = await this._exec(spark, buildCpuResetProgram(this._paths), ACTION_TIMEOUT_MS);
      if (res.RESULT !== "ok") throw this._fail(res);
      return {};
    });
  }
}
