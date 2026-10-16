import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { VulnHuntRun } from "../../api/types";
import { render } from "../../testing/render";
import { History } from "./History";
import { recentSources } from "./securityLogic";

const run = (id: string, value: string, startedAt: number): VulnHuntRun =>
  ({
    id,
    sparkId: "s1",
    status: "completed",
    source: { type: value.startsWith("http") ? "url" : "path", value },
    label: "",
    readOnly: true,
    startedAt,
    finishedAt: startedAt + 1000,
    resultCached: false,
    summary: null,
    note: null,
  }) as unknown as VulnHuntRun;

describe("History scan again", () => {
  it("prefills the same source from a row", () => {
    const onScanAgain = vi.fn();
    const runs = [run("a", "https://github.com/org/a", 2), run("b", "~/code/b", 1)];
    const { container } = render(
      <History runs={runs} error={null} followedId={null} viewedId={null} onReload={vi.fn()} onOpen={vi.fn()} onScanAgain={onScanAgain} onWatch={vi.fn()} onRefresh={vi.fn()} onDelete={vi.fn()} />
    );
    const buttons = Array.from(container.querySelectorAll("button")).filter((b) => b.textContent === "Scan again");
    expect(buttons).toHaveLength(2);
    act(() => buttons[1].click());
    expect(onScanAgain).toHaveBeenCalledWith(runs[1]);
  });
});

describe("recentSources", () => {
  it("is distinct, newest first and capped at five", () => {
    const runs = [
      run("1", "https://x/a", 1),
      run("2", "https://x/b", 7),
      run("3", "https://x/a", 6),
      run("4", "~/c", 5),
      run("5", "~/d", 4),
      run("6", "~/e", 3),
      run("7", "~/f", 2),
    ];
    expect(recentSources(runs)).toEqual(["https://x/b", "https://x/a", "~/c", "~/d", "~/e"]);
    expect(recentSources(null)).toEqual([]);
  });
});
