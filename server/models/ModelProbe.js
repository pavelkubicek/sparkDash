/**
 * ModelProbe — is a model actually up?
 *
 * Runs on its own timer, independent of the Spark monitors, so the panel is
 * correct even when every browser tab is closed (the scheduler needs that: it
 * must not inherit `updateClientState()`'s pause).
 *
 * Two independent signals, OR'd together:
 *   1. `docker ps --format '{{.Names}}' | grep -qx <name>` — the container the
 *      repo's start.sh creates. Cheap and definitive when configured.
 *   2. `GET http://127.0.0.1:<port>/v1/models` — answers for a model whose
 *      server is ready to serve, even if the container is named differently
 *      (or runs on the worker only). Loopback because host network_mode makes
 *      the container's own binds reachable here and start.sh defaults to
 *      --host 127.0.0.1.
 *
 * The docker check is a single host exec for *all* models per tick (one
 * `docker ps`, matched locally), not one exec per model. Port checks run in
 * parallel with a short timeout.
 */
import { execOnHost } from "./hostExec.js";
import { LLM_PROBE_TIMEOUT_MS } from "../config.js";

/** Escape a container name for use as a fixed-string grep pattern. */
function grepFixed(name) {
  // grep -F takes the pattern literally; single-quote it for sh.
  return `'${String(name).replace(/'/g, `'\\''`)}'`;
}

/**
 * List running container names on the host with one command.
 * Returns null on failure (dockerd unreachable / nsenter missing) so callers
 * can distinguish "not running" from "unknown".
 * @returns {Promise<Set<string>|null>}
 */
export async function listRunningContainers() {
  const res = await execOnHost("docker ps --format '{{.Names}}' 2>/dev/null", {
    timeoutMs: 6000,
  });
  if (res.error || (res.code !== 0 && !res.stdout)) return null;
  return new Set(
    res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
  );
}

/**
 * Probe one candidate port for an OpenAI-compatible /v1/models.
 * @returns {Promise<{ ok: boolean, modelId: string|null, status: number|null, error: string|null }>}
 */
export async function probeModelPort(port, timeoutMs = LLM_PROBE_TIMEOUT_MS) {
  const url = `http://127.0.0.1:${port}/v1/models`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      return { ok: false, modelId: null, status: res.status, error: `HTTP ${res.status}` };
    }
    let modelId = null;
    try {
      const data = JSON.parse(text);
      const first = Array.isArray(data?.data) ? data.data[0] : null;
      modelId = typeof first?.id === "string" ? first.id : null;
    } catch {
      /* non-JSON body still proves the port is answering */
    }
    return { ok: true, modelId, status: res.status, error: null };
  } catch (err) {
    const msg = err?.name === "TimeoutError" ? "timeout" : err?.message || String(err);
    return { ok: false, modelId: null, status: null, error: msg };
  }
}

/**
 * Fold probe results onto model configs. Pure — the caller owns the cache so
 * the WS payload can stay byte-stable between ticks.
 *
 * Port attribution: every kit here serves on the same 8000, so "something
 * answers on :8000" does NOT prove *this* model is up. When a container for
 * that port is confirmed up, that container owns the port and the other
 * models probing it are told the port is held elsewhere. Only when no
 * container claims the port does a bare port answer prove liveness.
 *
 * @param {object[]} models registry configs
 * @param {{ containers: Set<string>|null, ports: Record<string, {ok:boolean, modelId:string|null, error:string|null}>, checkedAt?: number }} result
 * @returns {Record<string, { running: boolean, containerUp: boolean, portUp: boolean,
 *   modelId: string|null, checkedAt: number, error: string|null }>}
 */
export function buildModelStatus(models, result) {
  const out = {};
  const containers = result?.containers;
  const ports = result?.ports || {};
  // port → model that owns it via a confirmed-up container.
  const portOwner = {};
  if (containers) {
    for (const m of models) {
      if (m.port == null || !m.container) continue;
      if (containers.has(m.container)) portOwner[String(m.port)] = m;
    }
  }
  for (const m of models) {
    const containerUp = containers ? Boolean(m.container && containers.has(m.container)) : null;
    const portRes = m.port != null ? ports[String(m.port)] || null : null;
    const owner = m.port != null ? portOwner[String(m.port)] : null;
    const heldByOther =
      portRes?.ok && owner && owner.id !== m.id ? owner.name || owner.id : null;

    /**
     * `portChecked` records whether :port was actually asked this tick. When a
     * confirmed container settles the question the GET is skipped and the
     * verdict comes from the container list instead — strictly more honest than
     * a request that could only ever answer "someone else is holding it".
     */
    let portUp = null;
    let portChecked = true;
    let modelId = null;
    if (portRes) {
      portUp = portRes.ok ? !heldByOther : false;
      modelId = heldByOther ? null : portRes.modelId ?? null;
    } else if (owner && containers) {
      portChecked = false; // docker ps settled it, no HTTP needed
      portUp = owner.id === m.id;
    } else if (m.port != null) {
      portChecked = false; // docker failed and this port was not asked
    }

    // Unknown container status (docker check failed) must not read as down.
    const running = Boolean(containerUp === true || (portChecked && portUp === true));
    const errors = [];
    if (containers === null && m.container) errors.push("docker ps unavailable");
    if (heldByOther) errors.push(`:${m.port} answering but held by ${heldByOther}`);
    else if (!portChecked && owner && owner.id !== m.id)
      errors.push(`:${m.port} held by ${owner.name || owner.id}`);
    else if (portRes && !portRes.ok && portRes.error) errors.push(`:${m.port} ${portRes.error}`);

    out[m.id] = {
      running,
      containerUp,
      portUp: portChecked || owner ? portUp : null,
      portChecked,
      modelId,
      checkedAt: result?.checkedAt ?? null,
      error: errors.length ? errors.join("; ") : null,
    };
  }
  return out;
}

/**
 * Which ports still need an HTTP probe, given the running-container list.
 *
 * Only ONE model can run at a time (that is what this panel exists to
 * guarantee), so the container list already settles most questions:
 *
 *  - Port P is *owned* by the model whose container is confirmed up on P. That
 *    model's liveness is proven by the container, and every other model on P is
 *    known not to be the one answering — a GET for either would only re-derive
 *    what docker already told us. Skipped.
 *  - A port nobody owns is probed: either it is refused (cheap) or something
 *    unscheduled answers it, which is news worth having.
 *  - `forcePorts` (a start/restart job in flight, or the manual Refresh button)
 *    are always probed — readiness detection has to watch the port flip up
 *    while the container exists but is still loading weights.
 *
 * @param {object[]} models
 * @param {Set<string>|null} containers running container names, or null when unknown
 * @param {Set<string>} [forcePorts] port keys that must be probed regardless
 * @returns {Set<string>} port keys to probe
 */
export function portsNeedingProbe(models, containers, forcePorts = new Set()) {
  const wanted = new Set();
  const owners = new Set();
  if (containers) {
    for (const m of models) {
      if (m.port != null && m.container && containers.has(m.container)) owners.add(String(m.port));
    }
  }
  for (const m of models) {
    if (!Number.isInteger(m.port) || m.port < 1 || m.port > 65535) continue;
    const key = String(m.port);
    if (forcePorts.has(key)) wanted.add(key);
    else if (owners.has(key)) continue; // settled by docker ps
    else wanted.add(key);
  }
  return wanted;
}

/**
 * Poll every model once. Never throws; on infrastructure failure it reports
 * null containers so the caller can keep the previous status.
 *
 * The container list is fetched first because it decides how much HTTP work is
 * left (see portsNeedingProbe): with one model running that is normally a
 * single `docker ps` and ZERO port probes.
 *
 * @param {object[]} models
 * @param {{ portTimeoutMs?: number, fetchPort?: typeof probeModelPort, listContainers?: typeof listRunningContainers, forcePorts?: Iterable<string|number> }} [opts]
 */
export async function probeModels(models, opts = {}) {
  const listContainers = opts.listContainers || listRunningContainers;
  const fetchPort = opts.fetchPort || probeModelPort;
  const portTimeoutMs = opts.portTimeoutMs || LLM_PROBE_TIMEOUT_MS;
  const forcePorts = new Set(Array.from(opts.forcePorts || []).map(String));

  const containers = await Promise.resolve()
    .then(() => listContainers())
    .catch(() => null);

  const wantedPorts = [...portsNeedingProbe(models, containers, forcePorts)];
  const portResults = await Promise.all(
    wantedPorts.map(async (p) => {
      const r = await fetchPort(p, portTimeoutMs).catch((err) => ({
        ok: false,
        modelId: null,
        status: null,
        error: err?.message || String(err),
      }));
      return [String(p), r];
    })
  );

  return {
    containers,
    ports: Object.fromEntries(portResults),
    // Caller replaces this before diffing; kept out of the WS payload.
    checkedAt: Date.now(),
  };
}
