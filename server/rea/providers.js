/**
 * Analysis providers and helper engines REA can use on a unit.
 *
 * The provider ids are what a run request may ask for (`--provider`); `auto` lets REA choose
 * deterministically. The engine list drives the status page (is the program installed on the
 * unit?) and the "this unlocks ..." wording; it never installs anything.
 *
 * `bins` are program names looked up on the unit's PATH (plus the usual install locations the
 * status unit program checks); `envVars` are the environment variables REA itself reads to find
 * the engine, so a user can see which one to set when the program is not on PATH.
 */

export const PROVIDER_IDS = Object.freeze(["auto", "ghidra", "hopper", "ida"]);

export const ENGINES = Object.freeze([
  {
    id: "ghidra",
    label: "Ghidra",
    bins: ["analyzeHeadless", "ghidraRun"],
    envVars: ["GHIDRA_INSTALL_DIR", "REA_GHIDRA_STARTUP_TIMEOUT_MS", "REA_GHIDRA_LANGUAGE_ID"],
    unlocks: "Deep native analysis: decompiled code, assembly, strings, symbols, calls and references for executables.",
  },
  {
    id: "hopper",
    label: "Hopper",
    bins: ["Hopper", "hopper", "HopperDisassembler", "hopperv4"],
    envVars: [],
    unlocks: "Deep native analysis through Hopper (mostly macOS and Linux): pseudocode, assembly, cross references and call graphs.",
  },
  {
    id: "ida",
    label: "IDA Pro",
    bins: ["idat", "idat64", "ida", "ida64"],
    envVars: ["REA_IDA_MCP_CONFIG"],
    unlocks: "Deep native analysis through an IDA MCP server: decompilation, naming and cross references.",
  },
  {
    id: "jadx",
    label: "JADX (headless)",
    bins: ["jadx", "java"],
    envVars: ["REA_JADX_MCP_JAR", "JAVA_HOME", "REA_JADX_HEAP_MIB"],
    unlocks: "Android APK inspection: manifest declarations, class inventories, decompiled methods and references.",
  },
  {
    id: "apktool",
    label: "Apktool",
    bins: ["apktool"],
    envVars: ["REA_APKTOOL_COMMAND"],
    unlocks: "Android resource decoding: manifest, string tables, locales and version facts.",
  },
  {
    id: "binwalk",
    label: "Binwalk",
    bins: ["binwalk"],
    envVars: ["REA_BINWALK_COMMAND"],
    unlocks: "Firmware region inspection and extraction.",
  },
  {
    id: "unblob",
    label: "Unblob",
    bins: ["unblob"],
    envVars: ["REA_UNBLOB_COMMAND"],
    unlocks: "Firmware region inspection and extraction (an alternative to Binwalk).",
  },
  {
    id: "adb",
    label: "Android Debug Bridge (adb)",
    bins: ["adb"],
    envVars: ["REA_ADB_PATH"],
    unlocks: "Android device analysis: devices, packages, processes, logs, screen captures and file transfers.",
  },
  {
    id: "wakaru",
    label: "Wakaru (JavaScript module recovery)",
    bins: [],
    envVars: ["REA_WAKARU_COMMAND"],
    unlocks: "Recovering readable modules from one bundled JavaScript file (recover-javascript-sources).",
  },
  {
    id: "jeb",
    label: "JEB (MCP client)",
    bins: [],
    envVars: ["REA_JEB_MCP_URL"],
    unlocks: "JEB project units and type/method pseudo-code from a JEB client you started and that serves MCP.",
  },
  {
    id: "pwntools",
    label: "pwntools (Python)",
    bins: ["python3"],
    envVars: ["REA_PWNTOOLS_PYTHON"],
    unlocks: "Offline ELF layout inspection and recorded Linux crash inspection.",
  },
  {
    id: "mitmdump",
    label: "mitmdump",
    bins: ["mitmdump"],
    envVars: ["REA_MITMDUMP_COMMAND"],
    unlocks: "Reading native mitmproxy network captures (HAR files need nothing extra).",
  },
  {
    id: "browser",
    label: "Chrome-family browser",
    bins: ["google-chrome", "chromium", "chromium-browser", "chrome"],
    envVars: ["REA_BROWSER_EXECUTABLE"],
    unlocks: "Browser scenarios and page inspection through a Chrome-family browser.",
  },
]);

export const ENGINE_IDS = Object.freeze(ENGINES.map((e) => e.id));

export function engineById(id) {
  return ENGINES.find((e) => e.id === id) || null;
}

export function isProviderId(id) {
  return typeof id === "string" && PROVIDER_IDS.includes(id);
}
