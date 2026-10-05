import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { render } from "../testing/render";
import { makeSpark } from "../testing/fixtures";
import type { LlmMetrics, SparkSnapshot } from "../api/types";
import { fleetGenerationTps, useAppBadge } from "./useAppBadge";

interface BadgeHarnessProps {
  sparks: readonly SparkSnapshot[];
  connected: boolean;
}

function BadgeHarness({ sparks, connected }: BadgeHarnessProps) {
  useAppBadge(sparks, connected);
  return null;
}

type UpdateHarness = (sparks: readonly SparkSnapshot[], connected: boolean) => void;

/** Renders the harness and exposes a prop-flipping update. */
function mountHarness(initialSparks: readonly SparkSnapshot[], initialConnected: boolean): UpdateHarness {
  const root = render(<BadgeHarness sparks={initialSparks} connected={initialConnected} />);
  return (sparks: readonly SparkSnapshot[], connected: boolean) =>
    act(() => root.root.render(<BadgeHarness sparks={sparks} connected={connected} />));
}

function stubBadgeApi() {
  const calls: Array<"set" | "clear"> = [];
  const setAppBadge = vi.fn(async () => void calls.push("set"));
  const clearAppBadge = vi.fn(async () => void calls.push("clear"));
  Object.defineProperty(navigator, "setAppBadge", { value: setAppBadge, configurable: true });
  Object.defineProperty(navigator, "clearAppBadge", { value: clearAppBadge, configurable: true });
  return { calls, setAppBadge, clearAppBadge };
}

function removeBadgeApi() {
  for (const k of ["setAppBadge", "clearAppBadge"]) {
    delete (navigator as unknown as Record<string, unknown>)[k];
  }
}

describe("fleetGenerationTps", () => {
  it("sums every LLM port's generationTps across sparks", () => {
    const a = makeSpark("a");
    const b = makeSpark("b");
    // Same partial shape makeSpark uses for its single fixture port.
    const secondPort = {
      available: true,
      backend: "vllm",
      modelId: "fixture-model",
      generationTps: 12.4,
      prefillTps: 0,
    } as LlmMetrics;
    b.metrics.llm.push(secondPort);
    expect(fleetGenerationTps([a, b])).toBeCloseTo(52.4);
  });

  it("ignores idle (0) and NaN readings", () => {
    const spark = makeSpark("idle");
    spark.metrics.llm[0].generationTps = 0;
    // Partial stub — only the fields the reducer reads.
    const nanPort = { available: false, generationTps: NaN } as LlmMetrics;
    spark.metrics.llm.push(nanPort);
    expect(fleetGenerationTps([spark])).toBe(0);
  });
});

describe("useAppBadge", () => {
  let badge: ReturnType<typeof stubBadgeApi>;

  beforeEach(() => {
    badge = stubBadgeApi();
  });

  afterEach(removeBadgeApi);

  it("clears when the fleet is idle or disconnected", () => {
    const update = mountHarness([makeSpark()], true);
    expect(badge.calls).toContain("set");
    update([makeSpark()], false);
    expect(badge.calls).toEqual(["set", "clear"]);
  });

  it("rounds the aggregate and skips redundant badge writes", () => {
    const busy = makeSpark("busy");
    busy.metrics.llm[0].generationTps = 12.4; // → 12
    const update = mountHarness([busy], true);
    expect(badge.setAppBadge).toHaveBeenCalledWith(12);

    // Same rounded value in a new WS frame → no second write.
    const busy2 = makeSpark("busy");
    busy2.metrics.llm[0].generationTps = 12.4;
    update([busy2], true);
    expect(badge.setAppBadge).toHaveBeenCalledTimes(1);

    // Crossing the rounding boundary → new write.
    const busier = makeSpark("busy");
    busier.metrics.llm[0].generationTps = 12.6; // → 13
    update([busier], true);
    expect(badge.setAppBadge).toHaveBeenLastCalledWith(13);
  });

  it("clears the badge on unmount", () => {
    mountHarness([makeSpark()], true);
    // cleanupRenders() unmounts in afterEach (testing/setup.ts) → clear.
    expect(badge.calls).toEqual(["set"]);
  });

  it("is a no-op without the Badging API", () => {
    removeBadgeApi();
    expect(() => mountHarness([makeSpark()], true)).not.toThrow();
  });
});
