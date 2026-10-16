/**
 * The REA workflow catalog, as data.
 *
 * Built ONLY from commands that exist in rea-agents 6.4.0 (`rea --help`; arguments, option names,
 * types, choices and ranges come from each command's own help and `--schema`; side effects come
 * from the package's own tool effect audit). Source of truth for: request validation
 * (validate.js), building the argument list (argv.js) and the form the page renders
 * (served by GET /api/rea/spec through `publicSpec()`).
 *
 * Argument kinds:
 *   bool      --flag                              int        --flag N (min / max)
 *   string    --flag=text (pattern, maxLength)    choice     --flag one-of
 *   list      --flag=a --flag=b (string items)    intlist    --flag 1 --flag 2
 *   path      absolute or ~/ path on the unit, checked like the target; --flag PATH or positional
 *   json      inline JSON text (jsonType object|array), --flag=<json>
 *   path-run-owned  never accepted from a request: the on-unit wrapper owns the output location
 *
 * Positional arguments have `flag: null` and `positional: true`; the order they are passed in is
 * `positionals` (`"$target"` / `"$target2"` stand for the validated targets).
 *
 * Effect model (fail closed; the request never supplies any of it):
 *   execClass  static           reads the supplied files with REA's own code only
 *              native-provider  starts an analysis engine / helper program, never runs the target
 *              executes-target  launches, drives or observes a live target (needs confirmExecute)
 *              device           talks to an attached Android device through adb (needs confirmExecute)
 *              network          contacts a live endpoint, e.g. a loopback debugging port (needs confirmExecute)
 *
 * Server-managed, never user-set: --json / --format / --filter-output / --full-output / --token-*,
 * --provider (its own request field), --snapshot, --overwrite, --client and every output location.
 */

export const GROUPS = Object.freeze([
  { id: "javascript", label: "JavaScript/Electron", help: "Static analysis of JavaScript and Electron applications and their packages." },
  { id: "managed", label: "Managed (.NET)", help: "Static inspection of .NET assemblies; nothing is loaded or run." },
  { id: "native", label: "Native binaries", help: "Decompile, search, trace and read native executables through Ghidra, Hopper or IDA." },
  { id: "layout", label: "Binary layout/diagnostics", help: "Offline ELF layout, recorded crashes, EVM bytecode and PE resources." },
  { id: "android", label: "Android/APK", help: "Android package inspection and resource decoding." },
  { id: "apple", label: "Apple bundles", help: "Mach-O, plists, asset catalogs, interface files and dyld resolution." },
  { id: "firmware", label: "Firmware", help: "Firmware region inspection and extraction (never executed)." },
  { id: "evidence", label: "Evidence", help: "Import, export, compare and reconcile Evidence bundles and reconstruction ledgers." },
  { id: "web-captures", label: "Web captures (HAR)", help: "Saved network captures, exported page scripts and source maps." },
  { id: "process", label: "Process capture", help: "Run a scenario process and compare captures." },
  { id: "browser", label: "Browser/Web runtime", help: "Pages in a Chrome-family browser you started with a loopback debugging port." },
  { id: "electron", label: "Electron/JS runtime", help: "Electron pages and Node/V8 inspector targets on a loopback port." },
  { id: "native-runtime", label: "Native runtime", help: "Observe or drive a live native application." },
  { id: "adb-read", label: "ADB device (read)", help: "Read-only questions about an attached Android device." },
  { id: "adb-write", label: "ADB device (mutating)", help: "Install, uninstall, push, start and stop on a device. Off unless the dashboard server enables device writes." },
  { id: "jeb", label: "JEB", help: "JEB projects through a JEB client you started that serves MCP." },
]);

export const EXEC_CLASSES = Object.freeze([
  { id: "static", label: "Static", help: "Reads files only; nothing is launched.", needsConfirm: false },
  { id: "native-provider", label: "Analysis engine", help: "Starts an analysis engine or helper program on the unit. The target is never run.", needsConfirm: false },
  { id: "executes-target", label: "Runs the target", help: "Launches, drives or observes a live application with the unit user's permissions.", needsConfirm: true },
  { id: "device", label: "Android device", help: "Talks to an attached Android device through adb.", needsConfirm: true },
  { id: "network", label: "Live endpoint", help: "Contacts a running debugging endpoint on the unit's loopback interface.", needsConfirm: true },
]);

/** Commands that exist in the CLI but are not offered as a one-shot workflow, with the reason. */
export const SKIPPED = Object.freeze([
  { command: "setup", reason: "Edits agent client configuration files; the dashboard never runs it (and never passes --client)." },
  { command: "uninstall", reason: "Removes REA-owned agent configuration; the dashboard manages its own pinned install instead." },
  { command: "update", reason: "Would replace the pinned, integrity-checked install; updates go through the dashboard installer." },
  { command: "doctor", reason: "Handled by the status check (readiness, providers, engines), not a run." },
  { command: "providers", reason: "Handled by the status check (provider availability)." },
  { command: "capabilities", reason: "Handled by the status check (provider capabilities and effects)." },
  { command: "inspect-analysis-view", reason: "Served by the Result view of a finished run (collection paging), not as its own workflow." },
  { command: "completions", reason: "Prints a shell completion script; nothing to analyze." },
  { command: "mcp", reason: "Registers REA as an MCP server in an agent client; interactive and out of scope." },
]);

// ── patterns (sources; compiled on demand by validate.js) ──────────────────────────────────────
export const PATTERNS = Object.freeze({
  SERIAL: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$",
  PKG: "^[A-Za-z][A-Za-z0-9_]{0,63}(\\.[A-Za-z0-9_]{1,64}){0,15}$",
  PKG_QUERY: "^[A-Za-z0-9._]{1,100}$",
  DEVPATH: "^/[A-Za-z0-9._@+=,/ -]{0,400}$",
  ENDPOINT: "^http://(127\\.0\\.0\\.1|localhost|\\[::1\\]):[0-9]{1,5}$",
  ENDPOINT_LITERAL: "^http://(127\\.0\\.0\\.1|\\[::1\\]):[0-9]{1,5}$",
  TARGET_ID: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
  ORIGIN: "^https?://[A-Za-z0-9.\\[\\]:-]{1,200}$",
  CLASS: "^[A-Za-z_$][A-Za-z0-9_$.]{0,299}$",
  METHOD: "^[A-Za-z_$<][A-Za-z0-9_$<>]{0,199}$",
  SYMBOL: "^[\\x20-\\x7E]{1,300}$",
  TEXT: "^[^\\u0000-\\u001f\\u007f]{1,300}$",
  REL: "^[A-Za-z0-9._ -]{1,120}(/[A-Za-z0-9._ -]{1,120}){0,15}$",
  URL: "^https?://[A-Za-z0-9._~:/?#\\[\\]@!$&'()*+,;=%-]{1,500}$",
  ACTION: "^[A-Za-z][A-Za-z0-9_.]{0,199}$",
  COMPONENT: "^[A-Za-z0-9_.]{1,100}/[A-Za-z0-9_.$]{1,200}$",
  DATA_URI: "^[A-Za-z][A-Za-z0-9+.-]{0,20}:[^\\u0000-\\u001f\\u007f\\s]{0,400}$",
  EXTRA: "^(string|boolean|int|long|float):[A-Za-z0-9_.]{1,100}:[^\\u0000-\\u001f\\u007f]{0,300}$",
  SETTING_KEY: "^[A-Za-z0-9_.:-]{1,100}$",
});

// ── argument constructors ──────────────────────────────────────────────────────────────────────
const flagArg = (name, kind, help, o = {}) => ({ name, flag: `--${name}`, kind, help, ...o });
const bool = (name, help, o) => flagArg(name, "bool", help, o);
const int = (name, help, min, max, o) => flagArg(name, "int", help, { min, max, ...o });
const str = (name, help, o) => flagArg(name, "string", help, { maxLength: 300, ...o });
const choice = (name, help, choices, o) => flagArg(name, "choice", help, { choices, ...o });
const list = (name, help, o) => flagArg(name, "list", help, { maxItems: 20, maxLength: 300, ...o });
const intlist = (name, help, o) => flagArg(name, "intlist", help, { min: 0, max: 100000000, maxItems: 100, ...o });
const pathFlag = (name, help, o) => flagArg(name, "path", help, o);
const jsonFlag = (name, help, jsonType, o) => flagArg(name, "json", help, { jsonType, maxLength: 8000, ...o });
const pos = (name, kind, help, o = {}) => ({ name, flag: null, positional: true, kind, required: true, help, ...o });
const posStr = (name, help, pattern, o) => pos(name, "string", help, { pattern, maxLength: 300, ...o });
const posInt = (name, help, min, max, o) => pos(name, "int", help, { min, max, ...o });
const posPath = (name, help, o) => pos(name, "path", help, o);
const posChoice = (name, help, choices, o) => pos(name, "choice", help, { choices, ...o });
const outDir = (name) => ({ name, flag: null, positional: true, kind: "path-run-owned", outputKind: "absent-dir", required: true, help: "Written by the dashboard into the run's own folder." });
const outFile = (name) => ({ name, flag: null, positional: true, kind: "path-run-owned", outputKind: "file", required: true, help: "Written by the dashboard into the run's own folder." });
const outFlagDir = (name) => ({ name, flag: `--${name}`, kind: "path-run-owned", outputKind: "dir", required: false, help: "Written by the dashboard into the run's own folder." });

const INTEGRITY = () => choice("integrity-policy", "What to do when the application's declared integrity data does not match.", ["fail", "record-and-continue"], { default: "fail" });
const TARGET_FORMAT = () => choice("target-format", "Interpret a headerless file as a DOS COM program.", ["dos-com"]);
const ALLOWED_ORIGINS = () => list("allowed-origins", "Only observe pages whose origin is exactly one of these (e.g. http://localhost:3000).", { pattern: PATTERNS.ORIGIN, maxLength: 200 });
const OBS_MS = (def) => int("observation-ms", "How long to observe, in milliseconds.", 0, 600000, { default: def });
const OBS_MS1 = (def) => int("observation-ms", "How long to observe, in milliseconds.", 1, 600000, { default: def });

const PU = Object.freeze(["path", "upload"]);

/** effect flags: L launches a process, N network, W writes files, M mutates the device. Provider use is derived. */
function fx(flags, usesProvider) {
  const f = String(flags || "");
  return { launchesProcess: f.includes("L"), network: f.includes("N"), writesFs: f.includes("W"), mutatesDevice: f.includes("M"), usesProvider: !!usesProvider };
}

/**
 * @param {string} id command name (also the workflow id)
 * @param {string} group
 * @param {string} label
 * @param {string} blurb
 * @param {string} execClass
 * @param {string} flags see fx()
 * @param {object} [o] { targets, tl, t2l, args, pos, provider, prereq, timeout, shape, view, oneOf, needsNote }
 */
function W(id, group, label, blurb, execClass, flags, o = {}) {
  const targets = o.targets ?? 1;
  const needsProvider = !!o.provider;
  const args = [...(o.args || [])];
  if (needsProvider && !args.some((x) => x.name === "target-format")) args.push(TARGET_FORMAT());
  const positionalArgs = args.filter((x) => x.positional).map((x) => x.name);
  const positionals = o.pos || [...(targets >= 1 ? ["$target"] : []), ...(targets >= 2 ? ["$target2"] : []), ...positionalArgs];
  const defaultTimeout = o.timeout ?? { static: 10, "native-provider": 60, "executes-target": 15, device: 10, network: 5 }[execClass];
  return {
    id,
    label,
    group,
    blurb,
    command: id,
    execClass,
    effects: fx(flags, needsProvider || o.usesProvider),
    targetKinds: targets ? [...PU] : [],
    targets,
    targetLabel: targets ? o.tl || "File or folder on the unit" : null,
    target2Label: targets >= 2 ? o.t2l || "Second file" : null,
    needsProvider,
    prerequisites: o.prereq || [],
    args,
    positionals,
    requireOneOf: o.oneOf || null,
    resultShape: o.shape || "generic",
    defaultTimeoutMinutes: defaultTimeout,
    viewable: !!o.view,
  };
}

const JSON_IN = "JSON input file (upload it or give its path)";
const JSON_ARGS = () => [];

export const WORKFLOWS = Object.freeze([
  // ── JavaScript / Electron ──────────────────────────────────────────────────────────────────────
  W("analyze-javascript-application", "javascript", "Analyze a JavaScript/Electron application", "Statically reconstructs modules, imports, source maps, routes and IPC from an ASAR or an extracted application folder.", "static", "", {
    tl: "ASAR file or extracted application folder", timeout: 30, shape: "javascript-app", view: true,
    args: [
      int("max-heap-mb", "Maximum V8 old-space heap for the isolated source analyzer, in MiB.", 128, 16384, { default: 1024 }),
      int("analysis-timeout-ms", "Maximum time per JavaScript source, in milliseconds. On timeout partial Evidence is returned.", 1, 7200000, { default: 300000 }),
      choice("artifact-format", "Application artifact format.", ["auto", "asar", "directory"], { default: "auto" }),
      INTEGRITY(),
    ],
  }),
  W("recover-javascript-sources", "javascript", "Recover JavaScript sources", "Splits one bundled JavaScript file into readable modules with provenance and verified files.", "native-provider", "LW", {
    tl: "UTF-8 JavaScript file", timeout: 30, prereq: ["wakaru"],
    args: [
      choice("extraction-mode", "How module boundaries are found.", ["structural", "heuristic", "inspection"]),
      choice("rewrite-level", "Upstream syntax recovery level (runtime equivalence stays unknown).", ["minimal", "standard", "aggressive"]),
      outDir("outputDirectory"),
    ],
    pos: ["$target", "outputDirectory"],
  }),
  W("inspect-artifact", "javascript", "Inspect an application package", "Inspects one application or package and returns every available observation and next probe.", "native-provider", "LW", {
    tl: "Application or package", args: [INTEGRITY()],
  }),
  W("extract-artifact", "javascript", "Extract a package safely", "Extracts all regular contents of an application or package with safe path handling. REA writes them to a temporary directory it chooses (its location is in the result); it is not removed with the run.", "native-provider", "LW", {
    tl: "Application or package", args: [INTEGRITY()],
  }),
  W("trace-application-feature", "javascript", "Trace a feature through application Evidence", "Follows a typed seed (route, IPC channel, module...) through authenticated application Evidence.", "static", "", { tl: JSON_IN, args: JSON_ARGS() }),
  W("trace-javascript-semantics", "javascript", "Trace JavaScript semantic relations", "Traces bounded static semantic relations through authenticated application Evidence.", "static", "", { tl: JSON_IN }),
  W("compare-application-versions", "javascript", "Compare application versions", "Compares two authenticated JavaScript Application Graph versions.", "static", "", { tl: JSON_IN }),
  W("compare-source-to-bundle", "javascript", "Compare source to a bundle", "Compares committed historical source with authenticated application Evidence.", "static", "", { tl: JSON_IN }),
  W("compare-javascript-export-shapes", "javascript", "Compare export shapes", "Compares exact static JavaScript export return shapes without executing anything.", "static", "", { tl: JSON_IN }),

  // ── Managed (.NET) ─────────────────────────────────────────────────────────────────────────────
  W("inspect-managed-artifact", "managed", "Inspect a .NET assembly", "Reads PE/CLI identity (name, version, MVID, references) without loading target code.", "static", "", { tl: "Managed PE executable or assembly" }),
  W("inspect-managed-members", "managed", "List .NET members", "Reads PE/CLI metadata members, signatures and CIL anchors without loading target code.", "static", "", { tl: "Managed PE executable or assembly" }),
  W("inspect-managed-native-boundaries", "managed", "Find P/Invoke boundaries", "Lists PInvoke and native implementation boundary declarations of an assembly.", "static", "", { tl: "Managed PE executable or assembly" }),
  W("compare-managed-members", "managed", "Compare .NET builds", "Compares member inventories by exact declared type, name and signature; names alone never match.", "static", "", { targets: 2, tl: "Baseline assembly", t2l: "Candidate assembly" }),
  W("verify-managed-native-boundaries", "managed", "Verify P/Invoke declarations", "Verifies managed P/Invoke declarations against authenticated native Evidence.", "static", "", { tl: JSON_IN }),
  W("import-managed-reconstruction", "managed", "Import a managed reconstruction", "Imports decompiler-produced reconstruction and checks it against exact static member evidence.", "static", "", { tl: JSON_IN }),
  W("project-managed-application-graph", "managed", "Project a managed application graph", "Projects authenticated managed static Evidence into an application graph.", "static", "", { tl: JSON_IN }),

  // ── Native binaries (provider-backed) ──────────────────────────────────────────────────────────
  W("analyze", "native", "Analyze an app or program", "Gets an overview of an app or native program (identity, entry points, notable strings and symbols).", "native-provider", "L", {
    provider: true, tl: "App, program or analysis database", args: [INTEGRITY()],
  }),
  W("inspect", "native", "Inspect with evidence", "Inspects an app overview and returns evidence for each observation.", "native-provider", "L", { provider: true, tl: "App, program or analysis database" }),
  W("decompile", "native", "Decompile a procedure", "Reads one part of an app as code (pseudocode) by procedure name or address.", "native-provider", "L", {
    provider: true, tl: "App or program",
    args: [str("procedure", "Procedure name or address.", { pattern: PATTERNS.SYMBOL })],
  }),
  W("function", "native", "Analyze one function", "Analyzes one complete function with evidence: pseudocode, assembly, callers, callees, references.", "native-provider", "L", {
    provider: true, tl: "App or program", shape: "native-function", view: true,
    args: [str("procedure", "Procedure name or address.", { pattern: PATTERNS.SYMBOL })],
  }),
  W("instructions", "native", "Read raw instructions", "Reads every raw instruction of a procedure without decompiling.", "native-provider", "L", {
    provider: true, tl: "App or program",
    args: [str("procedure", "Procedure name or address.", { pattern: PATTERNS.SYMBOL })],
  }),
  W("xrefs", "native", "List references", "Lists bounded references to an analyzed address or symbol.", "native-provider", "L", {
    provider: true, tl: "App or program",
    args: [str("address", "Address or symbol name.", { pattern: PATTERNS.SYMBOL, required: true })],
  }),
  W("search", "native", "Search strings or procedures", "Searches every analyzed string or procedure name.", "native-provider", "L", {
    provider: true, tl: "App or program",
    args: [
      str("pattern", "Literal text or regular expression.", { pattern: PATTERNS.TEXT, required: true }),
      choice("kind", "Which analyzed items to search.", ["strings", "procedures"], { default: "strings" }),
      choice("mode", "Interpret the pattern as literal text or a regular expression.", ["literal", "regex"], { default: "literal" }),
      bool("case-sensitive", "Match letter case exactly."),
    ],
  }),
  W("trace", "native", "Trace a feature", "Traces a literal feature (string, name) through analyzed references.", "native-provider", "L", {
    provider: true, tl: "App or program",
    args: [str("query", "Literal feature to trace.", { pattern: PATTERNS.TEXT, required: true }), bool("case-sensitive", "Match letter case exactly.")],
  }),
  W("inspect-native-api", "native", "Reconstruct an API boundary", "Reconstructs one native function's API boundary with evidence.", "native-provider", "L", {
    provider: true, tl: "App or program",
    args: [posStr("address", "Procedure name or exact address.", PATTERNS.SYMBOL)],
  }),
  W("inspect-native-data-type", "native", "Inspect a data type", "Inspects one recovered database type or typed data object.", "native-provider", "L", {
    provider: true, tl: "Native executable or app", oneOf: ["type", "address"],
    args: [
      str("type", "Exact database type category path.", { pattern: PATTERNS.SYMBOL }),
      str("address", "Exact native address.", { pattern: PATTERNS.SYMBOL }),
    ],
  }),
  W("inspect-native-instruction", "native", "Inspect one instruction", "Inspects one native instruction with decoded operand facts.", "native-provider", "L", {
    provider: true, tl: "Native executable or app", args: [posStr("address", "Exact native address.", PATTERNS.SYMBOL)],
  }),
  W("inspect-native-load-image", "native", "Verify the loaded image", "Verifies loaded native bytes, source mappings, relocations and entry point.", "native-provider", "L", { provider: true, tl: "Local executable" }),
  W("inspect-native-dispatch-metadata", "native", "Objective-C / Swift dispatch metadata", "Inspects typed Objective-C and Swift dispatch metadata.", "native-provider", "L", {
    provider: true, tl: "Mach-O or app",
    args: [int("max-records", "Maximum symbol records to inspect.", 1, 20000, { default: 5000 })],
  }),
  W("resolve-native-call-targets", "native", "Resolve a call site", "Resolves one static native call site to its targets.", "native-provider", "L", {
    provider: true, tl: "Native executable or app", args: [posStr("address", "Exact native address.", PATTERNS.SYMBOL)],
  }),
  W("read-bytes", "native", "Read bytes", "Reads exact provider memory bytes at one analysis address.", "native-provider", "L", {
    provider: true, tl: "Local executable",
    args: [posStr("address", "Exact provider memory address.", PATTERNS.SYMBOL), int("length", "Number of bytes to read.", 1, 1048576, { default: 256 })],
  }),
  W("address-to-file-offset", "native", "Address to file offset", "Resolves an analysis address to its original file byte offset.", "native-provider", "L", {
    provider: true, tl: "Local executable", args: [posStr("address", "Exact provider memory address.", PATTERNS.SYMBOL)],
  }),
  W("trace-native-ui-action", "native", "Trace a UI action", "Traces a compiled UI action selector to its native handler and direct callees.", "native-provider", "L", {
    provider: true, tl: "Application or executable",
    args: [
      posStr("action", "A unique compiled UI action selector or interface object ID.", PATTERNS.SYMBOL),
      int("max-depth", "Maximum relationship depth.", 0, 32, { default: 8 }),
      int("max-nodes", "Maximum returned graph nodes.", 1, 2000, { default: 250 }),
      int("max-edges", "Maximum returned graph edges.", 1, 5000, { default: 500 }),
    ],
  }),
  W("trace-native-values", "native", "Trace values", "Traces bounded native def-use and call dependencies from one procedure.", "native-provider", "L", {
    provider: true, tl: "Native executable or app",
    args: [
      posStr("procedure", "Explicit native procedure symbol or address.", PATTERNS.SYMBOL),
      int("max-depth", "Maximum call traversal depth.", 0, 16, { default: 3 }),
      int("max-functions", "Maximum function decompilations.", 1, 64, { default: 16 }),
      int("max-call-sites", "Maximum static call-site resolutions.", 1, 4096, { default: 256 }),
      int("max-nodes", "Maximum retained graph nodes.", 1, 20000, { default: 5000 }),
      int("max-edges", "Maximum retained graph edges.", 1, 40000, { default: 10000 }),
      int("offset", "First graph node index.", 0, 10000000, { default: 0 }),
      int("limit", "Maximum nodes on this page.", 1, 5000, { default: 1000 }),
    ],
  }),
  W("annotate-native-function", "native", "Annotate a function", "Edits a function's name or comments in the analysis database and returns the refreshed analysis. This changes the provider's database.", "native-provider", "LW", {
    provider: true, tl: "Local executable", oneOf: ["name", "comment", "inline-comment"],
    args: [
      posStr("procedure", "Exact function entry address or unique name.", PATTERNS.SYMBOL),
      str("name", "Analyst function name.", { pattern: PATTERNS.TEXT }),
      str("comment", "Regular entry comment; empty text clears it.", { pattern: "^[^\\u0000-\\u001f\\u007f]{0,300}$", allowEmpty: true }),
      str("inline-comment", "Inline entry comment; empty text clears it.", { pattern: "^[^\\u0000-\\u001f\\u007f]{0,300}$", allowEmpty: true }),
    ],
  }),

  // ── Binary layout / diagnostics ────────────────────────────────────────────────────────────────
  W("inspect-binary-layout", "layout", "Inspect ELF layout", "Sections, segments, symbols, relocations and static mitigation candidates, without executing the object.", "native-provider", "LW", {
    tl: "Local ELF binary or relocatable object", prereq: ["pwntools"], shape: "layout", view: true,
  }),
  W("inspect-recorded-crash", "layout", "Inspect a recorded crash", "Reads registers and signals of every thread in a Linux amd64 ELF core, optionally with debugger mapping candidates.", "native-provider", "LW", {
    tl: "Linux amd64 ELF core", prereq: ["pwntools"],
    args: [bool("debugger-context", "Add core-only GDB/pwndbg mapping candidates (starts gdb on the core).")],
  }),
  W("inspect-evm-interface", "layout", "Infer EVM interface", "Infers dispatch selectors, argument shapes and mutability from local EVM bytecode.", "native-provider", "LW", {
    tl: "Local bytecode carrier", args: [posChoice("encoding", "How the bytecode file is stored.", ["raw", "hex"])],
  }),
  W("inspect-pe-resources", "layout", "Inspect PE resources", "Reads PE resource identities, payload ranges, hashes and icon-group relationships.", "static", "", {
    tl: "Local PE32/PE32+ image",
    args: [
      int("max-file-bytes", "Maximum stable artifact bytes to read.", 64, 536870912, { default: 67108864 }),
      int("max-entries", "Maximum resource directory entries to examine; exceeding it fails.", 1, 65536, { default: 4096 }),
    ],
  }),

  // ── Android / APK ──────────────────────────────────────────────────────────────────────────────
  W("inspect-android-package", "android", "Inspect an APK", "Reads APK declarations and the decoded manifest without executing the app.", "native-provider", "LW", { tl: "Standalone APK", prereq: ["jadx"] }),
  W("search-android-classes", "android", "Search APK classes", "Searches class names in an APK; an empty query lists every class.", "native-provider", "LW", {
    tl: "Standalone APK", prereq: ["jadx"],
    args: [posStr("query", "Case-sensitive class-name substring; empty lists all classes.", "^[A-Za-z0-9_$.]{0,200}$", { allowEmpty: true })],
  }),
  W("inspect-android-class", "android", "Inspect an APK class", "Lists one exact class's member inventory.", "native-provider", "LW", {
    tl: "Standalone APK", prereq: ["jadx"], args: [posStr("className", "Exact fully qualified class name.", PATTERNS.CLASS)],
  }),
  W("inspect-android-method", "android", "Decompile an APK method", "Decompiles one method with explicit overload selection.", "native-provider", "LW", {
    tl: "Standalone APK", prereq: ["jadx"],
    args: [
      posStr("className", "Exact fully qualified class name.", PATTERNS.CLASS),
      posStr("methodName", "Exact declared method name.", PATTERNS.METHOD),
      int("overload-index", "Zero-based index among same-name methods; required when the name is ambiguous.", 0, 1000),
    ],
  }),
  W("trace-android-references", "android", "Trace APK references", "Traces incoming references to a class or one unique method.", "native-provider", "LW", {
    tl: "Standalone APK", prereq: ["jadx"],
    args: [posStr("className", "Exact fully qualified class name.", PATTERNS.CLASS), str("method-name", "Unique declared method name; omit for class references.", { pattern: PATTERNS.METHOD })],
  }),
  W("decode-android-resources", "android", "Decode APK resources", "Decodes manifest, metadata and string resources with apktool.", "native-provider", "LW", {
    tl: "Local APK", prereq: ["apktool"],
    args: [
      str("locale", "Project strings from res/values-<locale> instead of the default.", { pattern: "^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$", maxLength: 16 }),
      bool("no-strings", "Skip projecting string resources."),
    ],
  }),
  W("project-android-application-graph", "android", "Project an Android application graph", "Projects authenticated APK inventory Evidence into an application graph.", "static", "", { tl: JSON_IN }),
  W("inspect-apktool-client", "android", "Check the apktool launcher", "Inspects the selected apktool launcher without decoding anything.", "native-provider", "L", { targets: 0, prereq: ["apktool"] }),

  // ── Apple bundles ──────────────────────────────────────────────────────────────────────────────
  W("list-architectures", "apple", "List architectures", "Lists the architecture slices of a Mach-O or app.", "native-provider", "L", { tl: "Mach-O or app" }),
  W("inspect-macho", "apple", "Inspect a Mach-O", "Reads Mach-O structure without launching Hopper.", "native-provider", "L", { tl: "Mach-O or app" }),
  W("inspect-signature", "apple", "Inspect code signature", "Reads the code signature without launching Hopper.", "native-provider", "L", { tl: "Mach-O or app" }),
  W("inspect-plist", "apple", "Inspect a plist", "Parses app plist metadata (Info.plist by default) without launching Hopper.", "native-provider", "L", {
    tl: "App or Mach-O",
    args: [str("relative-path", "Plist path relative to the app root (default: the bundle's Info.plist).", { pattern: PATTERNS.REL, noDotDot: true })],
  }),
  W("inspect-asset-catalog", "apple", "Inspect an asset catalog", "Reads compiled Apple asset catalog metadata.", "native-provider", "L", {
    tl: "Apple .app bundle",
    args: [int("offset", "First metadata record.", 0, 10000000, { default: 0 }), int("limit", "Maximum records to return.", 1, 10000, { default: 1000 })],
  }),
  W("decode-interface-builder", "apple", "Decode storyboards and nibs", "Decodes compiled storyboard and nib archives from an app bundle.", "static", "", {
    tl: "Apple .app bundle",
    args: [
      int("max-documents", "Maximum archives to decode.", 1, 64, { default: 64 }),
      int("max-objects", "Maximum graph objects.", 1, 20000, { default: 20000 }),
      int("max-connections", "Maximum decoded connections.", 1, 40000, { default: 40000 }),
    ],
  }),
  W("inspect-keyed-archive", "apple", "Inspect a keyed archive", "Inspects a Foundation keyed archive as an object-reference graph.", "static", "", {
    tl: "Plist archive or app bundle",
    args: [
      posStr("archive", "Relative archive path when the target is a bundle (default: .).", "^(\\.|[A-Za-z0-9._ -]{1,120}(/[A-Za-z0-9._ -]{1,120}){0,15})$", { required: false, noDotDot: true }),
      str("root", "Named $top archive root.", { pattern: PATTERNS.TEXT }),
      int("offset", "First original object-table index.", 0, 10000000, { default: 0 }),
      int("limit", "Maximum object-table entries to return.", 1, 20000, { default: 20000 }),
    ],
  }),
  W("trace-dylib-resolution", "apple", "Trace dyld resolution", "Traces dyld load-path resolution for a Mach-O or every executable in an app bundle.", "static", "", {
    tl: "Mach-O file or app bundle",
    args: [
      list("root", "Process root relative to the bundle or the Mach-O's directory (repeatable).", { pattern: PATTERNS.REL, noDotDot: true }),
      choice("architecture", "Trace only this slice of each root.", ["arm64", "arm64e", "x86_64"]),
    ],
  }),
  W("demangle-swift", "apple", "Demangle Swift symbols", "Demangles Swift symbols without Hopper.", "native-provider", "L", {
    tl: "Artifact (used for evidence identity)",
    args: [pos("symbols", "list", "Swift mangled symbols, one per line.", { pattern: "^[\\x21-\\x7E]{1,500}$", maxItems: 50, maxLength: 500 })],
  }),
  W("project-apple-application-graph", "apple", "Project an Apple application graph", "Projects authenticated IPA or macOS app inventory Evidence into an application graph.", "static", "", { tl: JSON_IN }),

  // ── Firmware ───────────────────────────────────────────────────────────────────────────────────
  W("inspect-firmware-regions", "firmware", "Inspect firmware regions", "Lists firmware signature candidates without extracting them. Never executed.", "native-provider", "LW", { tl: "Local firmware file", prereq: ["binwalk"], timeout: 30 }),
  W("extract-firmware", "firmware", "Extract firmware", "Extracts selected firmware bytes and returns verified files and provenance. Never executed.", "native-provider", "LW", {
    tl: "Local firmware file", prereq: ["binwalk"], timeout: 60,
    args: [
      outDir("outputDirectory"),
      int("offset", "Selected byte offset; requires length.", 0, 9007199254740991, { with: "length" }),
      int("length", "Selected byte length; requires offset.", 1, 9007199254740991, { with: "offset" }),
      int("max-depth", "Extraction depth.", 1, 10, { default: 3 }),
      int("max-output-bytes", "Staging byte budget.", 1, 536870912, { default: 268435456 }),
      int("max-output-files", "Staging entry budget.", 1, 100000, { default: 10000 }),
    ],
    pos: ["$target", "outputDirectory"],
  }),

  // ── Evidence ───────────────────────────────────────────────────────────────────────────────────
  W("evidence-import", "evidence", "Validate an Evidence bundle", "Validates and imports a bounded local Evidence bundle.", "static", "", { tl: "Evidence bundle JSON" }),
  W("evidence-export", "evidence", "Export Evidence", "Validates an Evidence bundle and writes canonical Evidence JSON into the run's folder.", "static", "W", {
    tl: "Existing Evidence bundle JSON", args: [outFile("output")], pos: ["$target", "output"],
  }),
  W("inspect-evidence-bundle", "evidence", "Inspect an Evidence bundle", "Lists complete or selected discovery metadata from a local Evidence bundle.", "static", "", { tl: "JSON file with absolute bundle path, detail and optional record filters" }),
  W("compare", "evidence", "Compare Evidence bundles", "Compares two canonical Evidence bundles.", "static", "", { targets: 2, tl: "Left Evidence bundle JSON", t2l: "Right Evidence bundle JSON" }),
  W("build-reconstruction-obligation-ledger", "evidence", "Build a reconstruction ledger", "Generates a deterministic Evidence-backed reconstruction obligation ledger page.", "static", "", { tl: JSON_IN }),
  W("evaluate-reconstruction-coverage", "evidence", "Evaluate reconstruction coverage", "Evaluates fail-closed reconstruction coverage.", "static", "", { tl: JSON_IN }),
  W("import-reference-source", "evidence", "Import reference source", "Imports a source tree as historical reference only.", "static", "", { tl: "Local source directory" }),

  // ── Web captures (HAR) ─────────────────────────────────────────────────────────────────────────
  W("inspect-web-network-capture", "web-captures", "Inspect a network capture", "Reads retained HAR or native mitmproxy records without fetching any recorded URL.", "native-provider", "LW", {
    tl: "Absolute capture file path",
    args: [
      posChoice("format", "Producer capture format.", ["har", "mitmproxy"]),
      intlist("record", "Zero-based producer record ordinals to include (repeat to select several)."),
      list("sensitive-value", "Literal string values to mark sensitive (they stay out of the display line).", { pattern: PATTERNS.TEXT, secret: true, maxItems: 50 }),
    ],
    pos: ["$target", "format"],
  }),
  W("export-web-scripts", "web-captures", "Export captured page scripts", "Exports retained page scripts from a saved capture into the run's folder for static JavaScript analysis.", "static", "W", {
    tl: "Saved page or scenario capture JSON", args: [outDir("outputDirectory")], pos: ["$target", "outputDirectory"],
  }),
  W("trace-web-module-imports", "web-captures", "Trace a script's imports", "Traces one captured script's native imports to URLs and captured source candidates.", "native-provider", "LW", {
    tl: "export-web-scripts manifest path",
    args: [
      posInt("scriptIndex", "Zero-based manifest script index.", 0, 100000),
      str("importer-url", "Explicit HTTP(S) importer URL.", { pattern: PATTERNS.URL, maxLength: 500 }),
      pathFlag("import-map-path", "Absolute local import-map JSON."),
      str("import-map-base-url", "HTTP(S) import-map base URL.", { pattern: PATTERNS.URL, maxLength: 500 }),
    ],
    pos: ["$target", "scriptIndex"],
  }),
  W("trace-web-source-location", "web-captures", "Trace a source location", "Traces one retained script position through a selected local source map (no fetch).", "native-provider", "LW", {
    tl: "export-web-scripts manifest path",
    args: [
      posInt("scriptIndex", "Zero-based manifest script index.", 0, 100000),
      posPath("sourceMapPath", "Absolute local source-map path."),
      posStr("sourceMapUrl", "Absolute source-map URL context (no fetch).", PATTERNS.URL, { maxLength: 500 }),
      posInt("line", "One-based generated line.", 1, 100000000),
      posInt("column", "Zero-based UTF-16 generated column.", 0, 100000000),
    ],
    pos: ["$target", "scriptIndex", "sourceMapPath", "sourceMapUrl", "line", "column"],
  }),
  W("compare-web-captures", "web-captures", "Compare web captures", "Compares two normalized passive captures or recorded browser scenarios.", "static", "", {
    targets: 2, tl: "Earlier capture JSON", t2l: "Later capture JSON",
    args: [jsonFlag("normalization-json", "Literal normalization policy, e.g. {\"rules\":[]}.", "object")],
  }),
  W("compare-web-screenshots", "web-captures", "Compare web screenshots", "Compares two self-verifying PNG artifact JSON values.", "static", "", {
    targets: 2, tl: "Earlier screenshot artifact JSON", t2l: "Later screenshot artifact JSON",
    args: [int("channel-threshold", "Per-channel difference threshold for changed pixels.", 0, 255, { default: 0 })],
  }),

  // ── Process capture ────────────────────────────────────────────────────────────────────────────
  W("capture-process", "process", "Capture a process scenario", "Runs one caller-selected process scenario and records terminal output, interaction, exit and filesystem observations.", "executes-target", "LNW", {
    tl: "Scenario JSON file", timeout: 30,
  }),
  W("compare-process-captures", "process", "Compare process captures", "Compares two process capture Evidence files, optionally against a trace specification.", "static", "", {
    targets: 2, tl: "Left capture Evidence JSON", t2l: "Right capture Evidence JSON",
    args: [posPath("traceSpec", "Partial-order or finite-trace specification file.", { required: false })],
  }),

  // ── Browser / web runtime ──────────────────────────────────────────────────────────────────────
  W("list-browser-targets", "browser", "List browser pages", "Lists page targets from a Chrome-family browser with a loopback debugging port.", "network", "N", {
    targets: 0, prereq: ["browser"],
    args: [posStr("endpoint", "Loopback CDP HTTP endpoint, e.g. http://127.0.0.1:9222.", PATTERNS.ENDPOINT), ALLOWED_ORIGINS()],
  }),
  W("inspect-web-page", "browser", "Inspect a web page", "Passively inspects one page through CDP, by default within its current origin.", "network", "N", {
    targets: 0, prereq: ["browser"],
    args: [
      posStr("endpoint", "Loopback CDP HTTP endpoint.", PATTERNS.ENDPOINT),
      posStr("targetId", "Target ID from list-browser-targets.", PATTERNS.TARGET_ID),
      ALLOWED_ORIGINS(),
      OBS_MS(500),
      bool("include-accessibility-text", "Include accessibility text."),
      bool("include-console-text", "Include console message text."),
      bool("include-json-body-shapes", "Include structural shapes of JSON response bodies."),
      bool("include-websocket-shapes", "Include structural shapes of WebSocket payloads."),
      bool("include-script-sources", "Include JavaScript source text."),
      bool("include-storage-keys", "Include storage key names without values."),
      bool("include-storage-fingerprints", "Include content-derived storage fingerprints."),
    ],
  }),
  W("analyze-web-bundle", "browser", "Analyze a page's bundles", "Captures and statically analyzes a page's script bundles, by default within the page's origin.", "network", "N", {
    targets: 0, prereq: ["browser"], timeout: 15,
    args: [
      posStr("endpoint", "Loopback CDP HTTP endpoint.", PATTERNS.ENDPOINT),
      posStr("targetId", "Target ID from list-browser-targets.", PATTERNS.TARGET_ID),
      ALLOWED_ORIGINS(),
      OBS_MS(500),
      bool("fetch-source-maps", "Fetch source maps referenced by captured scripts (contacts the network)."),
    ],
  }),
  W("discover-webmcp-tools", "browser", "Discover WebMCP tools", "Passively discovers page-declared WebMCP tools.", "network", "N", {
    targets: 0, prereq: ["browser"],
    args: [posStr("endpoint", "Loopback CDP HTTP endpoint.", PATTERNS.ENDPOINT), posStr("targetId", "Target ID from list-browser-targets.", PATTERNS.TARGET_ID), ALLOWED_ORIGINS(), OBS_MS(100)],
  }),
  W("capture-web-screenshot", "browser", "Capture a page screenshot", "Captures one visible page viewport within the supplied origin scope.", "network", "NW", {
    targets: 0, prereq: ["browser"],
    args: [posStr("endpoint", "Loopback CDP HTTP endpoint.", PATTERNS.ENDPOINT), posStr("targetId", "Target ID from list-browser-targets.", PATTERNS.TARGET_ID), ALLOWED_ORIGINS()],
  }),
  W("inspect-web-event-listeners", "browser", "Inspect event listeners", "Inspects native listener source locations on the first main-document CSS match.", "network", "N", {
    targets: 0, prereq: ["browser"],
    args: [
      posStr("endpoint", "Loopback CDP HTTP endpoint.", PATTERNS.ENDPOINT),
      posStr("targetId", "Page target ID from list-browser-targets.", PATTERNS.TARGET_ID),
      posStr("selector", "Native CSS selector; the first main-document match is inspected.", PATTERNS.TEXT),
      ALLOWED_ORIGINS(),
    ],
  }),
  W("observe-web-execution", "browser", "Observe page execution", "Observes precise page execution. It resets counters and temporarily disables optimization in the live page.", "network", "N", {
    targets: 0, prereq: ["browser"], timeout: 15,
    args: [posStr("endpoint", "Loopback CDP HTTP endpoint.", PATTERNS.ENDPOINT), posStr("targetId", "Target ID from list-browser-targets.", PATTERNS.TARGET_ID), ALLOWED_ORIGINS(), OBS_MS1(10000)],
  }),
  W("observe-web-session", "browser", "Observe a browsing session", "Observes user-driven page navigation during a chosen window.", "network", "N", {
    targets: 0, prereq: ["browser"], timeout: 15,
    args: [posStr("endpoint", "Loopback CDP HTTP endpoint.", PATTERNS.ENDPOINT), posStr("targetId", "Target ID from list-browser-targets.", PATTERNS.TARGET_ID), ALLOWED_ORIGINS(), OBS_MS1(10000)],
  }),
  W("capture-browser-scenario", "browser", "Run a browser scenario", "Runs one bounded Playwright browser scenario (opens pages, may use the network) and returns Evidence.", "executes-target", "LNW", {
    tl: "Browser scenario JSON file", prereq: ["browser"], timeout: 30,
  }),

  // ── Electron / JS runtime ──────────────────────────────────────────────────────────────────────
  W("list-electron-targets", "electron", "List Electron pages", "Lists local file pages exposed by an Electron CDP endpoint.", "network", "N", {
    targets: 0, args: [posStr("endpoint", "Literal loopback Electron CDP endpoint, e.g. http://127.0.0.1:9229.", PATTERNS.ENDPOINT_LITERAL)],
  }),
  W("inspect-electron-page", "electron", "Inspect an Electron page", "Passively inspects one Electron file page.", "network", "N", {
    targets: 0,
    args: [
      posStr("endpoint", "Literal loopback Electron CDP endpoint.", PATTERNS.ENDPOINT_LITERAL),
      posStr("targetId", "Target ID from list-electron-targets.", PATTERNS.TARGET_ID),
      OBS_MS(100),
      bool("include-script-sources", "Include JavaScript source text."),
    ],
  }),
  W("list-javascript-runtime-targets", "electron", "List Node/V8 inspector targets", "Lists Node/Electron V8 Inspector targets on a loopback port.", "network", "N", {
    targets: 0, args: [posStr("endpoint", "Literal loopback Inspector endpoint.", PATTERNS.ENDPOINT_LITERAL)],
  }),
  W("observe-javascript-runtime", "electron", "Observe a JavaScript runtime", "Passively observes one exact Node/Electron Inspector target.", "network", "N", {
    targets: 0,
    args: [
      posStr("endpoint", "Literal loopback Inspector endpoint.", PATTERNS.ENDPOINT_LITERAL),
      posStr("targetId", "Target from list-javascript-runtime-targets.", PATTERNS.TARGET_ID),
      choice("runtime-kind", "Declared target role (the Inspector cannot authenticate the Electron role).", ["node", "electron-main", "electron-preload", "electron-renderer"]),
      OBS_MS(100),
    ],
  }),
  W("reconcile-javascript-runtime", "electron", "Reconcile static and runtime Evidence", "Reconciles static application Evidence with passive runtime Evidence.", "static", "", { tl: JSON_IN }),
  W("capture-electron-scenario", "electron", "Run an Electron scenario", "Runs one owned Electron scenario with cancellable actions (launches the app, may use the network).", "executes-target", "LNW", {
    tl: "Electron scenario JSON file", timeout: 30,
  }),

  // ── Native runtime ─────────────────────────────────────────────────────────────────────────────
  W("observe-native-calls", "native-runtime", "Observe native calls", "Launches a Mach-O under LLDB and records entries into selected functions or Objective-C methods.", "executes-target", "LNW", {
    targets: 2, tl: "Mach-O or app", t2l: "JSON file: breakpoints, arguments, environment, duration_ms, max_events", timeout: 30,
  }),
  W("observe-native-ui", "native-runtime", "Observe or drive a native window", "Observes or runs a scenario in one exact native application window (accessibility tree, screenshot).", "executes-target", "LW", {
    tl: "Native executable or app", timeout: 15,
    args: [
      int("pid", "Existing application PID.", 1, 4194304),
      int("window-id", "Exact selected application window ID.", 1, 4294967295),
      jsonFlag("steps", "JSON array of declarative accessibility actions or waits.", "array"),
      int("max-nodes", "Maximum accessibility nodes per capture.", 1, 20000, { default: 500 }),
    ],
  }),
  W("capture-native-ui-scenario", "native-runtime", "Capture a native UI scenario", "Observes or runs a scenario in one exact native application window, with screenshots.", "executes-target", "LNW", {
    tl: "Native executable or app", timeout: 15,
    args: [
      int("pid", "Existing application PID.", 1, 4194304),
      int("window-id", "Exact selected application window ID.", 1, 4294967295),
      jsonFlag("steps", "JSON array of declarative accessibility actions or waits.", "array"),
      int("max-nodes", "Maximum accessibility nodes per capture.", 1, 20000, { default: 500 }),
    ],
  }),

  // ── ADB device (read) ──────────────────────────────────────────────────────────────────────────
  W("inspect-adb-client", "adb-read", "Check the adb client", "Inspects the selected adb client without contacting devices.", "native-provider", "L", { targets: 0, prereq: ["adb"] }),
  W("list-adb-devices", "adb-read", "List devices", "Lists attached devices with serial, state, transport and inferred kind.", "device", "LN", { targets: 0, prereq: ["adb"] }),
  W("inspect-adb-device", "adb-read", "Inspect a device", "Reads one device's build identity through a fixed getprop whitelist.", "device", "LN", {
    targets: 0, prereq: ["adb"], args: [posStr("serial", "Device serial exactly as adb devices reports it.", PATTERNS.SERIAL)],
  }),
  W("inspect-adb-display", "adb-read", "Display size and density", "Reports the display's declared size and density.", "device", "LN", {
    targets: 0, prereq: ["adb"], args: [posStr("serial", "Device serial exactly as adb devices reports it.", PATTERNS.SERIAL)],
  }),
  W("inspect-adb-window", "adb-read", "Window focus", "Reports the window manager's current focus declarations.", "device", "LN", {
    targets: 0, prereq: ["adb"], args: [posStr("serial", "Device serial exactly as adb devices reports it.", PATTERNS.SERIAL)],
  }),
  W("inspect-adb-package", "adb-read", "Inspect an installed package", "Reads one installed package's version, installer and flags through dumpsys.", "device", "LN", {
    targets: 0, prereq: ["adb"],
    args: [posStr("serial", "Device serial exactly as adb devices reports it.", PATTERNS.SERIAL), posStr("package", "Package name.", PATTERNS.PKG)],
  }),
  W("list-adb-packages", "adb-read", "List packages", "Lists installed packages on one device with base APK device paths.", "device", "LN", {
    targets: 0, prereq: ["adb"],
    args: [posStr("serial", "Device serial exactly as adb devices reports it.", PATTERNS.SERIAL), choice("scope", "Restrict to third-party or system packages.", ["all", "third_party", "system"], { default: "all" })],
  }),
  W("resolve-adb-packages", "adb-read", "Find packages", "Finds installed packages by case-insensitive name substring.", "device", "LN", {
    targets: 0, prereq: ["adb"],
    args: [posStr("serial", "Device serial exactly as adb devices reports it.", PATTERNS.SERIAL), posStr("query", "Package-name substring.", PATTERNS.PKG_QUERY)],
  }),
  W("list-adb-processes", "adb-read", "List processes", "Lists running processes exactly as ps -A reports them.", "device", "LN", {
    targets: 0, prereq: ["adb"], args: [posStr("serial", "Device serial exactly as adb devices reports it.", PATTERNS.SERIAL)],
  }),
  W("list-adb-services", "adb-read", "List binder services", "Lists the device's binder services and interfaces.", "device", "LN", {
    targets: 0, prereq: ["adb"], args: [posStr("serial", "Device serial exactly as adb devices reports it.", PATTERNS.SERIAL)],
  }),
  W("list-adb-features", "adb-read", "List features", "Lists the device's declared hardware and software features.", "device", "LN", {
    targets: 0, prereq: ["adb"], args: [posStr("serial", "Device serial exactly as adb devices reports it.", PATTERNS.SERIAL)],
  }),
  W("list-adb-directory", "adb-read", "List a device directory", "Lists one device directory with kinds, permissions and sizes.", "device", "LN", {
    targets: 0, prereq: ["adb"],
    args: [posStr("serial", "Device serial exactly as adb devices reports it.", PATTERNS.SERIAL), posStr("device-path", "Absolute device directory path.", PATTERNS.DEVPATH, { noDotDot: true })],
  }),
  W("read-adb-logcat", "adb-read", "Read the device log", "Reads a bounded dump of one device log buffer.", "device", "LN", {
    targets: 0, prereq: ["adb"],
    args: [
      posStr("serial", "Device serial exactly as adb devices reports it.", PATTERNS.SERIAL),
      int("count", "Number of most recent lines.", 1, 10000, { default: 500 }),
      choice("buffer", "Log buffer to read.", ["main", "system", "radio", "events", "crash"], { default: "main" }),
      int("pid", "Restrict to one process id.", 1, 4194304),
    ],
  }),
  W("read-adb-setting", "adb-read", "Read a device setting", "Reads one settings value from system, secure or global.", "device", "LN", {
    targets: 0, prereq: ["adb"],
    args: [
      posStr("serial", "Device serial exactly as adb devices reports it.", PATTERNS.SERIAL),
      posChoice("namespace", "Settings namespace.", ["system", "secure", "global"]),
      posStr("key", "Setting key.", PATTERNS.SETTING_KEY),
    ],
  }),
  W("capture-adb-screen", "adb-read", "Capture the device screen", "Captures one screen frame as a digested PNG into the run's folder.", "device", "LNW", {
    targets: 0, prereq: ["adb"], args: [posStr("serial", "Device serial exactly as adb devices reports it.", PATTERNS.SERIAL), outFlagDir("output-directory")],
  }),
  W("collect-adb-bugreport", "adb-read", "Collect a bugreport", "Collects and digests one device-generated bugreport archive into the run's folder. The device writes a report file while it runs.", "device", "LNW", {
    targets: 0, prereq: ["adb"], timeout: 30, args: [posStr("serial", "Device serial exactly as adb devices reports it.", PATTERNS.SERIAL), outFlagDir("output-directory")],
  }),
  W("pull-adb-file", "adb-read", "Pull a device file", "Pulls one device file to the run's folder with a SHA-256 digest.", "device", "LNW", {
    targets: 0, prereq: ["adb"],
    args: [posStr("serial", "Device serial exactly as adb devices reports it.", PATTERNS.SERIAL), posStr("device-path", "Absolute device path to pull.", PATTERNS.DEVPATH, { noDotDot: true }), outFlagDir("output-directory")],
  }),
  W("pull-adb-package", "adb-read", "Pull a package's APKs", "Pulls one installed package's complete APK set to the run's folder with SHA-256 digests.", "device", "LNW", {
    targets: 0, prereq: ["adb"],
    args: [posStr("serial", "Device serial exactly as adb devices reports it.", PATTERNS.SERIAL), posStr("package", "Installed package name.", PATTERNS.PKG), outFlagDir("output-directory")],
  }),

  // ── ADB device (mutating) ──────────────────────────────────────────────────────────────────────
  W("install-adb-package", "adb-write", "Install an APK", "Installs one local APK on the device; Replace re-installs and keeps the app's data.", "device", "LNM", {
    prereq: ["adb"], tl: "Local APK file",
    args: [posStr("serial", "Device serial exactly as adb devices reports it.", PATTERNS.SERIAL), bool("replace", "Replace an existing install and keep its data.")],
    pos: ["serial", "$target"],
  }),
  W("uninstall-adb-package", "adb-write", "Uninstall a package", "Uninstalls one package and its data from the device.", "device", "LNM", {
    targets: 0, prereq: ["adb"],
    args: [posStr("serial", "Device serial exactly as adb devices reports it.", PATTERNS.SERIAL), posStr("package", "Installed package to uninstall.", PATTERNS.PKG)],
  }),
  W("push-adb-file", "adb-write", "Push a file to the device", "Pushes one local file to the device; refuses existing targets unless Overwrite is set.", "device", "LNM", {
    prereq: ["adb"], tl: "Local file to push",
    args: [
      posStr("serial", "Device serial exactly as adb devices reports it.", PATTERNS.SERIAL),
      posStr("device-path", "Absolute device destination.", PATTERNS.DEVPATH, { noDotDot: true }),
      bool("overwrite", "Allow replacing an existing device file."),
    ],
    pos: ["serial", "$target", "device-path"],
  }),
  W("start-adb-app", "adb-write", "Start an app", "Starts one installed app by resolving and launching its launcher activity.", "device", "LNM", {
    targets: 0, prereq: ["adb"],
    args: [posStr("serial", "Device serial exactly as adb devices reports it.", PATTERNS.SERIAL), posStr("package", "Installed package to start.", PATTERNS.PKG)],
  }),
  W("stop-adb-app", "adb-write", "Force-stop an app", "Force-stops every process of one package.", "device", "LNM", {
    targets: 0, prereq: ["adb"],
    args: [posStr("serial", "Device serial exactly as adb devices reports it.", PATTERNS.SERIAL), posStr("package", "Package to force-stop.", PATTERNS.PKG)],
  }),
  W("start-adb-activity", "adb-write", "Start an intent", "Starts an intent with am start (action, data URI, component, extras).", "device", "LNM", {
    targets: 0, prereq: ["adb"],
    args: [
      posStr("serial", "Device serial exactly as adb devices reports it.", PATTERNS.SERIAL),
      posStr("action", "Intent action to start.", PATTERNS.ACTION),
      str("data-uri", "Intent data URI.", { pattern: PATTERNS.DATA_URI, maxLength: 450 }),
      str("component", "Explicit component in package/activity form.", { pattern: PATTERNS.COMPONENT, maxLength: 310 }),
      list("extra", "Typed extra as type:key:value (string, boolean, int, long, float); repeatable.", { pattern: PATTERNS.EXTRA, maxLength: 420 }),
    ],
  }),

  // ── JEB ────────────────────────────────────────────────────────────────────────────────────────
  W("inspect-jeb-client", "jeb", "Check the JEB client", "Inspects the running JEB MCP client without opening a target.", "network", "N", { targets: 0, prereq: ["jeb"] }),
  W("open-jeb-project", "jeb", "Open a JEB project", "Opens or creates a JEB project from an artifact or .jdb2 database (changes the JEB client's state).", "network", "NW", {
    tl: "Artifact or .jdb2 path (resolved by the JEB host)", prereq: ["jeb"],
  }),
  W("list-jeb-units", "jeb", "List JEB units", "Lists JEB project units by path and type with an optional filter.", "network", "N", {
    targets: 0, prereq: ["jeb"],
    args: [
      str("filter", "Wildcard filter matched against unit paths.", { pattern: PATTERNS.TEXT }),
      str("parent-unit-path", "Restrict results to descendants of this unit path.", { pattern: PATTERNS.TEXT }),
      int("index", "Zero-based index of the first result.", 0, 10000000, { default: 0 }),
      int("count", "Maximum results (the engine caps unit pages at 100).", 1, 100, { default: 100 }),
    ],
  }),
  W("decompile-jeb-item", "jeb", "Decompile a JEB item", "Decompiles one JEB type or method to engine pseudo-code.", "network", "N", {
    targets: 0, prereq: ["jeb"],
    args: [
      posStr("item-address", "Type or method address within the unit.", PATTERNS.SYMBOL),
      posChoice("item-kind", "Kind of item to decompile.", ["type", "method"]),
      str("unit-path", "Target code unit; the engine's first code unit when omitted.", { pattern: PATTERNS.TEXT }),
    ],
  }),
]);

const BY_ID = new Map(WORKFLOWS.map((w) => [w.id, w]));

export function workflowById(id) {
  return typeof id === "string" && BY_ID.has(id) ? BY_ID.get(id) : null;
}

export const SERVER_MANAGED_FLAGS = Object.freeze([
  "json", "format", "filter-output", "full-output", "token-count", "token-limit", "token-offset", "llms", "llms-full", "schema",
  "help", "version", "provider", "snapshot", "client", "skill-client", "yes", "all-detected", "dry-run", "purge-data", "output",
  "output-directory", "overwrite-output",
]);

function publicArg(a) {
  const out = { name: a.name, flag: a.flag, kind: a.kind, help: a.help };
  for (const k of ["positional", "required", "choices", "min", "max", "default", "pattern", "maxLength", "maxItems", "jsonType", "outputKind", "secret", "allowEmpty", "with"]) {
    if (a[k] !== undefined) out[k] = a[k];
  }
  return out;
}

/** JSON-safe copy of the catalog for the browser (WorkflowSpec in the contract, plus a few additive fields). */
export function publicSpec() {
  return JSON.parse(JSON.stringify({
    groups: GROUPS.map((g) => ({ id: g.id, label: g.label, help: g.help })),
    execClasses: EXEC_CLASSES,
    workflows: WORKFLOWS.map((w) => ({
      id: w.id,
      label: w.label,
      group: w.group,
      blurb: w.blurb,
      command: w.command,
      execClass: w.execClass,
      effects: { ...w.effects },
      targetKinds: [...w.targetKinds],
      targets: w.targets,
      targetLabel: w.targetLabel,
      target2Label: w.target2Label,
      needsProvider: w.needsProvider,
      prerequisites: [...w.prerequisites],
      args: w.args.filter((a) => a.kind !== "path-run-owned").map(publicArg),
      positionals: [...w.positionals],
      requireOneOf: w.requireOneOf ? [...w.requireOneOf] : null,
      resultShape: w.resultShape,
      defaultTimeoutMinutes: w.defaultTimeoutMinutes,
      viewable: w.viewable,
    })),
  }));
}
