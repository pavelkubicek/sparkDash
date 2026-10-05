import { useEffect, useRef } from "react";
import type { SparkSnapshot } from "../api/types";

/**
 * Fleet-wide current tok/s: the sum of every LLM port's live generation
 * throughput across all sparks. Mirrors what the Overview cards label "tok/s"
 * (decode only — prefill is a separate number in the UI). Zero readings
 * (idle port / probe-down) contribute nothing, and a NaN reading is dropped
 * naturally by the > 0 test.
 */
export function fleetGenerationTps(sparks: readonly SparkSnapshot[]): number {
  let total = 0;
  for (const s of sparks) {
    const llm = s.metrics?.llm;
    if (!llm) continue;
    for (const m of llm) {
      if (m.generationTps > 0) total += m.generationTps;
    }
  }
  return total;
}

/**
 * PWA app-badge via the Badging API (navigator.setAppBadge): shows the current
 * fleet tok/s on the installed app icon, clears when idle or disconnected.
 *
 * The LLM probe keeps polling while no client watches a fleet (see
 * SparkMonitor.pause — only HW polling pauses), and WebSocket frames still
 * arrive in a hidden tab, so the badge stays live even when the PWA is
 * otherwise in the background. Browsers without the API are a no-op; the
 * platform rejecting a badge call (unsupported surface, not installed, …) is
 * swallowed — a badge is pure decoration and must never surface as an error.
 */
export function useAppBadge(sparks: readonly SparkSnapshot[], connected: boolean): void {
  /** Last value pushed to the platform — skips redundant badge writes. */
  const lastBadge = useRef<number | null>(null);

  useEffect(() => {
    if (!("setAppBadge" in navigator)) return;
    const tps = connected ? fleetGenerationTps(sparks) : 0;
    const badge = tps > 0 ? Math.round(tps) : null; // null = clear
    if (badge === lastBadge.current) return;
    lastBadge.current = badge;
    try {
      const op = badge === null ? navigator.clearAppBadge() : navigator.setAppBadge(badge);
      void Promise.resolve(op).catch(() => {});
    } catch {
      // Best-effort decoration — ignore.
    }
  }, [sparks, connected]);

  // Leaving the page (app closed) must not leave a stale tok/s behind.
  useEffect(() => {
    return () => {
      if ("clearAppBadge" in navigator) {
        try {
          void Promise.resolve(navigator.clearAppBadge()).catch(() => {});
        } catch {
          // Best-effort decoration — ignore.
        }
      }
    };
  }, []);
}
