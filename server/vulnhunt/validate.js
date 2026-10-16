import net from "node:net";
import { isAllowedTargetHost, isForbiddenAddress } from "../validate.js";

/**
 * Validation for the one thing a VulnHunter scan request carries: WHAT to scan and how long
 * to let it run. Nothing here is interpolated into a shell string (the values travel as
 * separate NUL-delimited, base64 items, see commands.js), but they are still checked hard so
 * a bad request fails fast with a readable message and a hostile one never reaches the unit.
 *
 * A scan clones the target and then lets an agent harness work on the checkout, so the
 * source is restricted to: an https:// git URL (no credentials, no private-key transports),
 * or an absolute path under the unit user's home directory (confirmed again on the unit).
 */

export const MAX_LABEL = 120;
export const MIN_TIMEOUT_MINUTES = 5;
export const MAX_TIMEOUT_MINUTES = 720;
export const DEFAULT_TIMEOUT_MINUTES = 240;

const URL_PATH_RE = /^\/[A-Za-z0-9._~/-]{1,300}$/;
const LOCAL_PATH_RE = /^(~\/|\/)[A-Za-z0-9._@+=,/-]{1,400}$/;

/** Cloud metadata services reachable by name or by an address `isForbiddenAddress` does not know. */
const METADATA_NAMES = new Set(["metadata", "metadata.google.internal", "metadata.goog", "instance-data", "instance-data.ec2.internal"]);
const METADATA_V4 = new Set(["100.100.100.200", "168.63.129.16", "192.0.0.192"]);

const blockedV4 = (ip) => METADATA_V4.has(ip) || isForbiddenAddress(ip);

/** Eight 16-bit groups of an IPv6 literal (no brackets), or null. */
function ipv6Groups(host) {
  let h = host.toLowerCase();
  const zone = h.indexOf("%");
  if (zone >= 0) h = h.slice(0, zone);
  const dot = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (dot) {
    const o = dot.slice(1).map(Number);
    h = `${h.slice(0, dot.index)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 ? head.length !== 8 : head.length + tail.length > 7) return null;
  const groups = [...head, ...(halves.length === 2 ? Array(8 - head.length - tail.length).fill("0") : []), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * The clone policy on top of server/validate.js: private, loopback and tailnet hosts stay allowed
 * (self-hosted git servers are the common home-lab case), but names and addresses of cloud metadata
 * services are not, including IPv6 forms that embed a blocked IPv4 address (NAT64, 6to4, v4-compatible).
 * Best effort by design: a DNS name can still resolve anywhere. Set VULNHUNT_ALLOWED_HOSTS to pin the
 * hosts a scan may clone from.
 */
export function isBlockedCloneHost(host) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  if (!h || METADATA_NAMES.has(h)) return true;
  if (!isAllowedTargetHost(h)) return true;
  const family = net.isIP(h);
  if (family === 4) return blockedV4(h);
  if (family !== 6) return false;
  const g = ipv6Groups(h);
  if (!g) return true;
  if (g[0] === 0xfd00 && g[1] === 0x0ec2) return true; // AWS IMDS over IPv6 (fd00:ec2::/32)
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  const embedded = [];
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) embedded.push(v4(g[6], g[7])); // NAT64
  if (g[0] === 0x2002) embedded.push(v4(g[1], g[2])); // 6to4
  if (g.slice(0, 6).every((x) => x === 0) && !(g[6] === 0 && g[7] <= 1)) embedded.push(v4(g[6], g[7])); // v4-compatible
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) embedded.push(v4(g[6], g[7])); // v4-translated
  return embedded.some(blockedV4);
}

/** `VULNHUNT_ALLOWED_HOSTS`: comma-separated host names, `*.example.com` allowed. Empty = any host the policy allows. */
export function parseAllowedHosts(value) {
  return String(value ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    // Host names only: a trailing :port is dropped (a bare IPv6 literal has several colons and is kept).
    .map((h) => (/^[^:]+:\d{1,5}$/.test(h) ? h.replace(/:\d{1,5}$/, "") : h))
    .filter((h) => /^(\*\.)?[a-z0-9.:\[\]-]{1,253}$/.test(h));
}

function hostAllowed(host, allowedHosts) {
  if (!allowedHosts.length) return true;
  return allowedHosts.some((p) => (p.startsWith("*.") ? host.endsWith(p.slice(1)) && host.length > p.length - 1 : host === p.replace(/^\[|\]$/g, "")));
}

/**
 * @param {unknown} source `{ type: "url" | "path", value: string }`
 * @param {{ allowedHosts?: string[] }} [opts]
 * @returns {{ ok: true, kind: "url" | "path", value: string } | { ok: false, error: string }}
 */
export function validateSource(source, { allowedHosts = [] } = {}) {
  if (!source || typeof source !== "object") return { ok: false, error: "Choose what to scan: a git URL or a path on the unit" };
  const kind = source.type;
  const raw = typeof source.value === "string" ? source.value.trim() : "";
  if (kind !== "url" && kind !== "path") return { ok: false, error: 'Source type must be "url" or "path"' };
  if (!raw) return { ok: false, error: kind === "url" ? "Enter the repository URL" : "Enter the path of a checkout on the unit" };
  if (/[\0\r\n\t ]/.test(raw)) return { ok: false, error: "The source must not contain spaces or control characters" };

  if (kind === "path") {
    if (!LOCAL_PATH_RE.test(raw)) return { ok: false, error: "The path must be absolute (or start with ~/) and use only letters, digits and . _ @ + = , / -" };
    if (raw.split("/").some((seg) => seg === "..")) return { ok: false, error: "The path must not contain .." };
    return { ok: true, kind, value: raw };
  }

  if (raw.length > 300) return { ok: false, error: "The URL is too long" };
  // URL() would silently collapse dot segments (also percent-encoded ones), turning one path into another.
  if (raw.includes("%") || raw.split("/").some((seg) => seg === ".." || seg === ".")) return { ok: false, error: "The repository path in the URL is not valid" };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: "That is not a valid URL" };
  }
  if (u.protocol !== "https:") return { ok: false, error: "Only https:// repository URLs are supported (use a path for a private checkout already on the unit)" };
  if (u.username || u.password) return { ok: false, error: "The URL must not contain credentials" };
  if (u.search || u.hash) return { ok: false, error: "The URL must not contain a query or fragment" };
  const host = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
  if (isBlockedCloneHost(host)) return { ok: false, error: "That host is not allowed (link-local, cloud metadata and reserved addresses are blocked)" };
  if (!hostAllowed(host.toLowerCase(), allowedHosts)) return { ok: false, error: "That host is not in this dashboard's VULNHUNT_ALLOWED_HOSTS list" };
  if (!URL_PATH_RE.test(u.pathname) || u.pathname.split("/").some((seg) => seg === "..")) {
    return { ok: false, error: "The repository path in the URL is not valid" };
  }
  return { ok: true, kind, value: `${u.protocol}//${u.host}${u.pathname}` };
}

/**
 * Whole request body -> a normalized scan request, or a readable error.
 * `authorized` is an explicit attestation; the dual-use nature of the tool makes it mandatory.
 */
export function validateScanRequest(body, opts = {}) {
  const b = body && typeof body === "object" ? body : {};
  if (b.authorized !== true) {
    return { ok: false, error: "Confirm that you are authorized to scan this code before starting" };
  }
  const src = validateSource(b.source, opts);
  if (!src.ok) return src;

  const readOnly = b.readOnly === false ? false : true;
  // Letting the harness execute code (dependencies, exploit tests) is a separate, explicit decision.
  if (!readOnly && b.confirmExecute !== true) {
    return { ok: false, error: "Allowing the scan to execute code on the unit needs its own confirmation" };
  }

  let timeoutMinutes = DEFAULT_TIMEOUT_MINUTES;
  if (b.timeoutMinutes != null) {
    const strict = typeof b.timeoutMinutes === "number" || (typeof b.timeoutMinutes === "string" && /^\d{1,4}$/.test(b.timeoutMinutes.trim()));
    const n = strict ? Number(b.timeoutMinutes) : NaN;
    if (!Number.isInteger(n) || n < MIN_TIMEOUT_MINUTES || n > MAX_TIMEOUT_MINUTES) {
      return { ok: false, error: `Time limit (the whole scan, clone included) must be a whole number of minutes between ${MIN_TIMEOUT_MINUTES} and ${MAX_TIMEOUT_MINUTES}` };
    }
    timeoutMinutes = n;
  }

  const label = typeof b.label === "string" ? b.label.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, MAX_LABEL) : "";
  return { ok: true, kind: src.kind, value: src.value, readOnly, timeoutMinutes, label };
}

/** The one line shown for a run (history, terminal header). */
export function displayLine({ kind, value, readOnly, timeoutMinutes }) {
  return `vulnhunt ${kind === "url" ? "clone" : "local checkout"} ${value} (${readOnly ? "read-only requested" : "may execute code"}, up to ${timeoutMinutes} min)`;
}

/** Argument list for the on-unit wrapper: kind, source, read-only flag, time limit in seconds. */
export function scanArgv({ kind, value, readOnly, timeoutMinutes }) {
  return [kind, value, readOnly ? "1" : "0", String(timeoutMinutes * 60)];
}

const INSTALL_DIR_RE = /^(~\/|\/)[A-Za-z0-9._@+=,/-]{1,300}$/;

function installDir(v, label, { required }) {
  const raw = typeof v === "string" ? v.trim() : "";
  if (!raw) return required ? { error: `${label} is required` } : { value: "" };
  if (!INSTALL_DIR_RE.test(raw)) return { error: `${label} must be an absolute path (or start with ~/) and use only letters, digits and . _ @ + = , / -` };
  if (raw.split("/").some((seg) => seg === ".." || seg === ".")) return { error: `${label} must not contain . or .. segments` };
  const normalized = raw.replace(/\/+$/, "");
  if (normalized === "" || normalized === "~") return { error: `${label} must be a directory below the home directory` };
  return { value: normalized };
}

/** Where the installer puts the skill (and, optionally, the agent definition): paths on the unit, checked again there. */
export function validateInstallRequest(body) {
  const b = body && typeof body === "object" ? body : {};
  const skills = installDir(b.skillsDir, "Skills directory", { required: true });
  if (skills.error) return { ok: false, error: skills.error };
  const agents = installDir(b.agentsDir, "Agents directory", { required: false });
  if (agents.error) return { ok: false, error: agents.error };
  return { ok: true, skillsDir: skills.value, agentsDir: agents.value };
}

/**
 * The harness's headless one-shot command line. It is written to a file only the unit's user can read
 * and is never returned by the API; the dashboard only ever shows the name of its program.
 */
export function validateHostCommand(body) {
  const raw = body && typeof body === "object" && typeof body.command === "string" ? body.command.trim() : "";
  if (!raw) return { ok: false, error: "Enter the command that runs your harness headlessly" };
  if (raw.length > 500) return { ok: false, error: "The command is too long (500 characters at most)" };
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, error: "The command must be a single line without control characters" };
  if (raw.startsWith("-")) return { ok: false, error: "The command must start with a program name" };
  return { ok: true, command: raw };
}
