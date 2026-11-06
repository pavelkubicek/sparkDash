import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelLauncherPanel } from "./ModelLauncherPanel";
import { ModelTakeoverDialog } from "./ModelTakeoverDialog";
import type * as ModelClient from "../../../api/modelClient";
import { ModelTakeoverRequired, startModel } from "../../../api/modelClient";
import { closeModelTakeoverDialog } from "../../../hooks/useModelTakeoverDialog";
import { closeModelCommandDialog } from "../../../hooks/useModelCommandDialog";
import type { ModelInfo, ModelJob, ModelsSnapshot } from "../../../api/modelTypes";
import { render, cleanupRenders, flush } from "../../../testing/render";

vi.mock("../../../api/modelClient", async (importOriginal) => {
  const actual = await importOriginal<typeof ModelClient>();
  return {
    ...actual,
    startModel: vi.fn(),
    stopModel: vi.fn(async () => ({ jobId: "stop-1", status: "running" })),
    restartModel: vi.fn(async () => ({ jobId: "r-1", status: "running" })),
    tailModelLogs: vi.fn(async () => ({ jobId: "l-1", status: "running" })),
    refreshModels: vi.fn(async () => ({ ok: true, status: {} })),
    setModelOrder: vi.fn(async () => ({ success: true, models: [] })),
    clearSchedulerOverride: vi.fn(async () => ({ success: true })),
    updateSchedulerConfig: vi.fn(async () => ({ enabled: false, tz: "UTC" })),
  };
});

const startMock = vi.mocked(startModel);

const NO_SCHEDULE = { enabled: false, weekday: [], weekend: [] } as const;
const DOWN = { running: false, containerUp: false, portUp: false, portChecked: true, modelId: null, error: null };
const UP = { running: true, containerUp: true, portUp: true, portChecked: true, modelId: "m", error: null };

function model(patch: Partial<ModelInfo> & Pick<ModelInfo, "id" | "name">): ModelInfo {
  return {
    kioskName: null,
    dir: `/repos/${patch.id}`,
    sparkId: "spark1",
    sparkName: "spark-1",
    nodes: ["spark1"],
    nodeNames: ["spark-1"],
    headSparkId: patch.sparkId ?? "spark1",
    headSparkName: patch.sparkName ?? "spark-1",
    description: null,
    container: `${patch.id}-head`,
    port: 8000,
    position: null,
    apiPath: null,
    repoUrl: null,
    hasLogs: true,
    canRestart: true,
    startArgs: null,
    schedule: { ...NO_SCHEDULE, weekday: [...NO_SCHEDULE.weekday], weekend: [...NO_SCHEDULE.weekend] },
    status: DOWN,
    job: null,
    ...patch,
  };
}

function mutatingJob(patch: Partial<ModelJob> & Pick<ModelJob, "modelId" | "model">): ModelJob {
  return {
    jobId: `job-${patch.modelId}`,
    action: "start",
    status: "running",
    script: "start.sh",
    dir: null,
    source: "manual",
    startedAt: 0,
    finishedAt: null,
    exitCode: null,
    signal: null,
    error: null,
    timedOut: false,
    totalChars: 0,
    truncated: false,
    killed: false,
    ...patch,
  };
}

function snapshot(models: ModelInfo[], activeJobs: ModelJob[]): ModelsSnapshot {
  return {
    models,
    activeJobs,
    scheduler: { enabled: false, window: null, activeModelId: null, override: null, nextBoundary: null, lastDecision: null },
  };
}

const buttons = (el: Element) => Array.from(el.querySelectorAll("button"));
const named = (root: Element, text: string) => buttons(root).find((b) => b.textContent?.trim() === text);

beforeEach(() => {
  startMock.mockReset();
});

afterEach(() => {
  cleanupRenders();
  closeModelTakeoverDialog();
  closeModelCommandDialog();
});

describe("ModelLauncherPanel concurrency", () => {
  it("shows every running cluster and locks only cards that share a claimed Spark", async () => {
    const tp2a = model({
      id: "tp2a",
      name: "TP2-A",
      nodes: ["spark1", "spark2"],
      nodeNames: ["spark-1", "spark-2"],
      status: UP,
    });
    const tp2b = model({
      id: "tp2b",
      name: "TP2-B",
      sparkId: "spark3",
      sparkName: "spark-3",
      nodes: ["spark3", "spark4"],
      nodeNames: ["spark-3", "spark-4"],
      status: UP,
    });
    const solo = model({ id: "solo", name: "Solo", sparkId: "spark2", sparkName: "spark-2" });
    // TP2-A is mid-start (job in flight claims spark1+spark2).
    const job = mutatingJob({ modelId: "tp2a", model: "TP2-A", nodes: ["spark1", "spark2"] });
    const { container } = render(
      <ModelLauncherPanel models={snapshot([tp2a, tp2b, solo], [job])} connected />
    );
    await flush();

    // Both running clusters read as running — nothing hides behind "the one
    // running model": the active-job chip, two Stop toggles and per-card
    // occupancy chips naming the cluster size.
    expect(container.textContent).toContain("start TP2-A"); // active-job chip
    const cards = Array.from(container.querySelectorAll("article"));
    expect(cards).toHaveLength(3);
    expect(named(cards[0], "Stop")).toBeTruthy(); // TP2-A up → Stop
    expect(named(cards[1], "Stop")).toBeTruthy(); // TP2-B up → Stop as well
    expect(named(cards[2], "Start")).toBeTruthy(); // Solo down → Start
    expect(cards[0].textContent).toContain("2 Sparks"); // spark1 + spark2
    expect(cards[1].textContent).toContain("2 Sparks"); // spark3 + spark4
    expect(cards[2].textContent).not.toContain("Sparks"); // solo occupies one

    // Restart gating follows the claim: disjoint units stay operable while a
    // cluster boots, overlapping ones lock behind it.
    expect(named(cards[1], "Restart")!.disabled).toBe(false);
    expect(named(cards[2], "Restart")!.disabled).toBe(true);
  });
});

describe("ModelLauncherPanel active-only list", () => {
  it("lists running and starting models; the disclosure reveals the idle ones", async () => {
    const runner = model({ id: "runner", name: "Runner", status: UP });
    // Booter is mid-start: status.running has not flipped yet — only the job
    // references it, and it must still be on screen.
    const booter = model({
      id: "booter",
      name: "Booter",
      sparkId: "spark5",
      sparkName: "spark-5",
      nodes: ["spark5"],
      nodeNames: ["spark-5"],
    });
    const resting = model({
      id: "resting",
      name: "Resting",
      sparkId: "spark6",
      sparkName: "spark-6",
      nodes: ["spark6"],
      nodeNames: ["spark-6"],
    });
    const dormant = model({
      id: "dormant",
      name: "Dormant",
      sparkId: "spark7",
      sparkName: "spark-7",
      nodes: ["spark7"],
      nodeNames: ["spark-7"],
    });
    const job = mutatingJob({ modelId: "booter", model: "Booter", nodes: ["spark5"] });
    const { container } = render(
      <ModelLauncherPanel models={snapshot([runner, booter, resting, dormant], [job])} connected />
    );
    await flush();

    // The card owns the full width of the integration grid's 2nd row.
    expect(container.querySelector(".ov-models")?.className).toContain("sm:col-span-2");

    // Two cards per row from `sm` up (stacked on phones), and the panel is
    // content-driven tall — the list carries no min-height floor any more.
    const grid = container.querySelector(".model-list-compact")!;
    expect(grid.className).toContain("grid-cols-1");
    expect(grid.className).toContain("sm:grid-cols-2");
    expect(grid.parentElement?.className).not.toContain("min-h-");

    // Collapsed by default: the two active clusters only.
    expect(container.querySelectorAll("article")).toHaveLength(2);
    expect(container.textContent).toContain("Runner");
    expect(container.textContent).toContain("Booter");
    expect(container.textContent).not.toContain("Resting");
    expect(container.textContent).not.toContain("Dormant");

    await act(async () => {
      named(container, "Show inactive models (2)")!.click();
    });
    await flush();

    // Expanded: the whole registry again, so ↑/↓ still cover every slot.
    expect(container.querySelectorAll("article")).toHaveLength(4);
    expect(container.textContent).toContain("Resting");
    expect(container.textContent).toContain("Dormant");
    expect(named(container, "Hide inactive models (2)")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the list reachable with nothing running", async () => {
    const alpha = model({ id: "alpha", name: "Alpha", nodes: ["spark1"], nodeNames: ["spark-1"] });
    const beta = model({ id: "beta", name: "Beta", nodes: ["spark2"], nodeNames: ["spark-2"] });
    const { container } = render(<ModelLauncherPanel models={snapshot([alpha, beta], [])} connected />);
    await flush();

    expect(container.querySelectorAll("article")).toHaveLength(0);
    expect(container.textContent).toContain("No models running — 2 registered");
    expect(container.textContent).not.toContain("Alpha");

    await act(async () => {
      named(container, "Show inactive models (2)")!.click();
    });
    await flush();

    expect(container.querySelectorAll("article")).toHaveLength(2);
    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).toContain("Beta");
  });
});

describe("ModelCard takeover choice", () => {
  it("a start refused for takeover asks the operator — Cancel runs nothing, Confirm re-posts", async () => {
    const tp2a = model({
      id: "tp2a",
      name: "TP2-A",
      nodes: ["spark1", "spark2"],
      nodeNames: ["spark-1", "spark-2"],
      status: UP,
    });
    const tp2b = model({
      id: "tp2b",
      name: "TP2-B",
      nodes: ["spark1", "spark2"],
      nodeNames: ["spark-1", "spark-2"],
    });
    startMock
      .mockRejectedValueOnce(
        new ModelTakeoverRequired(
          "Starting TP2-B must first stop TP2-A (spark-1, spark-2) — they hold Sparks the target needs.",
          [{ id: "tp2a", name: "TP2-A", sparks: ["spark1", "spark2"], sparkNames: ["spark-1", "spark-2"] }]
        )
      )
      .mockRejectedValueOnce(
        new ModelTakeoverRequired(
          "Starting TP2-B must first stop TP2-A (spark-1, spark-2) — they hold Sparks the target needs.",
          [{ id: "tp2a", name: "TP2-A", sparks: ["spark1", "spark2"], sparkNames: ["spark-1", "spark-2"] }]
        )
      )
      .mockResolvedValueOnce({ jobId: "job-takeover", status: "running", stopping: ["tp2a"] });

    const { container } = render(
      <>
        <ModelLauncherPanel models={snapshot([tp2a, tp2b], [])} connected />
        <ModelTakeoverDialog />
      </>
    );
    await flush();

    // TP2-B is idle, so the collapsed list hides it — the takeover has to
    // reach a card that is not running, so open the disclosure first.
    await act(async () => {
      named(container, "Show inactive models (1)")!.click();
    });
    await flush();

    const tp2bCard = Array.from(container.querySelectorAll("article"))[1];
    await act(async () => {
      named(tp2bCard, "Start")!.click();
    });
    await flush();

    // The dialog names who dies and where — before anything ran.
    expect(document.body.textContent).toContain("Start TP2-B?");
    expect(document.body.textContent).toContain("TP2-A");
    expect(document.body.textContent).toContain("spark-2");
    expect(startMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      named(document.body, "Cancel — run nothing")!.click();
    });
    await flush();
    expect(document.body.textContent).not.toContain("Start TP2-B?");
    expect(startMock).toHaveBeenCalledTimes(1); // cancel must not re-post the start

    // Second attempt: asked again — confirm re-posts with the takeover flag.
    await act(async () => {
      named(tp2bCard, "Start")!.click();
    });
    await flush();
    expect(startMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      named(document.body, "Stop 1 model and start")!.click();
    });
    await flush();
    expect(startMock).toHaveBeenCalledTimes(3);
    expect(startMock).toHaveBeenLastCalledWith("tp2b", { confirmTakeover: true });
  });
});
