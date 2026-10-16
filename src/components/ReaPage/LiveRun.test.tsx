import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { runData } from "./fixtures";
import type { Followed } from "./hooks";
import { LiveRun } from "./LiveRun";

const followed = (over: Partial<Followed["run"]> = {}): Followed => ({
  run: runData({ status: "running", finishedAt: null, startedAt: Date.now() - 5000, ...over }),
  job: null,
  lines: [{ seq: 1, text: "<img src=x onerror=alert(1)>" }],
  partial: "",
  stage: "analysis",
  noLive: false,
});

function setup(onStop: () => Promise<boolean>, polling = true) {
  const props = { onStop, onStopWatching: vi.fn(), onWatch: vi.fn(), onRefresh: vi.fn(), onDismiss: vi.fn(), onViewResult: vi.fn() };
  const view = render(<LiveRun followed={followed()} polling={polling} pollError={null} {...props} />);
  const btn = (t: string) => Array.from(view.container.querySelectorAll("button")).find((b) => b.textContent?.trim() === t) as HTMLButtonElement | undefined;
  return { ...view, ...props, btn };
}

describe("LiveRun", () => {
  it("confirms before stopping and calls onStop; recovers when the stop fails", async () => {
    const onStop = vi.fn().mockResolvedValue(false);
    const s = setup(onStop);
    act(() => s.btn("Stop")!.click());
    await act(async () => s.btn("Yes, stop it")!.click());
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(s.btn("Stop")!.disabled).toBe(false);
  });

  it("offers Stop watching while watched, and Watch / Refresh when not watched", () => {
    const watched = setup(async () => true, true);
    act(() => watched.btn("Stop watching")!.click());
    expect(watched.onStopWatching).toHaveBeenCalled();
    const unwatched = setup(async () => true, false);
    expect(unwatched.container.textContent).toContain("Not watching this run");
    act(() => unwatched.btn("Watch")!.click());
    expect(unwatched.onWatch).toHaveBeenCalled();
    expect(unwatched.container.textContent).toMatch(/running for/);
  });

  it("shows the stage tag and the output as plain text", () => {
    const s = setup(async () => true);
    expect(s.container.textContent).toContain("Analysis");
    expect(s.container.querySelector("img")).toBeNull();
    expect(s.container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
