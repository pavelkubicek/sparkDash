import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "../../testing/render";
import { ScanForm } from "./ScanForm";

function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const click = (el: Element) => act(() => (el as HTMLElement).click());

function setup(props: Partial<React.ComponentProps<typeof ScanForm>> = {}) {
  const onStart = vi.fn().mockResolvedValue(true);
  const view = render(<ScanForm unitName="spark-1" onStart={onStart} {...props} />);
  const q = <T extends Element>(sel: string) => view.container.querySelector<T>(sel)!;
  const byText = (text: string) =>
    Array.from(view.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((i) => i.closest("label")?.textContent?.includes(text))!;
  return {
    ...view,
    onStart,
    q,
    source: () => q<HTMLInputElement>('input[type="text"].sec-mono'),
    options: () => q<HTMLDetailsElement>("details.sec-options"),
    chips: () => Array.from(view.container.querySelectorAll<HTMLButtonElement>(".sec-recent__chip")),
    start: () => q<HTMLButtonElement>('button[type="submit"]'),
    readOnly: () => byText("Read-only scan ("),
    authorized: () => byText("I am authorized to scan this code"),
    execute: () => byText("Allow the scan to execute code on this unit"),
  };
}

describe("ScanForm", () => {
  it("keeps Start disabled until a source is entered and the authorization is ticked", () => {
    const f = setup();
    expect(f.start().disabled).toBe(true);
    setValue(f.source(), "https://github.com/org/repo");
    expect(f.start().disabled).toBe(true);
    click(f.authorized());
    expect(f.start().disabled).toBe(false);
    click(f.authorized());
    expect(f.start().disabled).toBe(true);
  });

  it("is read-only by default and shows the execution confirmation only when turned off", async () => {
    const f = setup();
    expect(f.readOnly().checked).toBe(true);
    expect(f.execute()).toBeUndefined();

    setValue(f.source(), "~/code/project");
    click(f.authorized());
    expect(f.start().disabled).toBe(false);

    click(f.readOnly());
    expect(f.readOnly().checked).toBe(false);
    expect(f.execute()).toBeDefined();
    expect(f.q(".sec-danger")).not.toBeNull();
    expect(f.start().disabled).toBe(true);

    click(f.execute());
    expect(f.start().disabled).toBe(false);

    await act(async () => {
      f.q<HTMLFormElement>("form").requestSubmit();
    });
    expect(f.onStart).toHaveBeenCalledTimes(1);
    expect(f.onStart).toHaveBeenCalledWith({
      source: { type: "path", value: "~/code/project" },
      readOnly: false,
      confirmExecute: true,
      authorized: true,
      timeoutMinutes: 240,
    });
  });

  it("sends a read-only request without confirmExecute and clears the attestations afterwards", async () => {
    const f = setup();
    setValue(f.source(), "https://github.com/org/repo");
    click(f.authorized());
    await act(async () => {
      f.q<HTMLFormElement>("form").requestSubmit();
    });
    expect(f.onStart).toHaveBeenCalledWith({
      source: { type: "url", value: "https://github.com/org/repo" },
      readOnly: true,
      authorized: true,
      timeoutMinutes: 240,
    });
    expect(f.authorized().checked).toBe(false);
    expect(f.start().disabled).toBe(true);
  });

  it("detects a URL or a path from what is typed", async () => {
    const f = setup();
    expect(f.source().placeholder).toContain("https://github.com/org/repo");
    expect(f.container.querySelector(".sec-seg")).toBeNull();
    click(f.authorized());
    for (const [value, type] of [
      ["https://github.com/org/repo", "url"],
      ["/srv/code/app", "path"],
      ["~/code/project", "path"],
    ] as const) {
      setValue(f.source(), value);
      await act(async () => {
        f.q<HTMLFormElement>("form").requestSubmit();
      });
      expect(f.onStart).toHaveBeenLastCalledWith(expect.objectContaining({ source: { type, value } }));
      click(f.authorized()); // re-attest after each start
    }
  });

  it("posts only source, readOnly and authorized on the default path, without opening Options", async () => {
    const f = setup({ limits: { defaultTimeoutMinutes: 60, minTimeoutMinutes: 5, maxTimeoutMinutes: 720 } });
    expect(f.options().open).toBe(false);
    setValue(f.source(), "https://github.com/org/repo");
    click(f.authorized());
    expect(f.start().textContent).toBe("Scan");
    await act(async () => {
      f.start().click();
    });
    expect(f.onStart).toHaveBeenCalledWith({
      source: { type: "url", value: "https://github.com/org/repo" },
      readOnly: true,
      authorized: true,
      timeoutMinutes: 60,
    });
    expect(f.options().open).toBe(false);
  });

  it("keeps label, time limit, read-only and the execute confirmation under Options", () => {
    const f = setup();
    const opts = f.options();
    expect(opts.querySelector("summary")!.textContent).toBe("Options");
    expect(opts.textContent).toContain("Label");
    expect(opts.textContent).toContain("Time limit");
    expect(opts.textContent).toContain("Read-only scan (asks the harness not to run code)");
    expect(opts.textContent).toContain("not a sandbox");
    expect(opts.contains(f.authorized())).toBe(false);
    expect(opts.contains(f.readOnly())).toBe(true);
    click(f.readOnly());
    expect(opts.contains(f.execute())).toBe(true);
  });

  it("says the restriction is enforced only when the harness preset enforces it", () => {
    const f = setup({ enforcedBy: "Claude Code" });
    expect(f.options().textContent).toContain("enforced by Claude Code's tool restrictions");
    expect(f.options().textContent).not.toContain("not a sandbox");
    expect(f.readOnly().checked).toBe(true);
  });

  it("shows recent sources as chips that fill the input", () => {
    const f = setup({ recent: ["https://github.com/org/a", "~/code/b"] });
    expect(f.chips().map((c) => c.textContent)).toEqual(["https://github.com/org/a", "~/code/b"]);
    click(f.chips()[1]);
    expect(f.source().value).toBe("~/code/b");
    click(f.authorized());
    expect(f.start().disabled).toBe(false);
  });

  it("fills the input from a prefill and again for a new nonce", () => {
    const f = setup({ prefill: { value: "https://github.com/org/x", nonce: 1 } });
    expect(f.source().value).toBe("https://github.com/org/x");
    setValue(f.source(), "edited");
    act(() => f.root.render(<ScanForm unitName="spark-1" onStart={f.onStart} prefill={{ value: "https://github.com/org/x", nonce: 2 }} />));
    expect(f.source().value).toBe("https://github.com/org/x");
  });

  it("hints at a doubtful source without blocking it", () => {
    const f = setup();
    setValue(f.source(), "http://github.com/org/repo");
    click(f.authorized());
    expect(f.container.textContent).toContain("Only https://");
    expect(f.start().disabled).toBe(false);
  });

  it("shows the dual-use note and the server's message inline", () => {
    const f = setup({ error: "Another VulnHunter job is running on this unit." });
    expect(f.container.textContent).toContain("scan only code you own or are authorized to audit.");
    expect(f.container.querySelector('[role="alert"]')?.textContent).toContain("Another VulnHunter job is running");
  });

  it("is unusable while the unit is not ready or busy", () => {
    const f = setup({ disabledReason: "Finish the setup above before starting a scan." });
    setValue(f.source(), "https://github.com/org/repo");
    // Controls inside a disabled fieldset are disabled without carrying the attribute themselves.
    expect(f.source().matches(":disabled")).toBe(true);
    expect(f.authorized().matches(":disabled")).toBe(true);
    expect(f.start().disabled).toBe(true);
    expect(f.container.textContent).toContain("Finish the setup above");
  });
});
