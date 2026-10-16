import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { VulnHuntRun } from "../../api/types";
import { render } from "../../testing/render";
import type { Followed } from "./hooks";
import { LiveScan } from "./LiveScan";

const run = (over: Partial<VulnHuntRun> = {}): VulnHuntRun => ({
  id: "vh-20261012-000000-abcd",
  sparkId: "s1",
  status: "running",
  startedAt: Date.now() - 5000,
  finishedAt: null,
  exitCode: null,
  note: null,
  label: "",
  source: { type: "url", value: "https://github.com/org/repo" },
  readOnly: true,
  timeoutMinutes: 240,
  command: "x",
  runDir: "~/.cache/sparkdash/vulnhunt/x",
  resultCached: false,
  summary: null,
  ...over,
});

const followed = (r: VulnHuntRun): Followed => ({ run: r, job: null, lines: [], partial: "", stage: "hunt", noLive: false });

function setup(onStop: () => Promise<boolean>, r = run()) {
  const props = {
    followed: followed(r),
    polling: true,
    pollError: null,
    onStop,
    onStopWatching: vi.fn(),
    onWatch: vi.fn(),
    onRefresh: vi.fn(),
    onDismiss: vi.fn(),
    onViewReport: vi.fn(),
  };
  const view = render(<LiveScan {...props} />);
  const btn = (text: string) => Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent?.trim() === text) as HTMLButtonElement | undefined;
  return { ...view, btn };
}

describe("LiveScan", () => {
  it("says read-only was requested, not guaranteed", () => {
    const { container } = setup(async () => true);
    expect(container.textContent).toContain("read-only requested");
    expect(container.textContent).not.toMatch(/·\s*read-only\s*·/);
  });

  it("does not wedge the stop confirmation when the stop fails: the scan is still running and Stop can be tried again", async () => {
    const onStop = vi.fn().mockResolvedValue(false);
    const { btn } = setup(onStop);
    act(() => btn("Stop")!.click());
    expect(btn("Yes, stop it")).toBeTruthy();
    await act(async () => btn("Yes, stop it")!.click());
    expect(onStop).toHaveBeenCalledTimes(1);
    // Back to the normal controls, enabled.
    expect(btn("Stopping…")).toBeUndefined();
    const again = btn("Stop")!;
    expect(again).toBeTruthy();
    expect(again.disabled).toBe(false);
    act(() => again.click());
    expect(btn("Yes, stop it")!.disabled).toBe(false);
    expect(btn("Keep running")!.disabled).toBe(false);
  });

  it("also recovers when the stop request itself throws", async () => {
    const onStop = vi.fn().mockRejectedValue(new Error("boom"));
    const { btn } = setup(onStop);
    act(() => btn("Stop")!.click());
    await act(async () => btn("Yes, stop it")!.click());
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(btn("Stopping…")).toBeUndefined();
    expect(btn("Stop")!.disabled).toBe(false);
  });
});
