import { useEffect, useRef, useState } from "react";
import { fetchUpdatesSummary } from "../api/client";
import type { UpdateSummary } from "../api/types";

/** The nav badge is cheap; a minute between reads is enough (the daily checks move slowly). */
const SUMMARY_POLL_MS = 60_000;

/**
 * The fleet update summary behind the Updates rail item's warn dot: polled once a minute while the
 * dashboard is connected (and once the moment it connects). A failed poll keeps the last summary —
 * unknown is never presented as healthy — and the dot stays off until the first summary answers.
 */
export function useUpdatesSummary(connected: boolean): UpdateSummary | null {
  const [summary, setSummary] = useState<UpdateSummary | null>(null);
  /** A newer connection wins: answers of an older one are dropped. */
  const generation = useRef(0);

  useEffect(() => {
    if (!connected) return;
    const mine = ++generation.current;
    const pull = async () => {
      try {
        const next = await fetchUpdatesSummary();
        if (mine === generation.current) setSummary(next);
      } catch {
        /* keep the last summary; the next poll tries again */
      }
    };
    void pull();
    const timer = window.setInterval(() => void pull(), SUMMARY_POLL_MS);
    return () => {
      generation.current += 1;
      window.clearInterval(timer);
    };
  }, [connected]);

  return summary;
}
