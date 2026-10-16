import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SparkSnapshot } from "../../api/types";
import { flush, render } from "../../testing/render";

const api = vi.hoisted(() => ({
  fetchReaSetup: vi.fn(),
  fetchReaSpec: vi.fn(),
  fetchReaStatus: vi.fn(),
  listReaRuns: vi.fn(),
  readReaInstallStream: vi.fn(),
  installRea: vi.fn(),
  startReaRun: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock("../../api/client", async (orig) => ({ ...(await orig<typeof import("../../api/client")>()), ...api }));

import { ReaToolPage } from "./ReaPage";
import { WF_STATIC, setupData, statusData } from "./fixtures";

const spark = { id: "s1", name: "spark-1", platform: "linux", online: true } as unknown as SparkSnapshot;
const btn = (c: HTMLElement, re: RegExp) => Array.from(c.querySelectorAll("button")).find((b) => re.test(b.textContent ?? ""));

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.fetchReaSpec.mockResolvedValue({ groups: [{ id: "javascript", label: "JavaScript/Electron" }], workflows: [WF_STATIC], execClasses: [] });
  api.fetchReaStatus.mockResolvedValue(statusData());
  api.listReaRuns.mockResolvedValue({ runs: [], active: null });
  api.readReaInstallStream.mockResolvedValue(null);
});

describe("ReaToolPage", () => {
  it("while the opt-in is off: shows the consent, does not touch the unit, and turns it on through settings", async () => {
    api.fetchReaSetup.mockResolvedValueOnce(setupData({ enabled: false, startAllowed: false, startBlockedReason: "REA is turned off." }));
    api.fetchReaSetup.mockResolvedValue(setupData());
    api.updateSettings.mockResolvedValue({});
    const { container } = render(<ReaToolPage spark={spark} sparks={[spark]} />);
    await flush();
    await flush();
    expect(container.textContent).toContain("REA is turned off");
    expect(container.textContent).toContain("parses untrusted files and can run targets on this unit as its SSH user");
    expect(api.fetchReaStatus).not.toHaveBeenCalled();
    expect(api.listReaRuns).not.toHaveBeenCalled();
    await act(async () => btn(container, /Turn on REA/)!.click());
    await flush();
    await flush();
    expect(api.updateSettings).toHaveBeenCalledWith({ reaEnabled: true });
    expect(api.fetchReaSetup).toHaveBeenCalledTimes(2);
    expect(api.fetchReaStatus).toHaveBeenCalledWith("s1");
    expect(container.textContent).not.toContain("REA is turned off");
  });

  it("shows the Turn-on notice again when REA is switched off while the page is open (window focus)", async () => {
    api.fetchReaSetup.mockResolvedValueOnce(setupData());
    api.fetchReaSetup.mockResolvedValue(setupData({ enabled: false, startAllowed: false, startBlockedReason: "REA is turned off." }));
    const { container } = render(<ReaToolPage spark={spark} sparks={[spark]} />);
    await flush();
    await flush();
    expect(container.textContent).not.toContain("REA is turned off");
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    await flush();
    expect(container.textContent).toContain("REA is turned off");
    expect(btn(container, /Turn on REA/)).toBeDefined();
  });

  it("shows the credits with links to the project and its disclaimer", async () => {
    api.fetchReaSetup.mockResolvedValue(setupData());
    const { container } = render(<ReaToolPage spark={spark} sparks={[spark]} />);
    await flush();
    const links = Array.from(container.querySelectorAll("a")).map((a) => [a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel")]);
    expect(links).toContainEqual(["https://github.com/morluto/rea", "_blank", "noopener noreferrer"]);
    expect(links).toContainEqual(["https://github.com/morluto/rea/blob/main/DISCLAIMER.md", "_blank", "noopener noreferrer"]);
    expect(container.textContent).toContain("Reverse Engineer Anything");
    expect(container.textContent).toContain("morluto, MIT");
    expect(container.textContent).toMatch(/authorized to analyze/);
  });

  it("says so when there is no unit, and does not call the API for a Windows unit", async () => {
    api.fetchReaSetup.mockResolvedValue(setupData());
    const none = render(<ReaToolPage spark={null} sparks={[]} />);
    expect(none.container.textContent).toContain("No unit to run on");
    const win = render(<ReaToolPage spark={{ ...spark, platform: "windows" } as SparkSnapshot} sparks={[]} />);
    await flush();
    expect(win.container.textContent).toContain("cannot run REA");
    expect(api.fetchReaStatus).not.toHaveBeenCalled();
  });

  it("picks a workflow and starts a run with the contract's request body", async () => {
    api.fetchReaSetup.mockResolvedValue(setupData());
    api.startReaRun.mockResolvedValue({ run: { id: "rea-20261012-000000-abcd", status: "running", startedAt: 1, finishedAt: null, workflowId: WF_STATIC.id, workflowLabel: "x", label: "", execClass: "static", command: "c", target: null, timeoutMinutes: 30 }, job: {} });
    const { container } = render(<ReaToolPage spark={spark} sparks={[spark]} />);
    await flush();
    await flush();
    await act(async () => btn(container, /Analyze a JavaScript\/Electron application/)!.click());
    const path = container.querySelector<HTMLInputElement>('.rea-target input[type="text"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(path, "/opt/app.asar");
      path.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const auth = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((i) => i.closest("label")?.textContent?.includes("I am authorized"))!;
    act(() => auth.click());
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.disabled).toBe(false);
    await act(async () => submit.click());
    expect(api.startReaRun).toHaveBeenCalledWith("s1", {
      workflowId: WF_STATIC.id,
      authorized: true,
      target: { kind: "path", value: "/opt/app.asar" },
      timeoutMinutes: 30,
    });
  });
});
