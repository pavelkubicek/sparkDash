import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SparkSnapshot } from "../../api/types";
import { makeSpark } from "../../testing/fixtures";
import { cleanupRenders, flush, render } from "../../testing/render";
import { KioskKrakenPage } from "./KioskKrakenPage";

let sparks: SparkSnapshot[] = [];
/** Flipped per test to simulate a bridge the kiosk cannot reach. */
let bridgesDown = false;
/** The WS snapshot's models block: DS41 serving, GLM stopped. */
const wsModels = {
  models: [
    { id: "a", name: "DeepSeek V4.1 Flash", kioskName: "DS41", status: { running: true } },
    { id: "b", name: "GLM-5.3 Flash", kioskName: null, status: { running: false } },
  ],
  activeJobs: null,
  scheduler: {},
};

vi.mock("../../hooks/useSnapshot", () => ({
  useSnapshot: () => ({ sparks, models: wsModels, connected: true, lastValidSnapshotAt: Date.now(), refreshInterval: 2_000, serverAlerts: null }),
}));

vi.mock("../../api/client", () => ({
  fetchSettings: () => Promise.resolve({ temperatureUnit: "celsius", alertsEnabled: false, hideWorkers: false, timeZone: null }),
  fetchOrchestratorRunningTasks: () =>
    bridgesDown ? Promise.reject(new Error("down")) : Promise.resolve([{ task_id: "t1" }, { task_id: "t2" }, { task_id: "t3" }]),
  fetchOrchestratorPlans: () =>
    bridgesDown ? Promise.reject(new Error("down")) : Promise.resolve([{ status: "processing" }, { status: "completed" }]),
  fetchAuditorStatus: () =>
    bridgesDown ? Promise.reject(new Error("down")) : Promise.resolve({ analyzing: 4, reviews_queued: 2 }),
  fetchAiProxyStats: () => (bridgesDown ? Promise.reject(new Error("down")) : Promise.resolve({ totals: { total_tokens: 1_234_567 } })),
}));

beforeEach(() => {
  window.history.replaceState(null, "", "/kiosk-kraken");
  bridgesDown = false;
  vi.useFakeTimers();
});

afterEach(() => {
  cleanupRenders();
  vi.useRealTimers();
  document.documentElement.setAttribute("data-theme", "dark");
});

describe("KioskKrakenPage", () => {
  it("shows the static row (tok/s, proxy requests) and the five carousel slides", async () => {
    sparks = [makeSpark("a"), makeSpark("b")];
    (sparks[0].metrics.llm as unknown as Array<Record<string, unknown>>)[0].requestsWaiting = 2;
    const { container } = render(<KioskKrakenPage />);
    await flush();

    // Brand mark with wordmark, linking back to the dashboard.
    // The brand is gone from the round glass; the whole face is tiles.
    expect(container.querySelector(".kk-brand")).toBeNull();

    // Top row: two units at 20 tok/s each (integers). The request numbers are the engines' own
    // gauges, as the dashboard's AI-proxy panel shows them: 2 running on each unit, 2 waiting.
    const row = [...container.querySelectorAll(".kk-row .kk-tile")];
    expect(row).toHaveLength(2);
    expect(row[0].textContent).toContain("40");
    expect(row[1].querySelector(".kk-value")!.textContent).toBe("4/2");

    // Bottom carousel: five slides mounted — (temp, tokens) active first.
    const slides = [...container.querySelectorAll(".kk-slide")];
    expect(slides).toHaveLength(5);
    expect(slides[0].classList.contains("is-active")).toBe(true);
    expect(slides[1].classList.contains("is-active")).toBe(true);
    expect(slides[0].textContent).toContain("55°");
    expect(slides[1].textContent).toContain("1.23M");
    expect(slides[2].classList.contains("is-active")).toBe(false);
    expect(slides[3].classList.contains("is-active")).toBe(false);
    expect(slides[2].textContent).toContain("3"); // orchestrator running
    expect(slides[2].querySelector(".kk-waiting")!.textContent).toBe("/1"); // queued plans
    expect(slides[3].textContent).toContain("4"); // auditor analyzing
    expect(slides[3].querySelector(".kk-waiting")!.textContent).toBe("/2"); // queued reviews
  });

  it("swaps the carousel groups every 3 seconds and wraps, models slide spanning the row", async () => {
    sparks = [makeSpark("a")];
    const { container } = render(<KioskKrakenPage />);
    await flush();
    const slides = () => [...container.querySelectorAll(".kk-slide")];
    const activeKeys = () => slides().filter((s) => s.classList.contains("is-active")).map((s) => s.className.match(/kk-slide--(\w+)/)?.[1]);

    // First group: temperature + tokens; the models slide is mounted but hidden.
    expect(activeKeys()).toEqual(["temp", "tokens"]);
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(activeKeys()).toEqual(["orchestrator", "auditor"]);
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    // Third group: the models list alone, full width, showing kiosk names of running models.
    expect(activeKeys()).toEqual(["models"]);
    expect(slides().find((s) => s.className.includes("kk-slide--models"))!.classList.contains("kk-slide--models")).toBe(true);
    expect(slides().find((s) => s.className.includes("kk-slide--models"))!.textContent).toContain("DS41");
    expect(slides().find((s) => s.className.includes("kk-slide--models"))!.textContent).not.toContain("GLM");
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    // Third tick wraps the cycle: back to the first group.
    expect(activeKeys()).toEqual(["temp", "tokens"]);
  });

  it("holds the frame when a bridge is unreachable — dashes, never zeros", async () => {
    bridgesDown = true;
    sparks = [makeSpark("a")];
    const { container } = render(<KioskKrakenPage />);
    await flush();

    const row = [...container.querySelectorAll(".kk-row .kk-tile")].map((t) => t.textContent);
    // The request numbers come from the snapshot, so they survive a bridge outage.
    expect(row[1]).toContain("2/0");
    const slides = [...container.querySelectorAll(".kk-slide")].map((t) => t.textContent);
    // Temperature comes from the snapshot, the bridges' slides read "—".
    expect(slides[0]).toContain("55°");
    expect(slides[1]).toContain("—");
    expect(slides[2]).toContain("—");
    expect(slides[3]).toContain("—");
  });
});
