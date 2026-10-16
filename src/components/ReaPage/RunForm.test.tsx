import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ReaWorkflowSpec } from "../../api/types";
import { render } from "../../testing/render";
import { WF_DEVICE, WF_EXEC, WF_NATIVE, WF_STATIC, WF_TWO, WF_ZERO, setupData, statusData } from "./fixtures";
import { RunForm } from "./RunForm";

const click = (el: Element | null | undefined) => act(() => (el as HTMLElement).click());
const setValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

function mount(workflow: ReaWorkflowSpec, props: Partial<React.ComponentProps<typeof RunForm>> = {}) {
  const onStart = vi.fn().mockResolvedValue(true);
  const view = render(
    <RunForm
      sparkId="s1"
      unitName="spark-1"
      workflow={workflow}
      setup={setupData({ deviceWritesEnabled: true })}
      status={statusData()}
      disabledReason={null}
      error={null}
      onStart={onStart}
      onDismissError={vi.fn()}
      prefill={null}
      {...props}
    />
  );
  const q = <T extends Element>(s: string) => view.container.querySelector<T>(s)!;
  const check = (text: string) =>
    Array.from(view.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((i) => i.closest("label")?.textContent?.includes(text))!;
  const pathInputs = () => Array.from(view.container.querySelectorAll<HTMLInputElement>('.rea-target input[type="text"]'));
  return { ...view, onStart, q, check, run: () => q<HTMLButtonElement>('button[type="submit"]'), pathInputs };
}

describe("RunForm", () => {
  it("generates the option controls from args and sends the request body", async () => {
    const f = mount(WF_STATIC);
    expect(f.container.querySelector('select option[value="asar"]')).not.toBeNull();
    expect(f.container.textContent).toContain("max-heap-mb");
    expect(f.run().disabled).toBe(true);
    setValue(f.pathInputs()[0], "/opt/app.asar");
    setValue(f.container.querySelector<HTMLInputElement>('input[type="number"][min="128"]')!, "2048");
    click(f.check("I am authorized"));
    expect(f.run().disabled).toBe(false);
    await act(async () => f.run().click());
    expect(f.onStart).toHaveBeenCalledWith({
      workflowId: WF_STATIC.id,
      authorized: true,
      target: { kind: "path", value: "/opt/app.asar" },
      options: { "max-heap-mb": 2048 },
      timeoutMinutes: 30,
    });
  });

  it("asks for two targets for a compare-class workflow", () => {
    const f = mount(WF_TWO);
    expect(f.container.textContent).toContain("Baseline assembly");
    expect(f.container.textContent).toContain("Candidate assembly");
    expect(f.pathInputs()).toHaveLength(2);
    setValue(f.pathInputs()[0], "/a/one.dll");
    click(f.check("I am authorized"));
    expect(f.run().disabled).toBe(true);
    expect(f.container.textContent).toContain("Choose the second target");
    setValue(f.pathInputs()[1], "/a/two.dll");
    expect(f.run().disabled).toBe(false);
  });

  it("needs no target for a zero-target workflow", async () => {
    const f = mount(WF_ZERO);
    expect(f.container.textContent).toContain("needs no file or folder");
    expect(f.pathInputs()).toHaveLength(0);
    click(f.check("I am authorized"));
    await act(async () => f.run().click());
    expect(f.onStart).toHaveBeenCalledWith({ workflowId: WF_ZERO.id, authorized: true, timeoutMinutes: 30 });
  });

  it("requires the separate red confirmation for executes-target workflows", async () => {
    const f = mount(WF_EXEC);
    expect(f.container.querySelector(".rea-danger")).not.toBeNull();
    expect(f.container.textContent).toContain("runs or interacts with the target on spark-1 as its SSH user. It is not a sandbox.");
    setValue(f.pathInputs()[0], "/opt/app");
    click(f.check("I am authorized"));
    expect(f.run().disabled).toBe(true);
    click(f.check("This runs or interacts"));
    expect(f.run().disabled).toBe(false);
    await act(async () => f.run().click());
    expect(f.onStart).toHaveBeenCalledWith(expect.objectContaining({ workflowId: WF_EXEC.id, confirmExecute: true, authorized: true }));
  });

  it("shows no red block for static workflows and never sends confirmExecute", async () => {
    const f = mount(WF_STATIC);
    expect(f.container.querySelector(".rea-danger")).toBeNull();
    setValue(f.pathInputs()[0], "/opt/app.asar");
    click(f.check("I am authorized"));
    await act(async () => f.run().click());
    expect(f.onStart.mock.calls[0][0]).not.toHaveProperty("confirmExecute");
  });

  it("adds the device line and is blocked while device writes are off", () => {
    const off = mount(WF_DEVICE, { setup: setupData({ deviceWritesEnabled: false }) });
    expect(off.container.textContent).toContain("also changes the device");
    click(off.check("I am authorized"));
    click(off.check("This runs or interacts"));
    expect(off.run().disabled).toBe(true);
    expect(off.container.textContent).toContain("REA_ENABLE_DEVICE_WRITES=1");
  });

  it("offers a provider select (auto + detected) and the requireOneOf rule", async () => {
    const f = mount(WF_NATIVE);
    const select = f.container.querySelector<HTMLSelectElement>("select")!;
    const opts = Array.from(select.options).map((o) => [o.value, o.disabled]);
    expect(opts).toEqual([["auto", false], ["ghidra", true]]);
    expect(f.container.textContent).toContain("Set at least one of: name, comment.");
    setValue(f.pathInputs()[0], "/opt/bin");
    setValue(f.container.querySelector<HTMLInputElement>('input[type="text"].rea-mono:not([placeholder])')!, "main");
    click(f.check("I am authorized"));
    expect(f.run().disabled).toBe(true);
  });

  it("disables Run with the given reason and shows the server's refusal inline", () => {
    const f = mount(WF_STATIC, { disabledReason: "A run is already going on this unit.", error: "Another run is active (409)" });
    expect(f.run().disabled).toBe(true);
    expect(f.container.textContent).toContain("A run is already going on this unit.");
    expect(f.container.textContent).toContain("Another run is active (409)");
  });

  it("Run again with an upload target keeps the target and enables Run", async () => {
    const target = { kind: "upload" as const, uploadId: "up-20261012-000000-abcdef", relPath: "extracted/app.asar" };
    const f = mount(WF_STATIC, {
      prefill: { nonce: 1, workflowId: WF_STATIC.id, label: "again", provider: null, timeoutMinutes: 30, targets: [target, null] },
    });
    await act(async () => {});
    click(f.check("I am authorized"));
    expect(f.container.textContent).not.toContain("Choose a target");
    expect(f.run().disabled).toBe(false);
    await act(async () => f.run().click());
    expect(f.onStart).toHaveBeenCalledWith(expect.objectContaining({ target }));
  });

  it("Run again with an upload target and no relPath keeps the target too", async () => {
    const target = { kind: "upload" as const, uploadId: "up-20261012-000000-abcdef" };
    const f = mount(WF_STATIC, {
      prefill: { nonce: 1, workflowId: WF_STATIC.id, label: "", provider: null, timeoutMinutes: 30, targets: [target, null] },
    });
    await act(async () => {});
    click(f.check("I am authorized"));
    expect(f.run().disabled).toBe(false);
  });
});
