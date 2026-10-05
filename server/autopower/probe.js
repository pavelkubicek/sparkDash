/**
 * createAutoPowerProbe — one-shot read of the two idleness sources:
 *
 *   AI proxy  — observer API (GET /observer/api/streaming,
 *               /observer/api/active-requests). In-flight = array lengths.
 *   Orchestrator — GET /api/status (slots_used, tickets_active) plus
 *               GET /api/plans (plan-generation runs not yet ticketed).
 *
 * Both fetchers are injected (index.js passes the same bridge helpers the
 * UI uses), so the probe reads exactly what the dashboard shows. A source
 * that errors or answers non-200 is reported ok:false — the manager treats
 * unknown as busy, never as idle.
 */

/** Plan statuses that are still work (terminal "failed" excluded on purpose:
 *  a failed plan holds no claim on the sparks). */
const BUSY_PLAN_STATUSES = new Set(["queued", "processing", "creating_ticket"]);

const asLen = (json) => (Array.isArray(json) ? json.length : 0);
const asNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * @param {object} deps
 * @param {(path: string, init?: object) => Promise<{status:number, json:any}>} deps.aiProxyFetch
 * @param {(path: string, init?: object) => Promise<{status:number, json:any}>} deps.orchestratorFetch
 * @returns {() => Promise<object>} probe snapshot for one AutoPower tick
 */
export function createAutoPowerProbe({ aiProxyFetch, orchestratorFetch }) {
  return async function autoPowerProbe() {
    const out = { at: Date.now(), proxy: { ok: false }, orchestrator: { ok: false } };

    try {
      const [streams, requests] = await Promise.all([
        aiProxyFetch("/observer/api/streaming", { method: "GET" }),
        aiProxyFetch("/observer/api/active-requests", { method: "GET" }),
      ]);
      if (streams.status !== 200 || requests.status !== 200) {
        throw new Error(`observer responded ${streams.status}/${requests.status}`);
      }
      out.proxy = {
        ok: true,
        streams: asLen(streams.json),
        requests: asLen(requests.json),
      };
    } catch (err) {
      out.proxy = { ok: false, error: err?.message || String(err) };
    }

    try {
      const [status, plans] = await Promise.all([
        orchestratorFetch("/api/status", { method: "GET" }),
        orchestratorFetch("/api/plans", { method: "GET" }),
      ]);
      if (status.status !== 200) throw new Error(`status responded ${status.status}`);
      if (plans.status !== 200) throw new Error(`plans responded ${plans.status}`);
      const st = status.json && typeof status.json === "object" ? status.json : {};
      out.orchestrator = {
        ok: true,
        slotsUsed: asNum(st.slots_used),
        ticketsActive: asNum(st.tickets_active),
        plansActive: Array.isArray(plans.json)
          ? plans.json.filter((p) => BUSY_PLAN_STATUSES.has(p?.status)).length
          : 0,
      };
    } catch (err) {
      out.orchestrator = { ok: false, error: err?.message || String(err) };
    }

    return out;
  };
}

/** Reasons the snapshot is NOT idle ([] = idle). Pure — shared with tests. */
export function busyReasons(sources) {
  const reasons = [];
  const p = sources?.proxy;
  const o = sources?.orchestrator;
  if (!p?.ok) reasons.push(`AI proxy unreachable (${p?.error || "no probe"})`);
  else {
    if (p.streams > 0) reasons.push(`${p.streams} streaming request(s) in proxy`);
    if (p.requests > 0) reasons.push(`${p.requests} active request(s) in proxy`);
  }
  if (!o?.ok) reasons.push(`Orchestrator unreachable (${o?.error || "no probe"})`);
  else {
    if (o.slotsUsed > 0) reasons.push(`${o.slotsUsed} orchestrator slot(s) in use`);
    if (o.ticketsActive > 0) reasons.push(`${o.ticketsActive} ticket(s) in the orchestrator`);
    if (o.plansActive > 0) reasons.push(`${o.plansActive} plan run(s) in the orchestrator`);
  }
  return reasons;
}
