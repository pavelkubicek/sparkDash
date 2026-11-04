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
