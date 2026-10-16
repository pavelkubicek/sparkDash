import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";

const api = vi.hoisted(() => ({ fetchReaView: vi.fn(), downloadReaExport: vi.fn() }));
vi.mock("../../api/client", async (orig) => ({ ...(await orig<typeof import("../../api/client")>()), ...api }));

import { ReaApiError, type ReaResultSummary } from "../../api/types";
import { WF_STATIC, WF_TWO, runData } from "./fixtures";
import { ResultPanel } from "./ResultView";

const summary = (over: Partial<ReaResultSummary> = {}): ReaResultSummary => ({
  kind: "javascript-app",
  headline: { modules: 120, name: "demo" },
  tables: [{ id: "modules", label: "Modules", total: 120, columns: ["name", "size"] }],
  findings: [],
  limitations: ["Dynamic requires are not resolved."],
  unknowns: ["Packed bundle"],
  identity: { sha256: "ab".repeat(32), format: "asar" },
  truncated: false,
  ...over,
});

const state = (s: ReaResultSummary | null) => ({ loading: false, error: null, run: runData(), summary: s });
const click = (el: Element | null | undefined) => act(() => (el as HTMLElement).click());
const btn = (c: HTMLElement, re: RegExp) => Array.from(c.querySelectorAll("button")).find((b) => re.test(b.textContent ?? ""));

beforeEach(() => {
  api.fetchReaView.mockReset();
  api.downloadReaExport.mockReset();
});

describe("ResultPanel", () => {
  it("shows headline, identity, limitations and unknowns", async () => {
    api.fetchReaView.mockResolvedValue({ view: { items: [] } });
    const { container } = render(<ResultPanel sparkId="s1" state={state(summary())} run={runData()} workflow={WF_STATIC} onClose={vi.fn()} />);
    await flush();
    const t = container.textContent ?? "";
    expect(t).toContain("modules");
    expect(t).toContain("120");
    expect(t).toContain("Limitations");
    expect(t).toContain("Dynamic requires are not resolved.");
    expect(t).toContain("Packed bundle");
    expect(t).toContain("asar");
  });

  it("pages tables with the chosen page size and never asks for more", async () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `m${i}`, size: i }));
    api.fetchReaView.mockResolvedValue({ view: { total: 120, items: rows(25) } });
    const { container } = render(<ResultPanel sparkId="s1" state={state(summary())} run={runData()} workflow={WF_STATIC} onClose={vi.fn()} />);
    await flush();
    expect(api.fetchReaView).toHaveBeenLastCalledWith("s1", runData().id, { collection: "modules", offset: 0, limit: 25 });
    expect(container.textContent).toContain("of 120");
    await act(async () => click(btn(container, /^Next$/)));
    await flush();
    expect(api.fetchReaView).toHaveBeenLastCalledWith("s1", runData().id, { collection: "modules", offset: 25, limit: 25 });
    const size = container.querySelector<HTMLSelectElement>("select[id$='-size']")!;
    await act(async () => {
      size.value = "10";
      size.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(api.fetchReaView).toHaveBeenLastCalledWith("s1", runData().id, { collection: "modules", offset: 0, limit: 10 });
    expect(Math.max(...api.fetchReaView.mock.calls.map((c) => c[2].limit))).toBeLessThanOrEqual(100);
  });

  it("handles a 400 not viewable answer", async () => {
    api.fetchReaView.mockRejectedValue(new ReaApiError("This workflow's result has no paged view", 400));
    const { container } = render(<ResultPanel sparkId="s1" state={state(summary())} run={runData()} workflow={WF_STATIC} onClose={vi.fn()} />);
    await flush();
    expect(container.textContent).toContain("No paged view for this result");
  });

  it("shows only the summary for non-viewable workflows and never calls the view endpoint", async () => {
    const { container } = render(<ResultPanel sparkId="s1" state={state(summary({ tables: [] }))} run={runData({ workflowId: WF_TWO.id })} workflow={WF_TWO} onClose={vi.fn()} />);
    await flush();
    expect(api.fetchReaView).not.toHaveBeenCalled();
    expect(container.textContent).toContain("no paged view");
    expect(container.textContent).toContain("Raw summary");
  });

  it("notes a truncated result and exports through the client", async () => {
    api.fetchReaView.mockResolvedValue({ view: {} });
    api.downloadReaExport.mockResolvedValue(undefined);
    const { container } = render(<ResultPanel sparkId="s1" state={state(summary({ truncated: true }))} run={runData()} workflow={WF_STATIC} onClose={vi.fn()} />);
    await flush();
    expect(container.textContent).toContain("too large to keep in full");
    await act(async () => click(btn(container, /Export JSON/)));
    expect(api.downloadReaExport).toHaveBeenCalledWith("s1", runData().id);
  });

  it("renders hostile strings as plain text", async () => {
    api.fetchReaView.mockResolvedValue({ view: { items: [{ name: "<img src=x onerror=alert(1)>", size: 1 }] } });
    const evil = "<img src=x onerror=alert(1)>";
    const s = summary({
      headline: { name: evil },
      limitations: [evil],
      findings: [{ severity: "high", title: evil, detail: "<script>alert(2)</script>" }],
    });
    const { container } = render(<ResultPanel sparkId="s1" state={state(s)} run={runData({ label: evil })} workflow={WF_STATIC} onClose={vi.fn()} />);
    await flush();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain(evil);
    expect(container.textContent).toContain("<script>alert(2)</script>");
  });
});
