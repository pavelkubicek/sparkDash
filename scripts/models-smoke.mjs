/**
 * Read-only smoke test for the model launcher (dev only — not part of npm test).
 * NEVER starts/stops/restarts a model and never enables the scheduler. It only
 * loads the registry, runs one probe pass, and prints the WS payload.
 *
 * Run: node scripts/models-smoke.mjs
 */
import { ModelRegistry } from "../server/models/ModelRegistry.js";
import { ModelLauncher } from "../server/models/ModelLauncher.js";
import { listRunningContainers, probeModelPort } from "../server/models/ModelProbe.js";

const reg = new ModelRegistry();
console.log("registry ids:", reg.modelIds);
for (const m of reg.models) {
  console.log(
    ` - ${m.id}: dir=${m.dir} start=${m.startScript} stop=${m.stopScript} restart=${m.restartScript} logs=${m.logsScript} container=${m.container} port=${m.port}`
  );
}

console.log("\n-- host exec (read-only) --");
const containers = await listRunningContainers();
console.log(
  "docker ps available:",
  containers !== null,
  containers ? `(${containers.size} containers)` : ""
);
if (containers) {
  console.log(
    "  has vllm-fn:",
    containers.has("vllm-fn"),
    "| has glm53-exl3-head:",
    containers.has("glm53-exl3-head")
  );
}

const port = await probeModelPort(8000);
console.log("port 8000 /v1/models:", JSON.stringify(port));

console.log("\n-- launcher payload (single probe pass) --");
const launcher = new ModelLauncher({ onStatusChange: () => {} });
await launcher.refresh();
const payload = launcher.snapshotPayload();
console.log(JSON.stringify(payload, null, 2));

// Byte-stability of the payload is what keeps index.js's diff cache from
// thrashing: a Date.now() anywhere in here would break it.
const a = JSON.stringify(launcher.snapshotPayload());
await new Promise((r) => setTimeout(r, 1200));
const b = JSON.stringify(launcher.snapshotPayload());
console.log("\npayload stable across 1.2s:", a === b);
console.log("payload bytes:", a.length);
launcher.stopTimers();
process.exit(0);
