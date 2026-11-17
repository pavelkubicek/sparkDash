import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SparkSnapshot } from "../../api/types";
import { makeSpark } from "../../testing/fixtures";
import { cleanupRenders, flush, render } from "../../testing/render";
import { KioskKrakenPage } from "./KioskKrakenPage";

let sparks: SparkSnapshot[] = [];
/** Flipped per test to simulate a bridge the kiosk cannot reach. */
let bridgesDown = false;
/** The orchestrator bridge's status payload, live-shaped; mutable so a test can pin one field set. */
let orchestratorStatus: Record<string, unknown> = { slots_used: 2, slots_total: 4 };
/** The auditor bridge's status payload, live-shaped; mutable so a test can pin one field set. */
let auditorStatus: Record<string, unknown> = { analyzing: 0, checking: 0, reviews_queued: 0, slots_used: 1, slots_total: 4 };
/** The PR Companion bridge's status payload, live-shaped; mutable so a test can pin one field set. */
let pcStatus: Record<string, unknown> = { analyzing: 0, queued: 0, slots_used: 1, slots_total: 4 };
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
  fetchOrchestratorStatus: () => (bridgesDown ? Promise.reject(new Error("down")) : Promise.resolve(orchestratorStatus)),
  fetchAuditorStatus: () => (bridgesDown ? Promise.reject(new Error("down")) : Promise.resolve(auditorStatus)),
  fetchPrCompanionStatus: () => (bridgesDown ? Promise.reject(new Error("down")) : Promise.resolve(pcStatus)),
  fetchAiProxyStats: () => (bridgesDown ? Promise.reject(new Error("down")) : Promise.resolve({ totals: { total_tokens: 1_234_567 } })),
}));

beforeEach(() => {
  window.history.replaceState(null, "", "/kiosk-kraken");
  bridgesDown = false;
  orchestratorStatus = { slots_used: 2, slots_total: 4 };
  auditorStatus = { analyzing: 0, checking: 0, reviews_queued: 0, slots_used: 1, slots_total: 4 };
  pcStatus = { analyzing: 0, queued: 0, slots_used: 1, slots_total: 4 };
  vi.useFakeTimers();
});

afterEach(() => {
  cleanupRenders();
  vi.useRealTimers();
  document.documentElement.setAttribute("data-theme", "dark");
});

describe("KioskKrakenPage", () => {
  it("shows the static row (tok/s, proxy requests) and the four carousel slides", async () => {
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

    // Bottom carousel: four slides mounted — (temp, tokens) active first.
    const slides = [...container.querySelectorAll(".kk-slide")];
    expect(slides).toHaveLength(4);
    expect(slides[0].classList.contains("is-active")).toBe(true);
    expect(slides[1].classList.contains("is-active")).toBe(true);
    expect(slides[0].textContent).toContain("55°");
    expect(slides[1].textContent).toContain("1.23M");
    expect(slides[2].classList.contains("is-active")).toBe(false);
    expect(slides[3].classList.contains("is-active")).toBe(false);
    // The slots slide reads the shared pool: 2 orchestrator + 1 auditor + 1 companion
    // acquired of the orchestrator's 4 — mounted and readable while hidden.
    expect(slides[2].textContent).toContain("4 / 4");
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
    expect(activeKeys()).toEqual(["slots"]);
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

  it("renders the shared slots as a segmented bar sized by each service's slots_used", async () => {
    sparks = [makeSpark("a")];
    const { container } = render(<KioskKrakenPage />);
    await flush();
    const slide = [...container.querySelectorAll(".kk-slide")].find((s) => s.className.includes("kk-slide--slots"))!;
    expect(slide.getAttribute("aria-label")).toContain("AI slots");
    // The caption above the bar: exact text, decorative — the slide's aria-label names the section.
    const heading = slide.querySelector(".kk-slots-heading");
    expect(heading?.textContent).toBe("AI slots");
    expect(heading?.getAttribute("aria-hidden")).toBe("true");
    // 2 orchestrator + 1 auditor + 1 companion of the orchestrator's pool of 4.
    expect(slide.querySelector(".kk-value")!.textContent).toBe("4 / 4");
    const width = (name: string) => slide.querySelector<HTMLElement>(`.kk-slotbar-segment--${name}`)?.style.width;
    expect(width("orchestrator")).toBe("50%");
    expect(width("companion")).toBe("25%");
    expect(width("auditor")).toBe("25%");
    // Paint order is pinned: green orchestrator, then blue companion, then orange auditor.
    expect(
      [...slide.querySelectorAll<HTMLElement>(".kk-slotbar-segment")].map((el) => el.className)
    ).toEqual([
      expect.stringContaining("kk-slotbar-segment--orchestrator"),
      expect.stringContaining("kk-slotbar-segment--companion"),
      expect.stringContaining("kk-slotbar-segment--auditor"),
    ]);
  });

  it("holds the frame when a bridge is unreachable — dashes, never zeros", async () => {
    bridgesDown = true;
    sparks = [makeSpark("a")];
    const { container } = render(<KioskKrakenPage />);
    await flush();

    const row = [...container.querySelectorAll(".kk-row .kk-tile")].map((t) => t.textContent);
    // The request numbers come from the snapshot, so they survive a bridge outage.
    expect(row[1]).toContain("2/0");
    const slides = [...container.querySelectorAll(".kk-slide")];
    // Temperature comes from the snapshot, the bridges' slides read "—".
    expect(slides[0].textContent).toContain("55°");
    expect(slides[1].textContent).toContain("—");
    // The slots slide: no bridge answered, so the readout dashes and the track stays
    // empty — an unreachable pool renders no fill, never a fabricated one.
    expect(slides[2].textContent).toContain("— / —");
    expect(slides[2].querySelectorAll(".kk-slotbar-segment")).toHaveLength(0);
    // Models come from the WS snapshot, so the list survives the outage.
    expect(slides[3].textContent).toContain("DS41");
  });
});
