import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogConsole } from "./LogConsole";
import { fetchModelJob } from "../../../api/modelClient";
import type { ModelJob } from "../../../api/modelTypes";
import { render, cleanupRenders } from "../../../testing/render";

vi.mock("../../../api/modelClient", () => ({
  fetchModelJob: vi.fn(),
  deleteModelJob: vi.fn(),
}));

const fetchMock = vi.mocked(fetchModelJob);

function job(patch: Record<string, unknown> = {}): ModelJob {
  return {
    jobId: "job-1",
    modelId: "glm",
    model: "GLM",
    action: "logs",
    status: "running",
    script: "docker logs -f glm53-flash-tf",
    dir: null,
    source: "manual",
    startedAt: 0,
    finishedAt: null,
    exitCode: null,
    signal: null,
    error: null,
    timedOut: false,
    totalChars: 5,
    truncated: false,
    killed: false,
    ...patch,
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  cleanupRenders();
  vi.useRealTimers();
});

describe("LogConsole resilience", () => {
  it("keeps polling through a transient failure instead of freezing on stale text", async () => {
    fetchMock
      .mockResolvedValueOnce({ ...job(), append: "boot line\n", since: 10 })
      .mockRejectedValueOnce(Object.assign(new Error("HTTP 502"), { status: 502 }))
      .mockResolvedValue({ ...job(), append: " more\n", since: 16 });

    render(<LogConsole jobId="job-1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(document.body.textContent).toContain("boot line");

    // The 502 lands → an error note shows, but the poll resumes after the retry delay.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(document.body.textContent).toContain("more");
    // The poll resumed after the 502 and kept firing at the normal cadence.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    // The retry passed the new cursor, not a full rebuild.
    expect(fetchMock).toHaveBeenLastCalledWith("job-1", 16);
  });

  it("stops polling on 404 — the record is unrecoverable", async () => {
    fetchMock
      .mockResolvedValueOnce({ ...job(), append: "x\n", since: 2 })
      .mockRejectedValue(Object.assign(new Error("Model job not found"), { status: 404 }));

    render(<LogConsole jobId="job-1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toContain("Model job not found");
  });
});

describe("LogConsole tail health footer", () => {
  it("shows attached for a live tail and detached when the process is gone", async () => {
    fetchMock.mockResolvedValue({ ...job(), alive: true, lastOutputAt: 999_000, append: "a\n" });
    render(<LogConsole jobId="job-1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(document.body.textContent).toContain("attached");

    fetchMock.mockResolvedValue({ ...job(), alive: false, lastOutputAt: 999_000, append: "a\n" });
    render(<LogConsole jobId="job-2" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(document.body.textContent).toContain("detached");
  });

  it("marks a healthy tail quiet after a minute without output", async () => {
    fetchMock.mockResolvedValue({
      ...job(),
      alive: true,
      lastOutputAt: 1_000_000 - 120_000, // two minutes of silence
      append: "last startup banner\n",
    });
    render(<LogConsole jobId="job-1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(document.body.textContent).toContain("quiet 2m 0s");
  });

  it("never marks a finished job quiet or detached", async () => {
    fetchMock.mockResolvedValue({
      ...job({ status: "done", exitCode: 0 }),
      alive: false,
      lastOutputAt: 1_000_000 - 500_000,
      append: "done\n",
    });
    render(<LogConsole jobId="job-1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(document.body.textContent).not.toContain("detached");
    expect(document.body.textContent).not.toContain("quiet");
  });
});
