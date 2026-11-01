/**
 * takeover.js — what a Start must stop first, if anything.
 *
 * The fleet can run several clusters side by side (two 2-Spark models, or a
 * pair of standalone units), so a launch is NOT exclusive against every
 * registered model — only against the ones that share a Spark with the
 * target. Anything else runs on its own machines and stays untouched.
 *
 * Within the overlap the fail-closed rule stands with one exclusion: a model
 * is treated as an incumbent unless the probe PROVED it down, or it has no
 * probe verdict at all. A card that has never been seen up — a fresh
 * registration whose first probe has not answered yet — holds nothing; only a
 * model the fleet has actually observed can still be holding the GPU. A model
 * invisible to `docker ps` or to the port probe since its first tick still
 * counts: it may hold the GPU and the port, and silently double-booking it
 * surfaces as the new kit's own port validation — the only guard left
 * standing.
 */
import { certainlyDown } from "./ModelProbe.js";
import { modelOccupancy } from "./ModelRegistry.js";

/**
 * @param {object[]} models registry configs
 * @param {Record<string, object>} status latest probe status map
 * @param {object} target the model about to start/restart
 * @returns {{ incumbents: {id: string, name: string, sparks: string[]}[] }}
 *   models sharing at least one Spark with the target that are neither
 *   proven down nor never observed; `sparks` are the shared units (why they
 *   are in the way). Empty array = the launch is not in anyone's way and may
 *   start without asking.
 */
export function planTakeover(models, status, target) {
  const targetNodes = new Set(modelOccupancy(target));
  const incumbents = [];
  for (const m of models) {
    if (!m || m.id === target.id) continue;
    const shared = modelOccupancy(m).filter((s) => targetNodes.has(s));
    if (!shared.length) continue;
    const st = status?.[m.id];
    // Never probed (fresh card, first tick pending) or unplaceable (no run
    // target — its own actions refuse, so it cannot hold anything): skip.
    if (!st || (st.containerUp == null && st.portUp == null && st.portChecked === false)) continue;
    if (certainlyDown(st, m)) continue;
    incumbents.push({ id: m.id, name: m.name || m.id, sparks: shared });
  }
  return { incumbents };
}
