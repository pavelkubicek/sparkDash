/**
 * hostExec — run a command on the HOST from inside the container, streaming.
 *
 * This is the one primitive the launcher needs that nothing else in the repo
 * provides: `sshExec`/`execFile` buffer the whole output, but a model's
 * `start.sh` can run for twenty minutes (`docker pull`, weight load, then a
 * terminal-attached `docker logs -f`) and the UI must watch it live.
 *
 * The *mechanism* — how a root container process becomes the host user inside
 * the host mount namespace — is imported verbatim from HermesProbe, which
 * already solved and tested it:
 *
 *   nsenter --mount=/host/proc/1/ns/mnt -- setpriv --reuid=… --regid=… \
 *     --init-groups -- sh -c "<cmd>"
 *
 * `chooseLocalInvocation` resolves uid/gid/HOME from the HOST passwd
 * (`/host/root/etc/passwd`) so the script writes files as the host user (no
 * root-owned garbage in the repo, no git "dubious ownership"), and
 * `nsenter --mount` gives us the host's `docker` CLI + socket, which the
 * container image does not have. No new bind mount and no new credentials.
 *
 * Killing: the child is its own process group (`detached`), so a cancel can
 * SIGTERM/SIGKILL the whole tree — `sh`, `docker`, the trailing `docker logs
 * -f` — while the *containers* those commands started stay owned by dockerd
 * and survive. That is why job liveness is derived from the container/port
 * probe, never from the job's exit code.
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { HOST_PATHS, MODEL_HOST_USER } from "../config.js";
import { chooseLocalInvocation } from "../collectors/HermesProbe.js";

/** Host mount namespace path, or null when running directly on a host (dev). */
export function hostMountNs() {
  const p = path.join(HOST_PATHS.PROC, "1", "ns", "mnt");
  try {
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** Host passwd text (for uid/gid resolution), best-effort. */
export function hostPasswdText(mntNs) {
  const p = mntNs ? path.join(HOST_PATHS.ROOT, "etc", "passwd") : "/etc/passwd";
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

/**
 * Quote a string for POSIX sh single quotes. Used for every interpolated
 * value so a config value can never become shell syntax.
 * @param {string} value
 */
export function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the shell command that runs `script` (with optional args) inside
 * `dir`. Exported for tests — the shape is asserted there.
 * @param {{dir: string, script: string, args?: string[]}} opts
 */
export function buildScriptCommand({ dir, script, args = [] }) {
  const argStr = args.length ? ` ${args.map((a) => shQuote(a)).join(" ")}` : "";
  return [
    dirGuard(dir),
    scriptGuard(script),
    // `exec` replaces the shell so signals reach the script itself, and the
    // exit code we observe is the script's.
    `exec bash ${shQuote(`./${script}`)}${argStr}`,
  ].join("; ");
}

function dirGuard(dir) {
  return `cd ${shQuote(dir)} || { echo "[hostExec] repo directory missing: ${dir}" >&2; exit 127; }`;
}

function scriptGuard(script) {
  return `test -f ${shQuote(script)} || { echo "[hostExec] script not found: ${script}" >&2; exit 127; }`;
}

/**
 * Build one command that runs several scripts in sequence (an exclusive Start
 * has to stop the incumbent first, and the transcript must show both).
 *
 * Unlike the single-script form this cannot use `exec` (there is more than one
 * step), so the wrapper shell stays as the group leader — which is fine, the
 * kill path targets the whole process group either way. Each step reports its
 * own exit code; a failed step does not abort the chain, because "stop failed
 * but start succeeded" is a much more useful transcript than a silent abort.
 *
 * @param {{dir: string, script: string, args?: string[], label?: string}[]} steps
 */
export function buildChainedCommand(steps) {
  const parts = [];
  for (const [i, s] of steps.entries()) {
    const argStr = s.args?.length ? ` ${s.args.map((a) => shQuote(a)).join(" ")}` : "";
    parts.push(
      `echo ""`,
      `echo "=== ${s.label || s.script} (${s.dir}) ==="`,
      dirGuard(s.dir),
      scriptGuard(s.script),
      `bash ${shQuote(`./${s.script}`)}${argStr}; __rc=$?; echo "[exit] ${s.script}: ${'$'}__rc"`
    );
  }
  // Propagate the LAST step's code — that is the action the user asked for.
  parts.push(`exit $__rc`);
  return parts.join("; ");
}

/**
 * Stream a host command. Resolves when the child exits; never rejects on a
 * non-zero exit (the exit code is reported instead — a failing `stop.sh` is
 * data, not an exception).
 *
 * @param {string} cmd shell body
 * @param {object} [opts]
 * @param {(chunk: string, stream: "stdout"|"stderr") => void} [opts.onData]
 * @param {number} [opts.timeoutMs] hard cap; on expiry the process group is killed
 * @param {AbortSignal} [opts.signal] caller-driven cancel (same kill path)
 * @param {string} [opts.user] host account to drop to (default MODEL_HOST_USER)
 * @param {number} [opts.killGraceMs] grace before SIGKILL after SIGTERM
 * @returns {Promise<{ code: number|null, signal: string|null, timedOut: boolean,
 *   cancelled: boolean, spawned: boolean, error: string|null }>}
 */
export function spawnOnHost(cmd, opts = {}) {
  const {
    onData,
    timeoutMs,
    signal,
    user = MODEL_HOST_USER,
    killGraceMs = 3000,
  } = opts;

  const mntNs = hostMountNs();
  const passwdText = hostPasswdText(mntNs);
  const inv = chooseLocalInvocation({
    mntNs,
    passwdText,
    currentUid: typeof process.getuid === "function" ? process.getuid() : -1,
    user,
    cmd,
  });

  return new Promise((resolve) => {
    /** @type {import("child_process").ChildProcess} */
    let child;
    try {
      child = spawn(inv.file, inv.args, {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, TERM: "dumb" },
      });
    } catch (err) {
      resolve({
        code: null,
        signal: null,
        timedOut: false,
        cancelled: false,
        spawned: false,
        error: `Failed to launch ${inv.file}: ${err?.message || err}`,
      });
      return;
    }

    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let killTimer = null;
    let graceTimer = null;

    const killGroup = (sig) => {
      // Negative pid → the whole process group (sh + docker + any `logs -f`).
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };

    const terminate = (reason) => {
      if (settled || killTimer) return;
      if (reason === "timeout") timedOut = true;
      if (reason === "cancel") cancelled = true;
      killGroup("SIGTERM");
      killTimer = setTimeout(() => {
        graceTimer = setTimeout(() => killGroup("SIGKILL"), killGraceMs);
        graceTimer.unref?.();
        killGroup("SIGKILL");
      }, killGraceMs);
      killTimer.unref?.();
    };

    const timeoutTimer =
      Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => terminate("timeout"), timeoutMs)
        : null;
    timeoutTimer?.unref?.();

    const onAbort = () => terminate("cancel");
    if (signal) {
      if (signal.aborted) terminate("cancel");
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const emit = (stream) => (buf) => {
      if (!onData) return;
      try {
        onData(String(buf), stream);
      } catch {
        /* transcript sink must never kill the pipe */
      }
    };
    child.stdout?.on("data", emit("stdout"));
    child.stderr?.on("data", emit("stderr"));

    // EPIPE/ENOENT from a missing nsenter/setpriv, or a mid-flight spawn error.
    child.on("error", (err) => {
      finish(null, null, `spawn error: ${err?.message || err}`);
    });

    child.on("close", (code, sig) => finish(code, sig, null));

    function finish(code, sig, error) {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (graceTimer) clearTimeout(graceTimer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({
        code: Number.isInteger(code) ? code : null,
        signal: sig || null,
        timedOut,
        cancelled,
        spawned: true,
        error,
      });
    }
  });
}

/**
 * One-shot host command with a capped buffered result (probes). Same invocation
 * as spawnOnHost, convenience wrapper for `docker ps`-style reads.
 * @param {string} cmd
 * @param {{timeoutMs?: number, user?: string}} [opts]
 */
export async function execOnHost(cmd, opts = {}) {
  let out = "";
  let err = "";
  const res = await spawnOnHost(cmd, {
    timeoutMs: opts.timeoutMs ?? 5000,
    user: opts.user,
    onData: (chunk, stream) => {
      if (stream === "stderr") err += chunk;
      else out += chunk;
      if (out.length > 64_000) out = out.slice(-64_000);
    },
  });
  return { ...res, stdout: out, stderr: err };
}
