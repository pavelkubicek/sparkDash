import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCpuClock, fetchSparks, resetFleetCpuClock, setFleetCpuClock } from "../api/client";
import type { CpuClockStatus, FleetCpuClockResult, GpuClockPersistKind, SparkConfig } from "../api/types";
import { CpuClockCap, type CpuClockApi } from "./CpuClockCap";
import { cleanupRenders, flush, render } from "../testing/render";

vi.mock("../api/client", () => ({
  fetchSparks: vi.fn(),
  fetchCpuClock: vi.fn(),
  setFleetCpuClock: vi.fn(),
  resetFleetCpuClock: vi.fn(),
}));

const listApi = vi.mocked(fetchSparks);
const statusApi = vi.mocked(fetchCpuClock);
const setApi = vi.mocked(setFleetCpuClock);
const resetApi = vi.mocked(resetFleetCpuClock);

const FLEET = {
  sparks: [
    { id: "spark1", kind: "spark" },
    { id: "spark2", kind: "spark" },
    { id: "desk", kind: "host" },
  ] as SparkConfig[],
};

const ready = (
  capMHz: number | null,
  persistKind: GpuClockPersistKind = "cron",
): Extract<CpuClockStatus, { supported: true }> => ({
  supported: true,
  hwMaxMHz: 3000,
  currentMaxMHz: capMHz ?? 3000,
  capMHz,
  sudo: "yes",
  persistKind,
  service: { installed: false, maxMHz: null, enabled: null, active: null },
  cron: { installed: persistKind === "cron", maxMHz: persistKind === "cron" ? capMHz : null, failed: false },
});

const done = (results: FleetCpuClockResult[]) => ({
  success: results.every((r) => r.ok) && results.some((r) => r.ok && !("supported" in r)),
  applied: results.filter((r) => r.ok && !("supported" in r)).length,
  results,
});

const byText = (c: HTMLElement, text: string) => {
  const button = [...c.querySelectorAll("button")].find((el) => el.textContent?.includes(text));
  if (!button) throw new Error(`no button matching ${text}`);
  return button;
};

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await flush();
};

const click = async (el: HTMLElement) => {
  el.click();
  await settle();
};

describe("CpuClockCap", () => {
  beforeEach(() => {
    listApi.mockReset().mockResolvedValue(FLEET);
    statusApi.mockReset().mockResolvedValue(ready(null));
    setApi.mockReset();
    resetApi.mockReset();
  });
  afterEach(() => {
    cleanupRenders();
    vi.useRealTimers();
  });

  it("picks 2808 MHz, waits for Save, and applies it to every Spark", async () => {
    setApi.mockResolvedValue(
      done([
        { id: "spark1", ok: true, maxMHz: 2808, persistKind: "cron" },
        { id: "spark2", ok: true, maxMHz: 2808, persistKind: "cron" },
      ]),
    );
    const ref = { current: null as CpuClockApi | null };
    const { container } = render(<CpuClockCap apiRef={ref} />);
    await settle();

    expect(container.querySelector('[data-testid="cpu-fleet-now"]')!.textContent).toContain("full CPU frequency on 2 units");
    await click(byText(container, "Cap at 2808 MHz"));
    expect(ref.current!.pending()).toBe(true);

    expect(await ref.current!.apply()).toBe(true);
    expect(setApi).toHaveBeenCalledWith(2808, true);
    expect(resetApi).not.toHaveBeenCalled();
    await settle();
    expect(ref.current!.pending()).toBe(false);
  });

  it("clears the cap through the reset route", async () => {
    statusApi.mockResolvedValue(ready(2808));
    resetApi.mockResolvedValue(
      done([
        { id: "spark1", ok: true, maxMHz: null, persistKind: "none" },
        { id: "spark2", ok: true, maxMHz: null, persistKind: "none" },
      ]),
    );
    const ref = { current: null as CpuClockApi | null };
    const { container } = render(<CpuClockCap apiRef={ref} />);
    await settle();

    await click(byText(container, "Full capacity"));
    expect(await ref.current!.apply()).toBe(true);
    expect(resetApi).toHaveBeenCalledTimes(1);
    expect(setApi).not.toHaveBeenCalled();
  });

  it("uses the edited frequency for the cap", async () => {
    setApi.mockResolvedValue(
      done([
        { id: "spark1", ok: true, maxMHz: 2500, persistKind: "cron" },
        { id: "spark2", ok: true, maxMHz: 2500, persistKind: "cron" },
      ]),
    );
    const ref = { current: null as CpuClockApi | null };
    const { container } = render(<CpuClockCap apiRef={ref} />);
    await settle();

    const input = container.querySelector('input[aria-label="CPU cap MHz"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "2500");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    await click(byText(container, "Cap at 2500 MHz"));
    expect(await ref.current!.apply()).toBe(true);
    expect(setApi).toHaveBeenCalledWith(2500, true);
  });
});
