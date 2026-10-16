import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";

const api = vi.hoisted(() => ({ compareReaRuns: vi.fn() }));
vi.mock("../../api/client", async (orig) => ({ ...(await orig<typeof import("../../api/client")>()), ...api }));

import { History } from "./History";
import { runData } from "./fixtures";

const click = (el: Element | null | undefined) => act(() => (el as HTMLElement).click());
const btns = (c: HTMLElement, re: RegExp) => Array.from(c.querySelectorAll("button")).filter((b) => re.test(b.textContent ?? ""));

function mount(runs = [runData({ id: "rea-20261012-000000-aaaa" }), runData({ id: "rea-20261012-000001-bbbb" })], over: Partial<React.ComponentProps<typeof History>> = {}) {
  const props = {
    sparkId: "s1",
    runs,
    error: null,
    followedId: null,
    viewedId: null,
    onReload: vi.fn(),
    onOpen: vi.fn(),
    onRunAgain: vi.fn(),
    onWatch: vi.fn(),
    onRefresh: vi.fn(),
    onDelete: vi.fn().mockResolvedValue({ ok: true, canForce: false }),
    ...over,
  };
  return { ...render(<History {...props} />), props };
}

beforeEach(() => {
  // Braces matter: returning the mock would make the runner call it as a cleanup hook.
  api.compareReaRuns.mockReset();
});

describe("History", () => {
  it("opens and runs again from a row", () => {
    const m = mount();
    click(btns(m.container, /^Open$/)[1]);
    expect(m.props.onOpen).toHaveBeenCalledWith(m.props.runs![1]);
    click(btns(m.container, /^Run again$/)[0]);
    expect(m.props.onRunAgain).toHaveBeenCalledWith(m.props.runs![0]);
  });

  it("turns a 409 canForce into a forced delete", async () => {
    const onDelete = vi.fn().mockResolvedValueOnce({ ok: false, canForce: true }).mockResolvedValueOnce({ ok: true, canForce: false });
    const m = mount(undefined, { onDelete });
    click(btns(m.container, /^Delete$/)[0]);
    await act(async () => click(btns(m.container, /^Delete$/)[0]));
    expect(onDelete).toHaveBeenLastCalledWith(m.props.runs![0], false);
    expect(m.container.textContent).toContain("Could not confirm the run ended");
    await act(async () => click(btns(m.container, /Delete anyway/)[0]));
    expect(onDelete).toHaveBeenLastCalledWith(m.props.runs![0], true);
  });

  it("compares two finished runs of the same workflow and shows the result as plain text", async () => {
    api.compareReaRuns.mockResolvedValue({ result: { added: ["<b>x</b>"] } });
    const m = mount();
    const compare = btns(m.container, /Compare selected/)[0] as HTMLButtonElement;
    expect(compare.disabled).toBe(true);
    const boxes = Array.from(m.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    click(boxes[0]);
    click(boxes[1]);
    expect(compare.disabled).toBe(false);
    await act(async () => compare.click());
    await flush();
    expect(api.compareReaRuns).toHaveBeenCalledWith("s1", "rea-20261012-000000-aaaa", "rea-20261012-000001-bbbb");
    expect(m.container.textContent).toContain("<b>x</b>");
    expect(m.container.querySelector("pre b")).toBeNull();
  });

  it("shows the server's message plainly when the comparison fails", async () => {
    api.compareReaRuns.mockRejectedValue(new Error("Both runs must have finished and have a stored result."));
    const m = mount();
    const boxes = Array.from(m.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    click(boxes[0]);
    click(boxes[1]);
    await act(async () => (btns(m.container, /Compare selected/)[0] as HTMLButtonElement).click());
    await flush();
    expect(m.container.textContent).toContain("Could not compare");
    expect(m.container.textContent).toContain("Both runs must have finished and have a stored result.");
  });

  it("will not compare runs of different workflows", () => {
    const m = mount([runData({ id: "rea-20261012-000000-aaaa" }), runData({ id: "rea-20261012-000001-bbbb", workflowId: "other" })]);
    const boxes = Array.from(m.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    click(boxes[0]);
    click(boxes[1]);
    expect((btns(m.container, /Compare selected/)[0] as HTMLButtonElement).disabled).toBe(true);
    expect(m.container.textContent).toContain("same workflow");
  });

  it("offers Watch and Refresh for a live run", () => {
    const m = mount([runData({ status: "running", finishedAt: null })]);
    click(btns(m.container, /^Watch$/)[0]);
    click(btns(m.container, /^Refresh$/)[0]);
    expect(m.props.onWatch).toHaveBeenCalled();
    expect(m.props.onRefresh).toHaveBeenCalled();
  });
});
