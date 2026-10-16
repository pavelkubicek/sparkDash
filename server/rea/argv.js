import { SERVER_MANAGED_FLAGS } from "./spec.js";

/**
 * Turns an already validated option set into the argument list for `rea` (never a shell string):
 *
 *   [command, ...positionals, ...flags, "--json"]  (+ "--provider", X for provider workflows, never for "auto")
 *
 * Value forms (chosen so a value can never be read as a flag):
 *   bool         --flag
 *   int, choice  --flag, value          (values cannot start with "-": ranges start at 0, choices are fixed)
 *   path         --flag, value          (absolute or ~/..., so it cannot start with "-" either)
 *   string, json --flag=value           (one element; a leading "-" in the value is harmless)
 *   list         --flag=a --flag=b      intlist  --flag, 1, --flag, 2
 *
 * Elements that are paths on the unit keep the form the validator accepted (absolute, or starting
 * with "~/"): the on-unit program resolves "~/" and rejects anything that escapes after realpath.
 * Output locations are never taken from a request: they are the RUN_OUT placeholder below and the
 * on-unit wrapper substitutes the run's own folder.
 */

/** The wrapper replaces this prefix with `<run>/out` (and creates that parent; the leaf only for "dir"). */
export const RUN_OUT_PREFIX = "@@REA_RUN_OUT@@";

export function runOutToken(argName) {
  return `${RUN_OUT_PREFIX}/${argName}`;
}

const isFlagArg = (a) => !!a.flag;

/** Elements that one flag argument contributes. */
export function flagElements(arg, value) {
  if (arg.kind === "path-run-owned") return [arg.flag, runOutToken(arg.name)];
  if (value === undefined || value === null) return [];
  switch (arg.kind) {
    case "bool":
      return value === true ? [arg.flag] : [];
    case "int":
    case "choice":
    case "path":
      return [arg.flag, String(value)];
    case "string":
    case "json":
      return [`${arg.flag}=${value}`];
    case "list":
      return (Array.isArray(value) ? value : [value]).map((v) => `${arg.flag}=${v}`);
    case "intlist":
      return (Array.isArray(value) ? value : [value]).flatMap((v) => [arg.flag, String(v)]);
    default:
      return [];
  }
}

/** Elements that one positional argument contributes. */
export function positionalElements(arg, value) {
  if (arg.kind === "path-run-owned") return [runOutToken(arg.name)];
  if (value === undefined || value === null) return [];
  if (arg.kind === "list") return (Array.isArray(value) ? value : [value]).map(String);
  return [String(value)];
}

/**
 * @param {object} workflow catalog entry
 * @param {{ targetValue?: string, target2Value?: string, options?: Record<string, unknown>, provider?: string|null }} input
 * @returns {string[]}
 */
export function buildArgv(workflow, { targetValue, target2Value, options = {}, provider = null } = {}) {
  const byName = new Map(workflow.args.map((a) => [a.name, a]));
  const out = [workflow.command];
  for (const p of workflow.positionals) {
    if (p === "$target") {
      if (targetValue !== undefined) out.push(String(targetValue));
    } else if (p === "$target2") {
      if (target2Value !== undefined) out.push(String(target2Value));
    } else {
      const arg = byName.get(p);
      if (arg) out.push(...positionalElements(arg, options[p]));
    }
  }
  for (const arg of workflow.args) {
    if (!isFlagArg(arg)) continue;
    if (arg.kind === "path-run-owned") out.push(...flagElements(arg));
    else out.push(...flagElements(arg, options[arg.name]));
  }
  if (workflow.needsProvider && provider && provider !== "auto") out.push("--provider", provider);
  out.push("--json");
  return out;
}

/** Name of the server-managed flag a user-supplied option name would collide with, or null. */
export function serverManagedFlag(name) {
  const n = String(name || "").replace(/^--/, "").toLowerCase();
  return SERVER_MANAGED_FLAGS.includes(n) ? n : null;
}

/**
 * Last line of defense: every element that looks like a flag must be one this workflow declares
 * (or the two the server appends), the command and the trailing --json must be in place, and no
 * element may carry a control character. Returns an error string or null.
 */
export function verifyArgv(workflow, argv) {
  if (!Array.isArray(argv) || !argv.length) return "Empty argument list";
  if (argv[0] !== workflow.command) return "The command does not match the workflow";
  if (argv[argv.length - 1] !== "--json") return "The argument list must end with --json";
  // flag -> may it appear in the one-element "--flag=value" form?
  const allowed = new Map([["--json", false]]);
  if (workflow.needsProvider) allowed.set("--provider", false);
  for (const a of workflow.args) if (a.flag) allowed.set(a.flag, a.kind === "string" || a.kind === "json" || a.kind === "list");
  for (let i = 1; i < argv.length; i += 1) {
    const el = argv[i];
    if (typeof el !== "string") return "Arguments must be strings";
    if (/[\u0000\r\n]/.test(el)) return "An argument contains a control character";
    if (el.startsWith("-")) {
      const eq = el.indexOf("=");
      const head = eq > 0 ? el.slice(0, eq) : el;
      if (!allowed.has(head)) return `Unexpected flag ${head.slice(0, 40)}`;
      if (eq > 0 && !allowed.get(head)) return `Unexpected value form for ${head.slice(0, 40)}`;
    }
  }
  return null;
}

/** One line shown for a run: the command and its inputs, with secrets and bulky JSON summarized. */
export function displayLine(workflow, { targetDisplay, target2Display, options = {}, provider = null } = {}) {
  const parts = ["rea", workflow.command];
  for (const p of workflow.positionals) {
    if (p === "$target") {
      if (targetDisplay) parts.push(targetDisplay);
    } else if (p === "$target2") {
      if (target2Display) parts.push(target2Display);
    } else {
      const arg = workflow.args.find((a) => a.name === p);
      if (!arg || arg.kind === "path-run-owned" || options[p] === undefined) continue;
      parts.push(summarize(arg, options[p]));
    }
  }
  for (const arg of workflow.args) {
    if (!arg.flag || arg.kind === "path-run-owned" || options[arg.name] === undefined) continue;
    if (arg.kind === "bool") {
      if (options[arg.name] === true) parts.push(arg.flag);
    } else {
      parts.push(`${arg.flag}=${summarize(arg, options[arg.name])}`);
    }
  }
  if (workflow.needsProvider && provider && provider !== "auto") parts.push(`--provider=${provider}`);
  return parts.join(" ").slice(0, 600);
}

function summarize(arg, value) {
  if (arg.secret) return `<${Array.isArray(value) ? value.length : 1} hidden>`;
  if (arg.kind === "json") return `<json ${String(value).length} chars>`;
  if (Array.isArray(value)) return value.length > 4 ? `${value.slice(0, 4).join(",")},+${value.length - 4}` : value.join(",");
  const s = String(value);
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}
