import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCpuClock, fetchSparks, resetFleetCpuClock, setFleetCpuClock } from "../api/client";
import type { CpuClockCoreMode, CpuClockStatus, FleetCpuClockResult, GpuClockPersistKind, SparkConfig } from "../api/types";
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
  mode: CpuClockCoreMode = "perf",
): Extract<CpuClockStatus, { supported: true }> => ({
  supported: true,
  hwMaxMHz: 3900,
  perfMaxMHz: 3900,
  allMaxMHz: 2808,
  effMaxMHz: 2808,
  perfCores: "2,3",
  heterogeneous: true,
  currentMaxMHz: capMHz ?? 3900,
  capMHz,
  capMode: capMHz === null ? null : mode,
  sudo: "yes",
  persistKind,
  service: {
    installed: false,
    maxMHz: null,
    cpus: null,
    mode: null,
    enabled: null,
    active: null,
  },
  cron: {
    installed: capMHz !== null && persistKind === "cron",
    maxMHz: capMHz !== null && persistKind === "cron" ? capMHz : null,
    cpus: capMHz !== null && persistKind === "cron" ? "2,3" : null,
    mode: capMHz !== null && persistKind === "cron" ? mode : null,
    failed: false,
  },
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

  it("defaults to performance cores and applies 2808 MHz to them", async () => {
    setApi.mockResolvedValue(
      done([
        { id: "spark1", ok: true, maxMHz: 2808, persistKind: "cron", perfOnly: true },
        { id: "spark2", ok: true, maxMHz: 2808, persistKind: "cron", perfOnly: true },
      ]),
    );
    const ref = { current: null as CpuClockApi | null };
    const { container } = render(<CpuClockCap apiRef={ref} />);
    await settle();

    expect(container.querySelector('[data-testid="cpu-fleet-now"]')!.textContent).toContain("full CPU frequency on 2 units");
    const toggle = container.querySelector('input[aria-label="Performance cores only"]') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    await click(byText(container, "Cap at 2808 MHz"));
    expect(ref.current!.pending()).toBe(true);

    expect(await ref.current!.apply()).toBe(true);
    expect(setApi).toHaveBeenCalledWith(2808, true, true);
    expect(resetApi).not.toHaveBeenCalled();
    await settle();
    expect(ref.current!.pending()).toBe(false);
  });

  it("caps all cores when the performance-cores toggle is off", async () => {
    setApi.mockResolvedValue(
      done([
        { id: "spark1", ok: true, maxMHz: 2808, persistKind: "cron", perfOnly: false },
        { id: "spark2", ok: true, maxMHz: 2808, persistKind: "cron", perfOnly: false },
      ]),
    );
    const ref = { current: null as CpuClockApi | null };
    const { container } = render(<CpuClockCap apiRef={ref} />);
    await settle();

    await click(container.querySelector('input[aria-label="Performance cores only"]') as HTMLInputElement);
    await click(byText(container, "Cap at 2808 MHz"));
    expect(await ref.current!.apply()).toBe(true);
    expect(setApi).toHaveBeenCalledWith(2808, true, false);
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

    expect(container.querySelector('[data-testid="cpu-fleet-now"]')!.textContent).toContain(
      "capped at 2808 MHz on performance cores",
    );
    await click(byText(container, "Full capacity"));
    expect(await ref.current!.apply()).toBe(true);
    expect(resetApi).toHaveBeenCalledTimes(1);
    expect(setApi).not.toHaveBeenCalled();
  });

  it("uses the edited frequency for the cap", async () => {
    setApi.mockResolvedValue(
      done([
        { id: "spark1", ok: true, maxMHz: 2500, persistKind: "cron", perfOnly: true },
        { id: "spark2", ok: true, maxMHz: 2500, persistKind: "cron", perfOnly: true },
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
    expect(setApi).toHaveBeenCalledWith(2500, true, true);
  });

  it("rejects a cap above the performance-core ceiling", async () => {
    const { container } = render(<CpuClockCap />);
    await settle();

    const input = container.querySelector('input[aria-label="CPU cap MHz"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, "3901");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    const cap = byText(container, "Cap at") as HTMLButtonElement;
    expect(cap.disabled).toBe(true);
  });
});
