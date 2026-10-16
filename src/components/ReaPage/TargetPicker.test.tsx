import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flush, render } from "../../testing/render";

const api = vi.hoisted(() => ({
  createReaUpload: vi.fn(),
  putReaUploadFile: vi.fn(),
  commitReaUpload: vi.fn(),
  deleteReaUpload: vi.fn(),
}));
vi.mock("../../api/client", async (orig) => ({ ...(await orig<typeof import("../../api/client")>()), ...api }));

import type { ReaTarget } from "../../api/types";
import { TargetPicker } from "./TargetPicker";

const click = (el: Element | null | undefined) => act(() => (el as HTMLElement).click());
const setValue = (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const pick = (input: HTMLInputElement, files: File[]) => {
  Object.defineProperty(input, "files", { value: files, configurable: true });
  act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
};

function mount(limits = { maxBytes: 1000, maxFiles: 3 }) {
  const onChange = vi.fn<(t: ReaTarget | null) => void>();
  const view = render(
    <TargetPicker sparkId="s1" unitName="spark-1" label="Target" limits={limits} allowPath allowUpload value={null} onChange={onChange} />
  );
  const tab = (name: RegExp) => Array.from(view.container.querySelectorAll<HTMLElement>('[role="tab"]')).find((t) => name.test(t.textContent ?? ""))!;
  const btn = (re: RegExp) => Array.from(view.container.querySelectorAll("button")).find((b) => re.test(b.textContent ?? ""));
  return { ...view, onChange, tab, btn };
}

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.deleteReaUpload.mockResolvedValue({ success: true });
});

describe("TargetPicker", () => {
  it("validates a path on the unit and reports it as the target", () => {
    const m = mount();
    const input = m.container.querySelector<HTMLInputElement>('input[type="text"]')!;
    setValue(input, "relative/x");
    expect(m.container.textContent).toContain("Use an absolute path");
    expect(m.onChange).toHaveBeenLastCalledWith(null);
    setValue(input, "~/samples/app.asar");
    expect(m.onChange).toHaveBeenLastCalledWith({ kind: "path", value: "~/samples/app.asar" });
  });

  it("shows the limits and refuses an over-limit selection without sending anything", () => {
    const m = mount({ maxBytes: 1000, maxFiles: 2 });
    click(m.tab(/Upload/));
    expect(m.container.textContent).toContain("Up to 2 files and 1000 B");
    const files = ["a", "b", "c"].map((n) => new File(["x"], n));
    pick(m.container.querySelector<HTMLInputElement>('input[aria-label="Target: choose files"]')!, files);
    expect(m.container.textContent).toContain("This selection cannot be uploaded");
    expect(m.container.textContent).toContain("3 files; at most 2");
    expect(m.btn(/^Upload \d+ files/)).toBeUndefined();
    expect(api.createReaUpload).not.toHaveBeenCalled();
  });

  it("uploads with raw PUTs (relative path, archive flag), commits and reports the upload target", async () => {
    api.createReaUpload.mockResolvedValue({ uploadId: "up-20261012-000000-abcdef", maxBytes: 1000, maxFiles: 3 });
    api.putReaUploadFile.mockResolvedValue({ path: "x", bytes: 1, sha256: "" });
    api.commitReaUpload.mockResolvedValue({ uploadId: "up-20261012-000000-abcdef", root: "/home/u/.cache/up", files: 2, bytes: 4, extracted: true });
    const m = mount();
    click(m.tab(/Upload/));
    const a = new File(["abcd"], "pack.tar.gz");
    const b = new File(["x"], "notes.txt");
    pick(m.container.querySelector<HTMLInputElement>('input[aria-label="Target: choose files"]')!, [a, b]);
    await act(async () => click(m.btn(/Upload 2 files/)));
    await flush();
    await flush();
    expect(api.createReaUpload).toHaveBeenCalledWith("s1");
    expect(api.putReaUploadFile).toHaveBeenCalledTimes(2);
    const calls = api.putReaUploadFile.mock.calls;
    const byPath = Object.fromEntries(calls.map((c) => [c[2], c]));
    expect(byPath["pack.tar.gz"][0]).toBe("s1");
    expect(byPath["pack.tar.gz"][1]).toBe("up-20261012-000000-abcdef");
    expect(byPath["pack.tar.gz"][3]).toBe(a);
    expect(byPath["pack.tar.gz"][4]).toMatchObject({ archive: true });
    expect(byPath["notes.txt"][4]).toMatchObject({ archive: false });
    expect(api.commitReaUpload).toHaveBeenCalledWith("s1", "up-20261012-000000-abcdef");
    expect(m.onChange).toHaveBeenLastCalledWith({ kind: "upload", uploadId: "up-20261012-000000-abcdef" });
    expect(m.container.textContent).toContain("/home/u/.cache/up");
  });

  it("targets the single plain file inside the upload", async () => {
    api.createReaUpload.mockResolvedValue({ uploadId: "up-20261012-000000-abcdef", maxBytes: 1000, maxFiles: 3 });
    api.putReaUploadFile.mockResolvedValue({ path: "app.asar", bytes: 1, sha256: "" });
    api.commitReaUpload.mockResolvedValue({ uploadId: "up-20261012-000000-abcdef", root: "/r", files: 1, bytes: 1, extracted: false });
    const m = mount();
    click(m.tab(/Upload/));
    pick(m.container.querySelector<HTMLInputElement>('input[aria-label="Target: choose files"]')!, [new File(["x"], "app.asar")]);
    await act(async () => click(m.btn(/^Upload app\.asar/)));
    await flush();
    await flush();
    expect(m.onChange).toHaveBeenLastCalledWith({ kind: "upload", uploadId: "up-20261012-000000-abcdef", relPath: "app.asar" });
  });

  it("cancel aborts the transfer and deletes the upload", async () => {
    api.createReaUpload.mockResolvedValue({ uploadId: "up-20261012-000000-abcdef", maxBytes: 1000, maxFiles: 3 });
    let signal: AbortSignal | undefined;
    api.putReaUploadFile.mockImplementation(
      (_s: string, _u: string, _p: string, _f: File, o: { signal: AbortSignal }) =>
        new Promise((_res, rej) => {
          signal = o.signal;
          o.signal.addEventListener("abort", () => rej(new Error("Upload cancelled")));
        })
    );
    const m = mount();
    click(m.tab(/Upload/));
    pick(m.container.querySelector<HTMLInputElement>('input[aria-label="Target: choose files"]')!, [new File(["x"], "a.bin")]);
    await act(async () => click(m.btn(/^Upload a\.bin/)));
    await flush();
    await act(async () => click(m.btn(/Cancel upload/)));
    await flush();
    await flush();
    expect(signal?.aborted).toBe(true);
    expect(api.deleteReaUpload).toHaveBeenCalledWith("s1", "up-20261012-000000-abcdef");
    expect(api.commitReaUpload).not.toHaveBeenCalled();
    expect(m.container.textContent).not.toContain("The upload failed");
  });

  it("shows a failed file and the server's message", async () => {
    api.createReaUpload.mockResolvedValue({ uploadId: "up-20261012-000000-abcdef", maxBytes: 1000, maxFiles: 3 });
    api.putReaUploadFile.mockRejectedValue(new Error("upload exceeds the size cap"));
    const m = mount();
    click(m.tab(/Upload/));
    pick(m.container.querySelector<HTMLInputElement>('input[aria-label="Target: choose files"]')!, [new File(["x"], "a.bin")]);
    await act(async () => click(m.btn(/^Upload a\.bin/)));
    await flush();
    await flush();
    expect(m.container.textContent).toContain("The upload failed");
    expect(m.container.textContent).toContain("upload exceeds the size cap");
    expect(api.deleteReaUpload).toHaveBeenCalled();
  });
});
