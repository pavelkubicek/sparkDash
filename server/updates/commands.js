/**
 * On-unit programs for the Updates page. The scripts live in ./scripts as real shell files;
 * this module wraps one of them for the unit and parses what it prints.
 *
 * Nothing from a request ever reaches a shell as script text. The script body and each argument
 * travel base64-encoded and are decoded into variables, then handed to the script as positional
 * parameters. Privilege: root runs it directly, anyone else uses `sudo -S` with a password typed
 * in the dashboard (one action at a time). An accepted password the person asked to keep is
 * remembered encrypted in the shared sudo vault (server/storage/sudoVault.js, keyed by the account
 * key of util/sudoPasswordGuard.js) and used only by the daily index refresh and remembered
 * actions — never sent back to the browser. That
 * password arrives in $SPARKDASH_SUDO_PW (set by the runner from stdin), is moved to a plain
 * variable at once and is only ever piped to sudo. Same semantics as server/storage/commands.js.
 */
import fs from "node:fs";

const SCRIPT_DIR = new URL("./scripts/", import.meta.url);
const read = (name) => fs.readFileSync(new URL(name, SCRIPT_DIR), "utf8");

const COMMON = read("common.sh");
const CHECK = read("check.sh");
const SCRIPTS = Object.freeze({
  // The sudo-free check. refresh and install append it so those answer with the fresh state too.
  check: { body: CHECK, shell: "sh", elevate: false },
  refresh: { body: `${read("refresh.sh")}\n${CHECK}`, shell: "sh", elevate: true },
  install: { body: `${read("install.sh")}\n${CHECK}`, shell: "sh", elevate: true },
  // `status` runs unprivileged; `on`/`off` come elevated from the route.
  dashboard: { body: read("dashboard.sh"), shell: "sh", elevate: false },
});

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

/** The sudo gate of server/storage/commands.js (not exported there), same wording and codes. */
function sudoGate(password) {
  return [
    "SUDO_ERR=''",
    "need_sudo() {",
    '  [ -z "$SUDO" ] && return 0',
    "  command -v sudo >/dev/null 2>&1 || { SUDO_ERR=__missing__; return 1; }",
    password
      ? "  SUDO_ERR=$(printf '%s\\n' \"$PW\" | LC_ALL=C sudo -k -S -p '' true 2>&1 >/dev/null) && return 0"
      : "  sudo -n true >/dev/null 2>&1 && return 0",
    "  return 1",
    "}",
    "need_sudo || { case \"$SUDO_ERR\" in",
    '  __missing__) fail no-sudo "sudo is not installed on this Spark" ;;',
    password
      ? [
          '  "") fail bad-password "The sudo password was not accepted" ;;',
          '  *"incorrect password"*|*"Sorry, try again"*|*"password is required"*|*"Authentication failure"*) fail bad-password "The sudo password was not accepted" ;;',
        ].join("\n")
      : '  "") fail no-sudo "This needs administrator rights, and sudo on this Spark asks for a password" ;;',
    '  *) fail no-sudo "sudo refused the request: $(clean "$SUDO_ERR")" ;;',
    "esac; }",
  ].join("\n");
}

/**
 * The program text to send to a unit.
 * @param {keyof typeof SCRIPTS} name
 * @param {{ args?: (string | number)[], elevate?: boolean, password?: boolean }} [opts]
 *   `password`: a sudo password will arrive on stdin (see runProgram's `input`).
 */
export function buildProgram(name, { args = [], elevate = SCRIPTS[name]?.elevate, password = false } = {}) {
  const script = SCRIPTS[name];
  if (!script) throw new Error(`unknown updates program: ${name}`);
  const argList = args.map(String);
  if (argList.some((a) => a.includes("\0"))) throw new Error("argument contains a NUL byte");
  const inner = `${COMMON}\n${script.body}`;
  // The tag in $0 is the program's name in the clear: what arrives over the wire is still
  // base64, but a log line or a test can tell the four programs apart without decoding.
  const run = `${script.shell} -c "$BODY" sparkdash-updates:${name} "$@"`;
  const lines = [
    "set -u",
    // The OUTER sh calls fail/clean too — the sudoGate catch-all and the shell guard do — so it
    // carries the helpers itself. Without this a sudo refusal died with "fail: not found" on
    // stderr and the transport reported a bogus unreachable instead of no-sudo/bad-password.
    // The body keeps its own copy (inner sh); the duplication is harmless.
    COMMON,
    ...(elevate && password
      ? [
          "PW=${SPARKDASH_SUDO_PW-}",
          "unset SPARKDASH_SUDO_PW",
          "spw_sudo() { printf '%s\\n' \"$PW\" | LC_ALL=C sudo -S -p '' \"$@\"; }",
        ]
      : []),
    'SUDO=""',
    elevate ? `[ "$(id -u)" = 0 ] || SUDO="${password ? "spw_sudo" : "sudo -n"}"` : ":",
    sudoGate(elevate && password),
    "dec() { printf '%s' \"$1\" | base64 -d; }",
    `command -v ${script.shell} >/dev/null 2>&1 || fail no-${script.shell} "${script.shell} is not installed on this Spark"`,
    `BODY=$(dec '${b64(inner)}')`,
    argList.length === 0 ? "set --" : `set -- ${argList.map((a) => `"$(dec '${b64(a)}')"`).join(" ")}`,
    `$SUDO ${run}`,
  ];
  return lines.join("\n");
}

/** KEY=value lines a program answered with; the last line for a key wins, junk lines are ignored. */
export function parseKv(out) {
  const res = {};
  for (const line of String(out ?? "").split("\n")) {
    const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m) res[m[1]] = m[2];
  }
  return res;
}

const decodeJson = (b64text) => {
  if (typeof b64text !== "string" || !b64text) return null;
  try {
    return JSON.parse(Buffer.from(b64text, "base64").toString("utf8"));
  } catch {
    return null;
  }
};

const str = (v) => (typeof v === "string" ? v : "");
const num = (v) => (Number.isFinite(v) ? v : 0);

/** APT_B64 → [{ name, newVersion, oldVersion }]; null when the part failed (caller keeps the old list). */
export function parseAptList(b64text) {
  const arr = decodeJson(b64text);
  if (!Array.isArray(arr)) return null;
  return arr
    .filter((r) => r && typeof r === "object" && str(r.name))
    .map((r) => ({ name: str(r.name), newVersion: str(r.newVersion), oldVersion: str(r.oldVersion) }));
}

/** SIM_B64 → { upgrades, kept, removals[] }; null when the part failed. */
export function parseSim(b64text) {
  const o = decodeJson(b64text);
  if (!o || typeof o !== "object") return null;
  return {
    upgrades: num(o.upgrades),
    kept: num(o.kept),
    removals: Array.isArray(o.removals) ? o.removals.map(str).filter(Boolean) : [],
  };
}

/** FW_STATE + FW_B64 → { count, devices } | null (missing fwupd), "error" signalled by the caller. */
export function parseFirmware(state, b64text) {
  if (state !== "ok") return null;
  const o = decodeJson(b64text);
  if (!o || typeof o !== "object") return { count: 0, devices: [] };
  const devices = Array.isArray(o.devices)
    ? o.devices.filter((d) => d && typeof d === "object").map((d) => ({ name: str(d.name), current: str(d.current), available: str(d.available) }))
    : [];
  return { count: num(o.count), devices };
}

const DASHBOARD_UNITS = Object.freeze(["dgx-dashboard.service", "dgx-dashboard-admin.service"]);

/** D1_* / D2_* lines → the two Dashboard service units the contract asks for. */
export function parseDashboard(res) {
  const units = [];
  for (let i = 1; i <= DASHBOARD_UNITS.length; i += 1) {
    const unit = res[`D${i}_UNIT`] || DASHBOARD_UNITS[i - 1];
    const mem = res[`D${i}_MEM`];
    const pid = res[`D${i}_PID`];
    units.push({
      unit,
      enabled: res[`D${i}_ENABLED`] || "not-found",
      active: res[`D${i}_ACTIVE`] || "unknown",
      memoryBytes: /^\d+$/.test(mem || "") ? Number(mem) : null,
      mainPid: /^\d+$/.test(pid || "") ? Number(pid) : null,
    });
  }
  return units;
}

export { DASHBOARD_UNITS };
export { parseSudoPassword } from "../storage/commands.js";
