/**
 * Shutdown helpers: the power-off invocation for a local unit and the command
 * string for a remote one.
 *
 * The helper lives on the *host* (`/usr/local/bin/spark-shutdown`). A container
 * install has no sudo of its own, so the local route has to enter the host
 * mount namespace first — the same nsenter pattern the collectors use to read
 * /host/proc (the image ships util-linux for exactly this).
 *
 * Local Sparks in the sparkDash container go one step further and skip the
 * helper entirely: privileged + pid:host means `nsenter -t 1 -m` reaches host
 * systemd directly (`systemctl poweroff`), so no provisioning is needed on the
 * dashboard host. Remote Sparks and bare-host installs keep the sudo +
 * host-script contract.
 *
 * Both paths acknowledge before the host actually goes down — systemctl /
 * nohup'd script *queue* the power-off, so the HTTP response flushes with
 * seconds to spare. Anything that fails inside the ack window (missing
 * binary, sudo wants a password, missing remote script) rejects with the real
 * reason instead of a fake "Shutdown initiated".
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { HOST_PATHS } from "./config.js";
import { sshExec } from "./collectors/ssh.js";

export const SHUTDOWN_BIN = "/usr/local/bin/spark-shutdown";

const SHUTDOWN_ACK_WINDOW_MS = 1500;

/**
 * Host mount namespace of PID 1, or null when the dashboard runs directly on
 * the host (bare-metal / dev) and there is no container boundary to cross.
 * @param {string} [procPath]
 * @returns {string | null}
 */
export function hostMountNs(procPath = HOST_PATHS.PROC) {
  const ns = path.join(procPath, "1", "ns", "mnt");
  try {
    return fs.existsSync(ns) ? ns : null;
  } catch {
    return null;
  }
}

/** PATH scan for an executable; mirrors ssh.js sshpassAvailable(). */
let _commandCache = new Map();
function commandAvailable(name) {
  if (_commandCache.has(name)) return _commandCache.get(name);
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const found = dirs.some((dir) => {
    try {
      return fs.statSync(path.join(dir, name)).isFile();
    } catch {
      return false;
    }
  });
  _commandCache.set(name, found);
  return found;
}

/**
 * Local power-off plan. The dashboard container is the common case:
 * /.dockerenv + privileged + pid:host → reach host systemd through PID 1's
 * mount namespace (no host script needed). Anything else (host process,
 * non-shared PID namespace) falls back to the sudo + host-script contract.
 * @returns {{ file: string, args: string[] }}
 */
export function localShutdownPlan() {
  if (fs.existsSync("/.dockerenv") && commandAvailable("nsenter")) {
    return { file: "nsenter", args: ["-t", "1", "-m", "--", "systemctl", "poweroff"] };
  }
  return localShutdownCommand({ mntNs: hostMountNs() });
}

/**
 * Local invocation. Inside the host mount namespace both `sudo` and the helper
 * resolve against the host's filesystem; without one this is the plain
 * bare-host call.
 * @param {{ bin?: string, mntNs?: string | null, args?: string[] }} [opts]
 * @returns {{ file: string, args: string[] }}
 */
export function localShutdownCommand({
  bin = SHUTDOWN_BIN,
  mntNs = hostMountNs(),
  args = [],
} = {}) {
  const sudoArgs = ["-n", bin, ...args];
  return mntNs
    ? { file: "nsenter", args: [`--mount=${mntNs}`, "--", "sudo", ...sudoArgs] }
    : { file: "sudo", args: sudoArgs };
}

/**
 * Remote command string. Lines are joined with newlines rather than "; " — the
 * line that backgrounds the helper ends in `&`, and `&;` is a syntax error a
 * POSIX shell rejects before the helper or the authorization check can run.
 *
 * `--check` proves passwordless sudo against the helper itself:
 * `sudo -n true` is not authorized by a sudoers rule scoped to the helper, so
 * the old probe failed for exactly the setup the README recommends. The second
 * probe keeps helpers that predate the `--check` contract working when sudo is
 * granted more broadly.
 * @param {string} [bin]
 */
export function remoteShutdownCommand(bin = SHUTDOWN_BIN) {
  return [
    `test -x ${bin} || { echo "missing ${bin}" >&2; exit 127; }`,
    `sudo -n ${bin} --check >/dev/null 2>&1 || sudo -n true >/dev/null 2>&1 || { echo "passwordless sudo required for ${bin}" >&2; exit 126; }`,
    `nohup sudo -n ${bin} >/dev/null 2>&1 &`,
    `sleep 0.3`,
    `exit 0`,
  ].join("\n");
}

/**
 * Start the helper on the dashboard's own host. Resolves once it is detached —
 * the route has already answered the browser by then, because the host (and
 * this process) is about to go down.
 * @param {{ bin?: string, mntNs?: string | null, spawnFn?: typeof spawn }} [opts]
 */
export function spawnLocalShutdown({
  bin = SHUTDOWN_BIN,
  mntNs = hostMountNs(),
  spawnFn = spawn,
} = {}) {
  return new Promise((resolve, reject) => {
    try {
      const { file, args } = localShutdownCommand({ bin, mntNs });
      const child = spawnFn(file, args, { detached: true, stdio: "ignore" });
      // Settle on 'spawn', not on the return of spawn() — a missing binary
      // reports through the async 'error' event, which resolving here would
      // swallow (the caller would log success and the host would stay up).
      child.on("error", (err) => {
        const msg = err?.message || String(err);
        reject(
          new Error(
            /ENOENT|not found/i.test(msg)
              ? `${file} not found — ${bin} is installed on the Spark itself, not in the container`
              : msg
          )
        );
      });
      child.on("spawn", () => {
        child.unref();
        resolve("Shutdown initiated");
      });
    } catch (err) {
      reject(err);
    }
  });
}

function initiateLocalShutdown() {
  return new Promise((resolve, reject) => {
    const { file, args } = localShutdownPlan();
    let child;
    try {
      child = spawn(file, args, { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    let stderr = "";
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-400);
      });
    }
    child.on("error", (err) => {
      const msg = err.message || String(err);
      if (/ENOENT/i.test(msg)) settle(reject, new Error(`${file} not found on this host`));
      else if (/EACCES/i.test(msg)) settle(reject, new Error(`${file} is not executable`));
      else settle(reject, new Error(msg));
    });
    child.on("close", (code) => {
      if (code === 0) {
        settle(resolve, "Shutdown initiated");
      } else {
        const detail = stderr.trim() || "no stderr";
        settle(reject, new Error(`${file} exited ${code}: ${detail}`));
      }
    });
    child.unref();
    // No event within the window — assume the power-off is underway (a dying
    // host may never flush our stdio); reporting success beats "Failed to fetch".
    setTimeout(() => settle(resolve, "Shutdown initiated"), SHUTDOWN_ACK_WINDOW_MS);
  });
}

/**
 * Only treat "host dropped the SSH session mid-shutdown" as success.
 * Connect timeouts / auth / missing script must remain real errors.
 */
function isBenignShutdownSshError(msg) {
  return /ECONNRESET|Connection reset|broken pipe|Connection closed by remote|closed by remote host|Connection to .* closed/i.test(
    String(msg || "")
  );
}

/**
 * Kick off graceful shutdown. Always aims to return quickly so the browser
 * gets a real JSON response instead of "Failed to fetch" when the SSH session
 * drops as the host powers off.
 */
export function initiateSparkShutdown(spark) {
  if (spark.isLocal) return initiateLocalShutdown();

  return sshExec(spark, remoteShutdownCommand(), { timeoutMs: 8000 })
    .then(() => "Shutdown initiated")
    .catch((err) => {
      const msg = err.message || String(err);
      if (isBenignShutdownSshError(msg)) {
        return "Shutdown initiated";
      }
      throw err;
    });
}

/** HTTP status for a shutdown failure message. */
export function shutdownErrorStatus(msg) {
  if (/timed out|connection refused|unreachable|no route|ECONNREFUSED|ETIMEDOUT/i.test(msg)) {
    return 503;
  }
  return 500;
}
