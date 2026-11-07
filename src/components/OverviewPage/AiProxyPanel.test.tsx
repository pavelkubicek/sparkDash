import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanupRenders, flush, render } from "../../testing/render";
import { AiProxyPanel } from "./AiProxyPanel";
import type {
  AiProxyActiveRequest,
  AiProxyQueue,
  AiProxyQueueWaiter,
  AiProxyStats,
  AiProxyStream,
} from "../../api/types";

vi.mock("../../api/client", () => ({
  fetchAiProxyStreams: vi.fn(),
  fetchAiProxyActiveRequests: vi.fn(),
  fetchAiProxyStats: vi.fn(),
  fetchAiProxyQueue: vi.fn(),
  fetchAiProxyObserverUrl: vi.fn(),
  killAiProxyStream: vi.fn(),
  killAiProxyRequest: vi.fn(),
}));

import {
  fetchAiProxyActiveRequests,
  fetchAiProxyObserverUrl,
  fetchAiProxyQueue,
  fetchAiProxyStats,
  fetchAiProxyStreams,
} from "../../api/client";

const streamsMock = vi.mocked(fetchAiProxyStreams);
const requestsMock = vi.mocked(fetchAiProxyActiveRequests);
const statsMock = vi.mocked(fetchAiProxyStats);
const queueMock = vi.mocked(fetchAiProxyQueue);

/** Must mirror POLL_MS in the panel. */
const POLL_MS = 5000;

function stream(id: string, model: string): AiProxyStream {
  return {
    id,
    startTime: Date.now(),
    method: "POST",
    url: "/v1/chat/completions",
    model,
    targetPort: 8000,
    chunksReceived: 12,
    textLength: 120,
  };
}

function activeRequest(id: string, model: string): AiProxyActiveRequest {
  return {
    id,
    startTime: Date.now(),
    method: "POST",
    url: "/v1/chat/completions",
    model,
    targetPort: 8001,
  };
}

function waiter(id: string, model: string): AiProxyQueueWaiter {
  return { id, model, backendName: "backend-a", waitedMs: 4200, tier: 1 };
}

function queue(waiters: AiProxyQueueWaiter[]): AiProxyQueue {
  return { enabled: true, maxWaitSec: 120, waiting: waiters.length, waiters };
}

const statsFixture: AiProxyStats = {
  totals: {
    request_count: 7,
    input_tokens: 1000,
    output_tokens: 500,
    total_tokens: 1500,
    cached_tokens: 250,
  },
  byModel: [],
  daily: [],
};

/** Healthy endpoints; individual tests override the ones they care about. */
function healthyEndpoints() {
  streamsMock.mockResolvedValue([]);
  requestsMock.mockResolvedValue([]);
  statsMock.mockResolvedValue(statsFixture);
  queueMock.mockResolvedValue(queue([]));
  vi.mocked(fetchAiProxyObserverUrl).mockResolvedValue({ url: "http://observer.local" });
}

/** Advance the fake clock one full poll cycle and settle the poll's promise chain. */
async function advancePoll() {
  await act(async () => {
    vi.advanceTimersByTime(POLL_MS);
    await Promise.resolve();
    await Promise.resolve();
  });
  await flush();
}

afterEach(() => {
  cleanupRenders();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("AiProxyPanel queue rows", () => {
  it("renders a request present in both the queue snapshot and streams once, under Running", async () => {
    vi.useFakeTimers();
    streamsMock.mockResolvedValue([stream("req-1", "model-live")]);
    requestsMock.mockResolvedValue([activeRequest("req-9", "model-nonstream")]);
    statsMock.mockResolvedValue(statsFixture);
    // The queue snapshot still carries req-1 (it was admitted since that
    // snapshot); running wins, so only req-2 may show as queued.
    queueMock.mockResolvedValue(queue([waiter("req-1", "model-live"), waiter("req-2", "model-waiting")]));
    vi.mocked(fetchAiProxyObserverUrl).mockResolvedValue({ url: "http://observer.local" });

    const { container } = render(<AiProxyPanel />);
    await flush();

    expect(container.textContent).toContain("Queued (1)");
    expect(container.textContent).not.toContain("Queued (2)");
    expect(container.textContent).toContain("Running requests (2)");
    expect(container.textContent).toContain("model-waiting");
    // The deduped model appears exactly once in rendered text — the running
    // row — never as a duplicate queued row.
    expect((container.textContent ?? "").split("model-live").length - 1).toBe(1);
  });

  it("keeps the last queue frame but marks the header stale when only the queue endpoint fails", async () => {
    vi.useFakeTimers();
    healthyEndpoints();
    streamsMock.mockResolvedValue([stream("req-1", "model-live")]);
    queueMock.mockResolvedValue(queue([waiter("req-2", "model-waiting")]));

    const { container } = render(<AiProxyPanel />);
    await flush();
    expect(container.textContent).toContain("Queued (1)");
    expect(container.textContent).not.toContain("stale");

    // Queue endpoint drops out; streams/requests/stats keep succeeding.
    queueMock.mockRejectedValue(new Error("queue endpoint down"));
    await advancePoll();

    // Hold-last-frame: the rows stay…
    expect(container.textContent).toContain("Queued (1)");
    expect(container.textContent).toContain("model-waiting");
    // …but the header says the snapshot may no longer be current.
    expect(container.textContent).toContain("· stale");
    const staleMark = Array.from(container.querySelectorAll("span[title]")).find((el) =>
      el.textContent?.includes("stale")
    );
    expect(staleMark?.getAttribute("title")).toMatch(/queue endpoint is unreachable/i);
  });

  it("shows no stale marker while every endpoint including the queue polls healthy", async () => {
    vi.useFakeTimers();
    healthyEndpoints();
    queueMock.mockResolvedValue(queue([waiter("req-2", "model-waiting")]));

    const { container } = render(<AiProxyPanel />);
    await flush();
    await advancePoll();
    await advancePoll();

    expect(container.textContent).toContain("Queued (1)");
    expect(container.textContent).toContain("model-waiting");
    expect(container.textContent).not.toContain("stale");
  });

  it("hides the whole Queued section when every waiter is also running, even while stale", async () => {
    vi.useFakeTimers();
    streamsMock.mockResolvedValue([stream("req-1", "model-live")]);
    requestsMock.mockResolvedValue([activeRequest("req-9", "model-nonstream")]);
    statsMock.mockResolvedValue(statsFixture);
    // Both waiters' ids are the running ids — running wins for every row.
    queueMock.mockResolvedValue(queue([waiter("req-1", "model-live"), waiter("req-9", "model-nonstream")]));
    vi.mocked(fetchAiProxyObserverUrl).mockResolvedValue({ url: "http://observer.local" });

    const { container } = render(<AiProxyPanel />);
    await flush();

    // Let the queue snapshot go stale too — with zero surviving waiters the
    // section (header, rows, stale marker) must not render at all.
    queueMock.mockRejectedValue(new Error("queue endpoint down"));
    await advancePoll();

    expect(container.textContent).not.toContain("Queued");
    expect(container.textContent).not.toContain("stale");
    expect(container.textContent).toContain("Running requests (2)");
    expect(container.textContent).toContain("model-live");
    expect(container.textContent).toContain("model-nonstream");
  });

  it("clears the stale marker once the queue endpoint recovers", async () => {
    vi.useFakeTimers();
    healthyEndpoints();
    queueMock.mockResolvedValue(queue([waiter("req-2", "model-waiting")]));

    const { container } = render(<AiProxyPanel />);
    await flush();
    expect(container.textContent).not.toContain("stale");

    // One cycle with the queue endpoint down → marker appears…
    queueMock.mockRejectedValueOnce(new Error("queue endpoint down"));
    await advancePoll();
    expect(container.textContent).toContain("· stale");

    // …and the next healthy cycle clears it, rows still current.
    await advancePoll();
    expect(container.textContent).not.toContain("stale");
    expect(container.textContent).toContain("Queued (1)");
    expect(container.textContent).toContain("model-waiting");
  });
});
