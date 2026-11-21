/**
 * The Updates page's server side: per-Spark state of what could be upgraded (apt + firmware),
 * sudo-free daily checks, installs with a one-time sudo password or the one remembered for the
 * unit's account, and the DGX Dashboard service switch.
 *
 * Transport is the GpuClockManager pattern (server/gpuclock/GpuClockManager.js): the program text
 * travels base64-encoded (`echo b64 | base64 -d | sh`), a sudo password — when the action has one —
 * rides on stdin to `sudo -S -p ''` (remote) or in the child's environment (local, through the host
 * mount namespace). It is never part of an argv and never logged, and it is stripped from any
 * message that might echo it. The one authorized exception is a password the person chose to
 * remember: encrypted at rest in the shared sudo vault (server/storage/sudoVault.js, keyed by the
 * account key of util/sudoPasswordGuard.js), used by the daily index refresh and by every elevated
 * action the page starts without typing one, and never sent back to the browser — the same deal the
 * Storage Manager makes with the one vault both features share. A remembered password sudo stops
 * accepting is dropped, so the page asks again. Wrong guesses are braked by the shared
 * SudoPasswordGuard, keyed user@host:port.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { sshExec } from "../collectors/ssh.js";
import { hostMountNs } from "../shutdown.js";
import { scrubbedChildEnv } from "../llmlaunch/childEnv.js";
import { SudoPasswordGuard, sudoAccountKey } from "../util/sudoPasswordGuard.js";
import { buildProgram, parseKv, parseAptList, parseSim, parseFirmware, parseDashboard } from "./commands.js";

const CHECK_TIMEOUT_MS = 90_000;
/** apt-get update three times plus fwupdmgr refresh: give the unit room. */
const REFRESH_TIMEOUT_MS = 20 * 60_000;
/** The script caps itself below this (apt 3 h, fwupdmgr 1 h), so the unit answers, not the transport. */
const INSTALL_TIMEOUT_MS = 5 * 60 * 60_000;
const DASHBOARD_TIMEOUT_MS = 30_000;
/** The sudo-free automatic check: one tick a minute, one check per unit per local day. */
const AUTO_CHECK_TICK_MS = 60_000;
const AUTO_CHECK_TZ = "Europe/Prague";
const AUTO_CHECK_START_MINUTES = 6 * 60; // 06:00 local
const AUTO_CHECK_SPREAD_MINUTES = 3 * 60; // jitter minute in 06:00–09:00

/** Error codes a program can report, with the HTTP status the route answers with. */
const CODE_STATUS = {
  "bad-password": 403,
  "no-sudo": 409,
  "apt-missing": 409,
  "no-systemd": 409,
  "bad-mode": 400,
  "apt-failed": 502,
  "fw-failed": 502,
  "no-base64": 502,
  "no-sh": 502,
};

const httpError = (status, message, code) => Object.assign(new Error(message), { status, code });

/**
 * The one command line sent over ssh. With a password the outer sh reads it from stdin into
 * the environment of the inner program, which moves it into a plain variable at once; the
 * program itself arrives base64-encoded (no quoting issues, nothing secret in the argv).
 */
export function remoteCommand(program, withPassword) {
  const b64 = Buffer.from(program, "utf8").toString("base64");
  return withPassword
    ? `sh -c 'IFS= read -r SPARKDASH_SUDO_PW; export SPARKDASH_SUDO_PW; echo ${b64} | base64 -d | sh'`
    : `echo ${b64} | base64 -d | sh`;
}

/**
 * Default runner: the program text goes in as one argument, never through a shell string.
 * A sudo password (`input`) travels on stdin (remote) or in the child's environment (local,
 * where it is only readable by the same user and root); it is never part of an argument list.
 */
export function runProgram(spark, program, { timeoutMs = CHECK_TIMEOUT_MS, input = null, maxBuffer = 10 * 1024 * 1024 } = {}) {
  if (!spark.isLocal) {
    const cmd = remoteCommand(program, input != null);
    return sshExec(spark, cmd, input == null ? { timeoutMs, maxBuffer } : { timeoutMs, maxBuffer, input: `${input}\n` });
  }
  const mntNs = hostMountNs();
  const [file, args] = mntNs
    ? ["nsenter", [`--mount=${mntNs}`, "--", "sh", "-c", program]]
    : ["sh", ["-c", program]];
  const env = scrubbedChildEnv();
  if (input != null) env.SPARKDASH_SUDO_PW = input;
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, env, maxBuffer }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().slice(0, 300)));
      else resolve(String(stdout).trim());
    });
  });
}

/** What one Spark remembers between checks; a failed check keeps this, never a healthy guess. */
const freshState = () => ({
  state: "idle", // idle | checking | ok | error
  checkedAt: null,
  apt: [],
  sim: { upgrades: 0, kept: 0, removals: [] },
  firmware: { count: 0, devices: null },
  rebootRequired: false,
  firmwareRebootNeeded: null,
  index: { refreshedAt: null },
  lastError: null,
});

/** Why this unit cannot take update actions, or null when it can. */
export function updatesUnsupportedReason(spark) {
  if (!spark) return "Spark not found";
  // fork: the dashboard's own machine registers as kind "host" with isLocal: true (config/sparks.json),
  // yet it is a local Linux apt box like any Spark, so it alone is admitted; remote hosts keep the refusal
  // — the same gate the Storage Manager widened in 1b9f906.
  if (spark.kind === "host" && !spark.isLocal) return "Updates are only supported on Spark units";
  if (spark.kind === "mac") return "Updates are only supported on Spark units";
  if (spark.platform === "windows" || spark.platform === "darwin") return "Updates are only supported on Linux Spark units";
  return null;
}

export class UpdateManager {
  /**
   * @param {{ run?: typeof runProgram, now?: () => number, listSparks?: () => object[],
   *   isOnline?: (id: string) => boolean, getSettings?: () => object, tz?: string,
   *   vault?: import("../storage/sudoVault.js").SudoVault | null }} [opts]
   *   All of it is injectable for tests; production wiring lives in server/index.js. `vault` is
   *   the shared remembered-sudo-password vault (nullable): every path works without it.
   */
  constructor({ run = runProgram, now = Date.now, listSparks = () => [], isOnline = () => false, getSettings = () => ({}), tz = AUTO_CHECK_TZ, vault = null } = {}) {
    this._run = run;
    this._now = now;
    this._listSparks = listSparks;
    this._isOnline = isOnline;
    this._getSettings = getSettings;
    this._vault = vault;
    this._pwGuard = new SudoPasswordGuard({ now });
    this._tz = tz;
    /** @type {Map<string, object>} per-spark update state */
    this._states = new Map();
    /** @type {Map<string, object>} last install job per spark */
    this._jobs = new Map();
    /** @type {object|null} the fleet install-all job */
    this._fleetJob = null;
    /** @type {Set<string>} units with an action in flight (install, refresh, service toggle) */
    this._busy = new Set();
    /** @type {Map<string, string>} which local day each unit was last auto-checked on */
    this._autoDay = new Map();
    this._fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    /** @type {ReturnType<typeof setInterval>|null} */
    this._timer = null;
    /** One scheduler tick at a time (the AutoPowerManager._running pattern). */
    this._ticking = false;
  }

  // ─── state access ───────────────────────────────────────

  _state(sparkId) {
    let st = this._states.get(sparkId);
    if (!st) {
      st = freshState();
      this._states.set(sparkId, st);
    }
    return st;
  }

  _assert(spark) {
    const reason = updatesUnsupportedReason(spark);
    if (reason) throw httpError(spark ? 400 : 404, reason);
  }

  /** Units the page and the daily check work on: Linux Sparks and the dashboard's own machine (isLocal host); remote hosts and Macs are not apt machines. */
  _units() {
    let list = [];
    try {
      list = this._listSparks() ?? [];
    } catch {
      list = [];
    }
    return list.filter((s) => s && updatesUnsupportedReason(s) === null);
  }

  /** The GET /api/sparks/:id/updates shape. */
  detail(spark) {
    this._assert(spark);
    const st = this._state(spark.id);
    return {
      now: this._now(),
      sparkId: spark.id,
      state: st.state,
      checkedAt: st.checkedAt,
      index: { refreshedAt: st.index.refreshedAt },
      indexAutoRefresh: this._vault?.has(sudoAccountKey(spark)) ? "stored-password" : "check-only",
      sudoSaved: Boolean(this._vault?.has(sudoAccountKey(spark))),
      apt: st.apt.map((r) => ({ ...r })),
      sim: { upgrades: st.sim.upgrades, kept: st.sim.kept, removals: [...st.sim.removals] },
      firmware: { count: st.firmware.count, devices: st.firmware.devices ? st.firmware.devices.map((d) => ({ ...d })) : null },
      rebootRequired: st.rebootRequired,
      firmwareRebootNeeded: st.firmwareRebootNeeded,
      lastError: st.lastError,
    };
  }

  /** The GET /api/updates/summary shape: the nav dot and the per-unit counts, from the last checks. */
  summary() {
    const sparks = this._units().map((s) => {
      const st = this._state(s.id);
      return {
        id: s.id,
        name: s.name || s.id,
        online: Boolean(this._isOnline(s.id)),
        state: st.state,
        aptCount: st.apt.length,
        fwCount: st.firmware.count,
        rebootRequired: st.rebootRequired === true,
        firmwareRebootNeeded: st.firmwareRebootNeeded === true,
        checkedAt: st.checkedAt,
        indexAutoRefresh: this._vault?.has(sudoAccountKey(s)) ? "stored-password" : "check-only",
        sudoSaved: Boolean(this._vault?.has(sudoAccountKey(s))),
      };
    });
    const anyUpgradable = sparks.some((s) => s.online && (s.aptCount > 0 || s.fwCount > 0));
    return { now: this._now(), sparks, anyUpgradable };
  }

  // ─── transport and password plumbing ────────────────────

  async _exec(spark, program, timeoutMs, input = null) {
    let out;
    try {
      out = await this._run(spark, program, { timeoutMs, input });
    } catch (err) {
      let detail = String(err?.message || err).slice(0, 200);
      if (input && input.length >= 4) detail = detail.split(input).join("***");
      const timed = /timed out|ETIMEDOUT|killed/i.test(detail);
      const e = httpError(502, `Could not reach ${spark.name || spark.id}: ${detail}`, timed ? "timeout" : "unreachable");
      throw e;
    }
    return parseKv(out);
  }

  /** Refuse further password attempts for a while after repeated wrong ones. */
  _checkPasswordLock(spark) {
    const secs = this._pwGuard.lockedForSeconds(spark);
    if (secs > 0) throw httpError(429, `Too many wrong sudo passwords. Try again in ${secs} s.`, "password-locked");
  }

  _notePassword(spark, wrong) {
    this._pwGuard.note(spark, wrong);
  }

  _fail(res) {
    const status = CODE_STATUS[res.CODE] ?? 500;
    return httpError(status, res.MSG || "The unit refused the request", res.CODE);
  }

  _refuseBusy(spark) {
    if (this._busy.has(spark.id)) throw httpError(409, "An update job is already running on this unit", "unit-busy");
  }

  // ─── check / refresh ────────────────────────────────────

  /** Merge one program's check lines into the unit's state; returns messages for failed parts. */
  _applyCheck(st, res) {
    const errs = [];
    if (typeof res.APT_B64 === "string") {
      const apt = parseAptList(res.APT_B64);
      if (apt) st.apt = apt;
      else errs.push("the upgradable list could not be read");
    } else if (res.APT_ERR) errs.push(res.APT_ERR);
    if (typeof res.SIM_B64 === "string") {
      const sim = parseSim(res.SIM_B64);
      if (sim) st.sim = sim;
      else errs.push("the upgrade simulation could not be read");
    } else if (res.SIM_ERR) errs.push(res.SIM_ERR);
    if (res.FW_STATE === "ok") {
      st.firmware = parseFirmware("ok", res.FW_B64) ?? st.firmware;
    } else if (res.FW_STATE === "missing") {
      st.firmware = { count: 0, devices: null };
    } else if (res.FW_STATE === "error") {
      errs.push(res.FW_ERR || "fwupdmgr could not answer");
    }
    if (res.REBOOT === "1") st.rebootRequired = true;
    else if (res.REBOOT === "0") st.rebootRequired = false;
    if (res.FWREBOOT === "1") st.firmwareRebootNeeded = true;
    else if (res.FWREBOOT === "0") st.firmwareRebootNeeded = false;
    else if (res.FWREBOOT === "unknown") st.firmwareRebootNeeded = null;
    if (typeof res.STAMP === "string" && /^\d+$/.test(res.STAMP)) st.index.refreshedAt = Number(res.STAMP) * 1000;
    else if (res.STAMP === "") st.index.refreshedAt = null;
    return errs;
  }

  /** The sudo-free check: apt + simulation + fwupd, run now. Holds the unit for its duration. */
  async check(spark) {
    this._assert(spark);
    this._refuseBusy(spark);
    this._busy.add(spark.id);
    try {
      return await this._checkNow(spark);
    } finally {
      this._busy.delete(spark.id);
    }
  }

  /** The check itself; the caller holds the unit's busy lock (no late finish over a job's state). */
  async _checkNow(spark) {
    const st = this._state(spark.id);
    st.state = "checking";
    let res;
    try {
      res = await this._exec(spark, buildProgram("check"), CHECK_TIMEOUT_MS);
    } catch (err) {
      st.state = "error";
      st.lastError = err.message;
      throw err;
    }
    if (res.RESULT !== "ok") {
      st.state = "error";
      st.lastError = res.MSG || "the check failed on the unit";
      throw this._fail(res);
    }
    const errs = this._applyCheck(st, res);
    st.state = "ok";
    st.checkedAt = this._now();
    st.lastError = errs.length ? errs.join("; ") : null;
    return this.detail(spark);
  }

  /** Remember a sudo password the unit accepted, when the person asked for it; a vault write never fails the action. */
  _rememberPassword(spark, password) {
    if (!this._vault || !password) return;
    try {
      this._vault.set(sudoAccountKey(spark), password);
    } catch (err) {
      console.error(`[updates] Could not remember the sudo password: ${err.message}`);
    }
  }

  /** The password remembered for this unit's account, as credentials that say where they came from. */
  _vaultCreds(spark) {
    const saved = this._vault?.get(sudoAccountKey(spark)) ?? null;
    return saved != null ? { password: saved, fromVault: true } : { password: null, fromVault: false };
  }

  /**
   * Credentials for an action on one unit: what was typed for it wins (the person just gave it for
   * this unit), the remembered password stands in when nothing was typed — that is what makes the
   * tick box worth ticking: the next install needs no typing.
   */
  _credsFor(spark, typed) {
    return typed != null ? { password: typed, fromVault: false } : this._vaultCreds(spark);
  }

  /**
   * Credentials for one unit of a fleet run: the unit keeps its own remembered password (a fleet
   * password typed for the run is one guess for five machines), what was typed covers the rest.
   */
  _fleetCredsFor(spark, typed) {
    const saved = this._vaultCreds(spark);
    return saved.password != null ? saved : { password: typed ?? null, fromVault: false };
  }

  /** A remembered password sudo no longer accepts is dropped, so the page asks for a fresh one. */
  _forgetPassword(spark) {
    try {
      this._vault?.delete(sudoAccountKey(spark));
    } catch (err) {
      console.error(`[updates] Could not forget the sudo password: ${err.message}`);
    }
  }

  /**
   * What a program's answer says about the sudo password it ran with, shared by every elevated
   * action. A refusal counts against the brute-force brake (and drops a remembered password nobody
   * typed); anything sudo let through — the program answering at all, `no-sudo` excepted, which is
   * sudo refusing the request rather than the password — proves it was accepted, which is the one
   * moment a typed password may be remembered. A truncated or noise-only answer proves nothing.
   */
  _settlePassword(spark, res, { password = null, fromVault = false, remember = false } = {}) {
    if (password == null) return;
    if (res.CODE === "bad-password") {
      this._notePassword(spark, true);
      if (fromVault) this._forgetPassword(spark);
      return;
    }
    if (res.CODE === "no-sudo" || (res.RESULT !== "ok" && res.RESULT !== "error")) return;
    this._notePassword(spark, false);
    if (remember && !fromVault) this._rememberPassword(spark, password);
  }

  /** Drop the remembered sudo password for this unit's account (the page's Forget button). */
  forgetSudo(spark) {
    this._assert(spark);
    return { forgotten: Boolean(this._vault?.delete(sudoAccountKey(spark))) };
  }

  /**
   * The refresh program itself: apt-get update ×3 + fwupdmgr refresh, then the fresh check merged
   * into the unit's state. The caller holds the unit's busy lock and ran the password-lock check;
   * the route path, the fleet loop and the daily tick share this core. Throws on transport and program errors.
   */
  async _runRefresh(spark, creds = { password: null, fromVault: false }, { remember = false } = {}) {
    const st = this._state(spark.id);
    const { password, fromVault } = creds;
    st.state = "checking";
    let res;
    try {
      res = await this._exec(spark, buildProgram("refresh", { password: password != null }), REFRESH_TIMEOUT_MS, password);
    } catch (err) {
      st.state = "error";
      st.lastError = err.message;
      throw err;
    }
    if (res.RESULT !== "ok") {
      st.state = "error";
      st.lastError = res.MSG || "the refresh failed on the unit";
      this._settlePassword(spark, res, { password, fromVault, remember });
      throw this._fail(res);
    }
    this._settlePassword(spark, res, { password, fromVault, remember });
    const errs = this._applyCheck(st, res);
    if (res.REFRESH_ERR) errs.unshift(res.REFRESH_ERR);
    st.state = "ok";
    st.checkedAt = this._now();
    st.lastError = errs.length ? errs.join("; ") : null;
    return res;
  }

  /**
   * Sudo index refresh (apt-get update ×3 + fwupdmgr refresh), then the fresh check. `sudoPassword`
   * null falls back to the password remembered for the unit's account; `remember` keeps an accepted
   * password in the shared vault, so the next action — and the daily refresh — needs no typing.
   */
  async refresh(spark, { sudoPassword = null, remember = false } = {}) {
    this._assert(spark);
    this._refuseBusy(spark);
    const creds = this._credsFor(spark, sudoPassword);
    if (creds.password != null) this._checkPasswordLock(spark);
    this._busy.add(spark.id);
    try {
      const res = await this._runRefresh(spark, creds, { remember });
      if (res.REFRESH_ERR) {
        // The index itself could not be brought up to date — say so, even though the check ran.
        throw httpError(502, res.REFRESH_ERR, "apt-update-failed");
      }
      return this.detail(spark);
    } finally {
      this._busy.delete(spark.id);
    }
  }

  // ─── install jobs ───────────────────────────────────────

  /** The install program's answer → job phases + refreshed unit state. Throws on program errors. */
  async _runInstallProgram(spark, creds) {
    const { password } = creds;
    const res = await this._exec(spark, buildProgram("install", { password: password != null }), INSTALL_TIMEOUT_MS, password);
    return res;
  }

  _settleInstallResult(spark, job, res, creds = { password: null, fromVault: false }, remember = false) {
    this._settlePassword(spark, res, { ...creds, remember });
    if (res.RESULT !== "ok") {
      job.state = "error";
      job.error = res.MSG || "the unit refused the upgrade";
      job.code = res.CODE || "install-failed";
      // Where it broke: STEP names the phase the script had reached.
      const reachedFirmware = res.STEP === "firmware";
      for (const phase of job.phases) {
        if (phase.key === "apt") phase.state = reachedFirmware ? "done" : "error";
        else phase.state = reachedFirmware ? "error" : "skipped";
      }
      return { ok: false, code: job.code };
    }
    const aptPhase = job.phases.find((p) => p.key === "apt");
    aptPhase.state = "done";
    aptPhase.note = res.LAST ? `last: ${res.LAST}` : "all packages up to date";
    const fwPhase = job.phases.find((p) => p.key === "firmware");
    if (res.FWUP === "done") {
      fwPhase.state = "done";
      fwPhase.note = "firmware updated";
    } else if (res.FWUP === "none") {
      fwPhase.state = "done";
      fwPhase.note = "nothing to upgrade";
    } else if (res.FWUP === "missing") {
      fwPhase.state = "skipped";
      fwPhase.note = "fwupdmgr is not installed";
    } else {
      fwPhase.state = "error";
    }
    const st = this._state(spark.id);
    const errs = this._applyCheck(st, res);
    st.state = "ok";
    st.checkedAt = this._now();
    st.lastError = errs.length ? errs.join("; ") : null;
    job.rebootRequired = st.rebootRequired;
    job.firmwareRebootNeeded = st.firmwareRebootNeeded;
    job.state = "done";
    return { ok: true };
  }

  /**
   * Start the install job for one unit. Removals the last simulation showed gate the run:
   * until the page confirms them, this is a 409 `needs_confirmation` carrying the list.
   * `sudoPassword` null falls back to the password remembered for the unit's account; `remember`
   * keeps a typed one once sudo has accepted it.
   */
  install(spark, { sudoPassword = null, confirmRemovals = false, remember = false } = {}) {
    this._assert(spark);
    this._refuseBusy(spark);
    // The fleet loop has claimed this unit but not reached it yet: it belongs to the fleet job.
    if (
      this._fleetJob?.state === "running" &&
      this._fleetJob.units.some((u) => u.sparkId === spark.id && (u.state === "pending" || u.state === "running"))
    ) {
      throw httpError(409, "An update job is already running on this unit", "unit-busy");
    }
    const st = this._state(spark.id);
    if (st.checkedAt == null) {
      // Without a fresh simulation there is no telling what the upgrade would remove: never install blind.
      throw httpError(409, "Check this unit first to see what the upgrade would change", "needs-check");
    }
    if (st.sim.removals.length > 0 && confirmRemovals !== true) {
      const err = httpError(409, "The upgrade would remove packages. Confirm the list to continue.", "needs_confirmation");
      err.removals = [...st.sim.removals];
      throw err;
    }
    const creds = this._credsFor(spark, sudoPassword);
    if (creds.password != null) this._checkPasswordLock(spark);
    const job = {
      id: randomUUID(),
      sparkId: spark.id,
      state: "running",
      startedAt: this._now(),
      finishedAt: null,
      phases: [
        { key: "apt", state: "running" },
        { key: "firmware", state: "pending" },
      ],
      rebootRequired: st.rebootRequired,
      firmwareRebootNeeded: st.firmwareRebootNeeded,
    };
    this._jobs.set(spark.id, job);
    this._busy.add(spark.id);
    // The job survives the page closing: it runs here, not in a tab.
    void this._executeInstall(spark, job, creds, remember);
    return { jobId: job.id };
  }

  async _executeInstall(spark, job, creds, remember) {
    try {
      const res = await this._runInstallProgram(spark, creds);
      this._settleInstallResult(spark, job, res, creds, remember);
    } catch (err) {
      // Transport failure (or a refused program): name it on the job, keep the last state.
      const st = this._state(spark.id);
      st.state = "error";
      st.lastError = err.message;
      job.state = "error";
      job.error = err.message;
      job.code = err.code || "unreachable";
      for (const phase of job.phases) if (phase.state === "running" || phase.state === "pending") phase.state = "error";
    } finally {
      job.finishedAt = this._now();
      this._busy.delete(spark.id);
    }
  }

  /** GET /api/sparks/:id/updates/job — the page follows the job at 1 s. */
  job(spark) {
    this._assert(spark);
    const job = this._jobs.get(spark.id) ?? null;
    if (!job) return { job: null };
    return { job: structuredClone(job), now: this._now() };
  }

  /** True while any job (per-unit or fleet) holds this unit. */
  isBusy(sparkId) {
    return this._busy.has(sparkId);
  }

  /**
   * The fleet install job: every Linux Spark unit, one at a time. Units with unconfirmed
   * removals answer `needs_confirmation` (the same list the per-unit route gates on) and the
   * job carries on with the others; offline and busy units are skipped, not errors.
   */
  installAll({ sudoPassword = null, remember = false } = {}) {
    if (this._fleetJob && this._fleetJob.state === "running") {
      throw httpError(409, "A fleet update job is already running", "already-running");
    }
    const units = this._units().map((s) => ({
      sparkId: s.id,
      sparkName: s.name || s.id,
      state: "pending",
    }));
    const job = { id: randomUUID(), mode: "install", state: "running", startedAt: this._now(), finishedAt: null, units };
    this._fleetJob = job;
    void this._executeInstallAll(job, sudoPassword, remember);
    return { jobId: job.id };
  }

  async _executeInstallAll(job, typedPassword, remember) {
    for (const row of job.units) {
      const spark = (this._listSparks() ?? []).find((s) => s && s.id === row.sparkId);
      if (!spark || !this._isOnline(row.sparkId)) {
        row.state = "skipped-offline";
        continue;
      }
      if (this._busy.has(row.sparkId)) {
        row.state = "skipped-busy";
        continue;
      }
      const st = this._state(row.sparkId);
      // The shared brute-force brake applies per unit too: a locked account is an outcome, not a stall.
      const secs = this._pwGuard.lockedForSeconds(spark);
      if (secs > 0) {
        row.state = "error";
        row.code = "password-locked";
        row.error = `Too many wrong sudo passwords. Try again in ${secs} s.`;
        continue;
      }
      if (st.checkedAt == null) {
        row.state = "error";
        row.code = "needs-check";
        row.error = "Check this unit first to see what the upgrade would change";
        continue;
      }
      if (st.sim.removals.length > 0) {
        row.state = "needs_confirmation";
        row.removals = [...st.sim.removals];
        continue;
      }
      row.state = "running";
      this._busy.add(row.sparkId);
      // Nothing remembered and nothing typed: the unit's own sudo gate answers no-sudo.
      const creds = this._fleetCredsFor(spark, typedPassword);
      try {
        const res = await this._runInstallProgram(spark, creds);
        this._settlePassword(spark, res, { ...creds, remember });
        if (res.RESULT !== "ok") {
          row.state = "error";
          row.error = res.MSG || "the unit refused the upgrade";
          row.code = res.CODE || "install-failed";
          continue;
        }
        const errs = this._applyCheck(st, res);
        st.state = "ok";
        st.checkedAt = this._now();
        st.lastError = errs.length ? errs.join("; ") : null;
        row.state = "done";
        row.rebootRequired = st.rebootRequired;
      } catch (err) {
        row.state = "error";
        row.error = err.message;
        row.code = err.code || "unreachable";
      } finally {
        this._busy.delete(row.sparkId);
      }
    }
    job.state = "done";
    job.finishedAt = this._now();
  }

  /**
   * The fleet index refresh: the exact installAll machinery — one shared fleet job with a `mode`
   * (so starting one kind while the other runs is the same already-running refusal), units one at
   * a time, offline and busy units skipped, a locked sudo account an outcome not a stall — but
   * what runs per unit is the sudo refresh + fresh check, and an accepted password is remembered
   * per unit when asked.
   */
  refreshAll({ sudoPassword = null, remember = false } = {}) {
    if (this._fleetJob && this._fleetJob.state === "running") {
      throw httpError(409, "A fleet update job is already running", "already-running");
    }
    const units = this._units().map((s) => ({
      sparkId: s.id,
      sparkName: s.name || s.id,
      state: "pending",
    }));
    const job = { id: randomUUID(), mode: "refresh", state: "running", startedAt: this._now(), finishedAt: null, units };
    this._fleetJob = job;
    void this._executeRefreshAll(job, sudoPassword, remember);
    return { jobId: job.id };
  }

  async _executeRefreshAll(job, typedPassword, remember) {
    for (const row of job.units) {
      const spark = (this._listSparks() ?? []).find((s) => s && s.id === row.sparkId);
      if (!spark || !this._isOnline(row.sparkId)) {
        row.state = "skipped-offline";
        continue;
      }
      if (this._busy.has(row.sparkId)) {
        row.state = "skipped-busy";
        continue;
      }
      // The shared brute-force brake applies per unit too: a locked account is an outcome, not a stall.
      const secs = this._pwGuard.lockedForSeconds(spark);
      if (secs > 0) {
        row.state = "error";
        row.code = "password-locked";
        row.error = `Too many wrong sudo passwords. Try again in ${secs} s.`;
        continue;
      }
      row.state = "running";
      this._busy.add(row.sparkId);
      const creds = this._fleetCredsFor(spark, typedPassword);
      try {
        // A refresh needs no prior check: it answers with its own fresh state. Remember an accepted
        // typed password for the unit's account (same moment as the route path).
        const res = await this._runRefresh(spark, creds, { remember });
        if (res.REFRESH_ERR) {
          // sudo passed and the check ran, but the index itself could not be brought up to date.
          row.state = "error";
          row.code = "apt-update-failed";
          row.error = res.REFRESH_ERR;
          continue;
        }
        row.state = "done";
      } catch (err) {
        row.state = "error";
        row.error = err.message;
        row.code = err.code || "unreachable";
      } finally {
        this._busy.delete(row.sparkId);
      }
    }
    job.state = "done";
    job.finishedAt = this._now();
  }

  /** GET /api/updates/install-all. */
  fleetJob() {
    if (!this._fleetJob) return { job: null };
    return { job: { ...structuredClone(this._fleetJob), now: this._now() } };
  }

  /** Wait for every in-flight job (tests). */
  async settled() {
    let guard = 0;
    while ((this._busy.size > 0 || this._fleetJob?.state === "running") && guard < 2000) {
      await new Promise((r) => setTimeout(r, 5));
      guard += 1;
    }
  }

  // ─── DGX Dashboard services ─────────────────────────────

  /** systemctl state of the two Dashboard units (unprivileged). */
  async dashboardService(spark) {
    this._assert(spark);
    const res = await this._exec(spark, buildProgram("dashboard", { args: ["status"] }), DASHBOARD_TIMEOUT_MS);
    if (res.RESULT !== "ok") throw this._fail(res);
    return { units: parseDashboard(res), now: this._now() };
  }

  /**
   * `systemctl disable --now` / `enable --now` both units, then answer with the truth. `sudoPassword`
   * null falls back to the password remembered for the unit's account; `remember` keeps a typed one.
   */
  async setDashboardService(spark, { enabled, sudoPassword = null, remember = false } = {}) {
    this._assert(spark);
    if (typeof enabled !== "boolean") throw httpError(400, "enabled must be true or false");
    this._refuseBusy(spark);
    const creds = this._credsFor(spark, sudoPassword);
    if (creds.password != null) this._checkPasswordLock(spark);
    this._busy.add(spark.id);
    try {
      const res = await this._exec(
        spark,
        buildProgram("dashboard", { args: [enabled ? "on" : "off"], elevate: true, password: creds.password != null }),
        DASHBOARD_TIMEOUT_MS,
        creds.password
      );
      this._settlePassword(spark, res, { ...creds, remember });
      if (res.RESULT !== "ok") throw this._fail(res);
      return { units: parseDashboard(res), now: this._now() };
    } finally {
      this._busy.delete(spark.id);
    }
  }

  // ─── daily auto-check and index refresh ─────────────────

  start(tickMs = AUTO_CHECK_TICK_MS) {
    if (this._timer) return;
    this._timer = setInterval(() => {
      void this.runTick().catch(() => {});
    }, tickMs);
    // Never hold the process open for the check alone.
    if (typeof this._timer.unref === "function") this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** Local wall-clock of `nowMs` in the check's time zone: the day key and minutes since midnight. */
  _localTime(nowMs) {
    const parts = {};
    for (const { type, value } of this._fmt.formatToParts(new Date(nowMs))) parts[type] = value;
    return {
      dayKey: `${parts.year}-${parts.month}-${parts.day}`,
      minutes: Number(parts.hour) * 60 + Number(parts.minute),
    };
  }

  /**
   * The unit's check minute for one day: a stable pseudo-random 0–179 past 06:00 local, so a
   * fleet does not wake every unit's apt at once and the same unit keeps its slot all day.
   */
  _jitter(sparkId, dayKey) {
    let h = 0x811c9dc5;
    const s = `${sparkId}|${dayKey}`;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h % AUTO_CHECK_SPREAD_MINUTES;
  }

  /**
   * One scheduler tick (also the test seam — `nowMs` is injected), guarded so a slow refresh
   * never stacks the minute ticks behind it (the AutoPowerManager `_running` pattern).
   */
  async runTick(nowMs = this._now()) {
    if (this._ticking) return 0;
    this._ticking = true;
    try {
      return await this._runTickOnce(nowMs);
    } finally {
      this._ticking = false;
    }
  }

  /** The password the daily slot would refresh with, or null when the unit stays sudo-free: setting not on, no vault, no remembered password, account locked, or the entry undecryptable. Strict like `updatesAutoCheck`: only a real true turns the refresh on (a hand-edited truthy string disables it). */
  _autoRefreshPassword(spark) {
    if (this._getSettings().updatesAutoRefresh !== true) return null;
    if (!this._vault) return null;
    const key = sudoAccountKey(spark);
    if (!this._vault.has(key)) return null;
    if (this._pwGuard.lockedForSeconds(spark) > 0) return null;
    return this._vault.get(key);
  }

  /**
   * Every online Spark unit that has not been auto-checked on this local day and is past its
   * jittered 06:00–09:00 slot gets its daily work: with Settings' `updatesAutoRefresh` on and a
   * sudo password remembered for the unit's account, the sudo index refresh (indexes and
   * metadata only, never installs), falling back to the sudo-free check when the unit stops
   * accepting it; otherwise the sudo-free check itself. A unit offline at its slot is caught on
   * the next tick it is online that day. Settings' `updatesAutoCheck` gates the whole thing;
   * manual checks always work.
   */
  async _runTickOnce(nowMs) {
    if (this._getSettings().updatesAutoCheck !== true) return 0;
    const { dayKey, minutes } = this._localTime(nowMs);
    let started = 0;
    for (const unit of this._units()) {
      if (!this._isOnline(unit.id)) continue;
      if (this._autoDay.get(unit.id) === dayKey) continue;
      if (minutes < AUTO_CHECK_START_MINUTES + this._jitter(unit.id, dayKey)) continue;
      if (this._busy.has(unit.id)) continue; // busy: skip this tick in silence, retry on the next
      this._busy.add(unit.id); // hold it now: nothing else may slip onto the unit in between
      this._autoDay.set(unit.id, dayKey); // once per local day, even when the work fails
      started += 1;
      const stored = this._autoRefreshPassword(unit);
      if (stored == null) {
        this._checkNow(unit).catch(() => {}).finally(() => this._busy.delete(unit.id));
        continue;
      }
      this._runRefresh(unit, { password: stored, fromVault: true })
        .catch((err) => {
          if (err?.code !== "bad-password") return; // any other failure keeps its error state: never a healthy guess
          // sudo no longer accepts the remembered password: _runRefresh dropped the entry (and put the
          // wrong guess on the guard); still take the day's data with the sudo-free check.
          return this._checkNow(unit).catch(() => {});
        })
        .finally(() => this._busy.delete(unit.id));
    }
    return started;
  }
}
