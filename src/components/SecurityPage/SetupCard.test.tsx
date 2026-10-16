import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VulnHuntApiError, type VulnHuntHarness, type VulnHuntInstallInfo, type VulnHuntInstallJob, type VulnHuntSetup, type VulnHuntStatus } from "../../api/types";
import { flush, render } from "../../testing/render";

const api = vi.hoisted(() => ({
  installVulnHunt: vi.fn(),
  readVulnHuntInstallStream: vi.fn(),
  saveVulnHuntHostCommand: vi.fn(),
  clearVulnHuntHostCommand: vi.fn(),
}));
vi.mock("../../api/client", async (orig) => ({ ...(await orig<typeof import("../../api/client")>()), ...api }));

import { SetupCard } from "./SetupCard";

const setupData = (over: Partial<VulnHuntSetup> = {}): VulnHuntSetup => ({
  repository: "https://github.com/example/VulnHunter",
  pinnedRev: "0123456789abcdef0123456789abcdef01234567",
  hostCommandFile: "~/.config/sparkdash/vulnhunt-host-cmd",
  steps: ["git clone x"],
  limits: { defaultTimeoutMinutes: 240, minTimeoutMinutes: 5, maxTimeoutMinutes: 1440 },
  enabled: true,
  startAllowed: true,
  startBlockedReason: null,
  allowedHosts: [],
  ...over,
});

const harness = (over: Partial<VulnHuntHarness> = {}): VulnHuntHarness => ({
  id: "claude",
  label: "Claude Code",
  found: true,
  wrapperInstalled: false,
  skillsDir: "/home/u/.claude/skills",
  roEnforced: false,
  note: "",
  ...over,
});

const statusData = (over: Partial<VulnHuntStatus> = {}, install: Partial<VulnHuntInstallInfo> = {}): VulnHuntStatus => ({
  reachable: true,
  installed: false,
  path: null,
  git: true,
  setsid: true,
  hostCommand: { source: "none", program: null, found: false, file: null, configured: false },
  ready: false,
  runRoot: null,
  error: null,
  install: {
    pinnedRev: "0123456789abcdef0123456789abcdef01234567",
    installedRev: null,
    upToDate: false,
    skillsDir: null,
    agentsDir: null,
    python311: "3.12",
    skillsDirCandidates: [],
    harnesses: [
      harness({ id: "claude", label: "Claude Code", found: true, roEnforced: true, note: "Uses claude -p with read-only tools." }),
      harness({ id: "codex", label: "Codex CLI", found: false }),
    ],
    ...install,
  },
  ...over,
});

const job = (over: Partial<VulnHuntInstallJob> = {}): VulnHuntInstallJob => ({
  id: "j1",
  sparkId: "s1",
  kind: "install",
  status: "running",
  exitCode: null,
  error: null,
  startedAt: 1,
  finishedAt: null,
  ...over,
});

function mount(props: { setup?: VulnHuntSetup | null; status?: VulnHuntStatus; onRecheck?: () => void; onEnableOptIn?: () => Promise<void> } = {}) {
  const onRecheck = props.onRecheck ?? vi.fn();
  const view = render(
    <SetupCard
      sparkId="s1"
      unitName="spark-1"
      setup={props.setup === undefined ? setupData() : props.setup}
      setupError={null}
      status={props.status ?? statusData()}
      loading={false}
      error={null}
      onRecheck={onRecheck}
      onEnableOptIn={props.onEnableOptIn}
    />
  );
  const q = <T extends Element>(sel: string) => view.container.querySelector<T>(sel);
  const btn = (text: RegExp) => Array.from(view.container.querySelectorAll("button")).find((b) => text.test(b.textContent ?? "")) as HTMLButtonElement | undefined;
  return { ...view, q, btn, onRecheck };
}

function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const click = (el: Element) => act(() => (el as HTMLElement).click());
const submit = async (form: HTMLFormElement) => {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
};

beforeEach(() => {
  api.readVulnHuntInstallStream.mockResolvedValue(null);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("install form gating", () => {
  const installBtn = (m: ReturnType<typeof mount>) => m.btn(/^(Install|Update) on/)!;

  it("offers Install with the default skills directory when the unit has no candidates", async () => {
    const m = mount();
    await flush();
    expect(installBtn(m).disabled).toBe(false);
    expect(m.q<HTMLInputElement>('input[aria-label="Skills directory path"]')!.value).toBe("~/.claude/skills");
  });

  it("disables Install with the server's reason when starting is not allowed", async () => {
    const m = mount({ setup: setupData({ startAllowed: false, startBlockedReason: "Set SPARKDASH_TOKEN first." }) });
    await flush();
    expect(installBtn(m).disabled).toBe(true);
    expect(m.container.textContent).toContain("Set SPARKDASH_TOKEN first.");
  });

  it("disables Install when Python 3.11 is missing", async () => {
    const m = mount({ status: statusData({}, { python311: null }) });
    await flush();
    expect(installBtn(m).disabled).toBe(true);
    expect(m.container.textContent).toContain("Python 3.11 or newer is needed on this unit");
  });

  it("disables Install when git is missing", async () => {
    const m = mount({ status: statusData({ git: false }) });
    await flush();
    expect(installBtn(m).disabled).toBe(true);
    expect(m.container.textContent).toContain("git is not installed on this unit.");
  });

  it("disables Install for an empty skills directory", async () => {
    const m = mount();
    await flush();
    setValue(m.q<HTMLInputElement>('input[aria-label="Skills directory path"]')!, "   ");
    expect(installBtn(m).disabled).toBe(true);
    expect(m.container.textContent).toContain("Choose a skills directory.");
    setValue(m.q<HTMLInputElement>('input[aria-label="Skills directory path"]')!, "/tmp/a b");
    expect(installBtn(m).disabled).toBe(true);
  });

  it("shows Update when an older revision is installed", async () => {
    const m = mount({ status: statusData({ installed: true, path: "/home/u/.local/bin/vh" }, { installedRev: "aaaaaaaaaaaa", skillsDir: "/home/u/.claude/skills", skillsDirCandidates: ["/home/u/.claude/skills"] }) });
    await flush();
    expect(installBtn(m).textContent).toContain("Update");
    expect(m.container.textContent).toContain("Update available");
  });
});

describe("install request", () => {
  it("sends the chosen candidate and the optional agents directory", async () => {
    api.installVulnHunt.mockResolvedValue({ job: job(), revision: "r", repository: "x" });
    const m = mount({ status: statusData({}, { skillsDirCandidates: ["/home/u/.claude/skills", "/home/u/.codex/skills"] }) });
    await flush();
    const radios = m.container.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(radios[0].checked).toBe(true);
    click(radios[1]);
    const agents = m.q<HTMLInputElement>('input[placeholder^="optional, e.g."]')!;
    setValue(agents, " ~/.claude/agents ");
    await submit(m.q<HTMLFormElement>("form")!);
    expect(api.installVulnHunt).toHaveBeenCalledWith("s1", { skillsDir: "/home/u/.codex/skills", agentsDir: "~/.claude/agents" });
  });

  it("omits an empty agents directory", async () => {
    api.installVulnHunt.mockResolvedValue({ job: job(), revision: "r", repository: "x" });
    const m = mount();
    await flush();
    await submit(m.q<HTMLFormElement>("form")!);
    expect(api.installVulnHunt).toHaveBeenCalledWith("s1", { skillsDir: "~/.claude/skills" });
  });

  it.each([
    [400, "skills dir must be inside your home", "The unit's installer rejected the request"],
    [403, "Open dashboard: set a token", "The dashboard does not allow this"],
    [409, "A scan is running", "Another job is running on this unit"],
  ])("shows a %i refusal inline", async (status, message, title) => {
    api.installVulnHunt.mockRejectedValue(new VulnHuntApiError(message, status));
    const m = mount();
    await flush();
    await submit(m.q<HTMLFormElement>("form")!);
    const alert = m.q('[role="alert"]')!;
    expect(alert.textContent).toContain(message);
    expect(alert.textContent).toContain(title);
    expect(installBtnText(m)).toContain("Install");
  });
});

const installBtnText = (m: ReturnType<typeof mount>) => m.btn(/^(Install|Update) on/)?.textContent ?? "";

describe("install progress", () => {
  it("polls once a second while running, stops at completion and re-checks the unit once", async () => {
    vi.useFakeTimers();
    api.installVulnHunt.mockResolvedValue({ job: job(), revision: "r", repository: "x" });
    api.readVulnHuntInstallStream
      .mockResolvedValueOnce(null) // pick-up check on mount
      .mockResolvedValueOnce({ job: job(), lines: [{ seq: 1, text: "cloning", stream: "out" }], partial: "", nextLine: 1 })
      .mockResolvedValueOnce({ job: job({ status: "completed", exitCode: 0, finishedAt: 5 }), lines: [{ seq: 2, text: "done", stream: "out" }], partial: "", nextLine: 2 });
    const m = mount();
    await flush();
    await submit(m.q<HTMLFormElement>("form")!);
    expect(m.container.textContent).toContain("Installing…");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(api.readVulnHuntInstallStream).toHaveBeenLastCalledWith("s1", 0);
    expect(m.container.textContent).toContain("cloning");
    expect(m.onRecheck).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(api.readVulnHuntInstallStream).toHaveBeenLastCalledWith("s1", 1);
    expect(m.container.textContent).toContain("done");
    expect(m.onRecheck).toHaveBeenCalledTimes(1);
    const calls = api.readVulnHuntInstallStream.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(api.readVulnHuntInstallStream.mock.calls.length).toBe(calls);
    expect(m.onRecheck).toHaveBeenCalledTimes(1);
  });

  it("follows an install that is already running when the page opens", async () => {
    vi.useFakeTimers();
    api.readVulnHuntInstallStream.mockResolvedValueOnce({
      job: job(),
      lines: [{ seq: 1, text: "fetching", stream: "out" }],
      partial: "",
      nextLine: 1,
    });
    api.readVulnHuntInstallStream.mockResolvedValue({ job: job({ status: "failed", exitCode: 3, error: "pip failed" }), lines: [], partial: "", nextLine: 1 });
    const m = mount();
    await flush();
    expect(m.container.textContent).toContain("fetching");
    expect(m.container.textContent).toContain("Installing…");
    expect(m.q("form[aria-label^='Install VulnHunter']")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(m.container.textContent).toContain("exit code 3");
    expect(m.container.textContent).toContain("pip failed");
    // A job picked up from the server has no request to repeat here, so there is no Retry; the choices are open again.
    expect(m.btn(/^Retry$/)).toBeUndefined();
    expect(m.btn(/^Set up with Claude Code$/)!.disabled).toBe(false);
    expect(m.onRecheck).toHaveBeenCalledTimes(1);
  });

  it("renders streamed output as text, never as markup", async () => {
    vi.useFakeTimers();
    const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
    api.readVulnHuntInstallStream.mockResolvedValueOnce({
      job: job(),
      lines: [{ seq: 1, text: evil, stream: "out" }],
      partial: "<b>partial</b>",
      nextLine: 1,
    });
    api.readVulnHuntInstallStream.mockResolvedValue({ job: job(), lines: [], partial: "", nextLine: 1 });
    const m = mount();
    await flush();
    const term = m.q("pre.live-term")!;
    expect(term.textContent).toContain(evil);
    expect(term.textContent).toContain("<b>partial</b>");
    expect(m.container.querySelector("pre.live-term img, pre.live-term script, pre.live-term b")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe("quick setup", () => {
  const quickBtn = (m: ReturnType<typeof mount>, label = "Claude Code") => m.btn(new RegExp(`^(Set up|Update) with ${label}$`));
  const readyVia = () =>
    statusData(
      { installed: true, ready: true, path: "/p", hostCommand: { source: "file", program: "vh-claude", found: true, file: "~/x", configured: true } },
      {
        installedRev: "0123456789abcdef",
        upToDate: true,
        harnesses: [harness({ wrapperInstalled: true, roEnforced: true }), harness({ id: "codex", label: "Codex CLI", found: true })],
      }
    );

  it("offers a button only for harnesses found on the unit and lists the others as not found", async () => {
    const m = mount({
      status: statusData(
        {},
        {
          harnesses: [
            harness({ id: "claude", label: "Claude Code", found: true, roEnforced: true, note: "Read-only tools are enforced." }),
            harness({ id: "codex", label: "Codex CLI", found: false }),
            harness({ id: "opencode", label: "OpenCode", found: true, note: "Runs opencode headless." }),
          ],
        }
      ),
    });
    await flush();
    expect(m.container.textContent).toContain("Set up VulnHunter on spark-1");
    expect(quickBtn(m)).toBeDefined();
    expect(quickBtn(m, "OpenCode")).toBeDefined();
    expect(quickBtn(m, "Codex CLI")).toBeUndefined();
    expect(m.container.textContent).toContain("Not found on this unit: Codex CLI");
    expect(m.container.textContent).toContain("Read-only tools are enforced.");
    // Only the harness that enforces read-only carries the badge.
    expect(m.container.textContent?.match(/read-only enforced/g)).toHaveLength(1);
  });

  it("points to Advanced when no harness CLI is found", async () => {
    const m = mount({ status: statusData({}, { harnesses: [harness({ found: false }), harness({ id: "codex", label: "Codex CLI", found: false })] }) });
    await flush();
    expect(m.btn(/^Set up with/)).toBeUndefined();
    expect(m.container.textContent).toContain("No supported agent CLI was found on spark-1");
    expect(m.container.textContent).toContain("Advanced");
  });

  it("one click with the opt-in off turns it on, then installs with the harness id", async () => {
    const order: string[] = [];
    const onEnableOptIn = vi.fn(async () => void order.push("enable"));
    api.installVulnHunt.mockImplementation(async () => {
      order.push("install");
      return { job: job(), revision: "r", repository: "x" };
    });
    const m = mount({ setup: setupData({ enabled: false, startAllowed: false, startBlockedReason: "VulnHunter is turned off." }), onEnableOptIn });
    await flush();
    expect(m.container.textContent).toContain(
      "Turning this on lets this dashboard install VulnHunter and run an AI agent on this unit. Anyone who can reach the dashboard can then use it."
    );
    expect(quickBtn(m)!.disabled).toBe(false);
    await act(async () => quickBtn(m)!.click());
    await flush();
    expect(order).toEqual(["enable", "install"]);
    expect(api.installVulnHunt).toHaveBeenCalledWith("s1", { harness: "claude" });
    expect(m.container.textContent).toContain("Installing…");
  });

  it("does not install when turning the opt-in on fails", async () => {
    const onEnableOptIn = vi.fn().mockRejectedValue(new Error("settings are read-only"));
    const m = mount({ setup: setupData({ enabled: false, startAllowed: false }), onEnableOptIn });
    await flush();
    await act(async () => quickBtn(m)!.click());
    await flush();
    expect(api.installVulnHunt).not.toHaveBeenCalled();
    expect(m.q('[role="alert"]')!.textContent).toContain("settings are read-only");
  });

  it("skips the opt-in call when it is already on and hides the consent sentence", async () => {
    api.installVulnHunt.mockResolvedValue({ job: job(), revision: "r", repository: "x" });
    const onEnableOptIn = vi.fn();
    const m = mount({ onEnableOptIn });
    await flush();
    expect(m.container.textContent).not.toContain("Turning this on lets this dashboard");
    await act(async () => quickBtn(m)!.click());
    expect(onEnableOptIn).not.toHaveBeenCalled();
    expect(api.installVulnHunt).toHaveBeenCalledWith("s1", { harness: "claude" });
  });

  it("disables the buttons with a plain reason when Python 3.11 or git is missing", async () => {
    const py = mount({ status: statusData({}, { python311: null }) });
    await flush();
    expect(quickBtn(py)!.disabled).toBe(true);
    expect(py.q(".sec-quick")!.textContent).toContain("Python 3.11 or newer is needed on this unit.");
    const git = mount({ status: statusData({ git: false, setsid: false }) });
    await flush();
    expect(quickBtn(git)!.disabled).toBe(true);
    expect(git.q(".sec-quick")!.textContent).toContain("git is not installed on this unit.");
    expect(git.q(".sec-quick")!.textContent).toContain("setsid");
  });

  it("explains exit code 127 with the last output lines, and Retry repeats the one-click request", async () => {
    vi.useFakeTimers();
    api.installVulnHunt.mockResolvedValue({ job: job(), revision: "r", repository: "x" });
    api.readVulnHuntInstallStream
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        job: job({ status: "failed", exitCode: 127, error: null, finishedAt: 3 }),
        lines: [{ seq: 1, text: "claude: command not found", stream: "err" }],
        partial: "",
        nextLine: 1,
      });
    const m = mount();
    await flush();
    await act(async () => quickBtn(m)!.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const alert = m.q('[role="alert"]')!;
    expect(alert.textContent).toContain("exit code 127");
    expect(alert.textContent).toContain("missing on the unit");
    expect(alert.textContent).toContain("claude: command not found");
    api.installVulnHunt.mockClear();
    await act(async () => m.btn(/^Retry$/)!.click());
    expect(api.installVulnHunt).toHaveBeenCalledWith("s1", { harness: "claude" });
  });

  it("shows a refusal of the one-click request once, in the quick card", async () => {
    api.installVulnHunt.mockRejectedValue(new VulnHuntApiError("A scan is running", 409));
    const m = mount();
    await flush();
    await act(async () => quickBtn(m)!.click());
    await flush();
    expect(m.container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(m.q(".sec-quick")!.textContent).toContain("Another job is running on this unit");
  });

  it("collapses into a ready summary with a Change harness disclosure", async () => {
    const m = mount({ status: readyVia() });
    await flush();
    const text = m.q(".sec-quick")!.textContent ?? "";
    expect(text).toContain("Ready");
    expect(text).toContain("VulnHunter via Claude Code");
    const details = m.q<HTMLDetailsElement>(".sec-quick details")!;
    expect(details.querySelector("summary")!.textContent).toBe("Change harness");
    expect(details.open).toBe(false);
    expect(details.textContent).toContain("Update with Claude Code");
    expect(m.q(".sec-quick h3")).toBeNull();
  });

  it("re-checks the unit when the install ends", async () => {
    vi.useFakeTimers();
    api.installVulnHunt.mockResolvedValue({ job: job(), revision: "r", repository: "x" });
    api.readVulnHuntInstallStream
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ job: job({ status: "completed", exitCode: 0, finishedAt: 5 }), lines: [], partial: "", nextLine: 0 });
    const m = mount();
    await flush();
    await act(async () => quickBtn(m)!.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(m.onRecheck).toHaveBeenCalledTimes(1);
  });
});

describe("harness command", () => {
  const readyStatus = () =>
    statusData(
      { installed: true, ready: true, path: "/p", hostCommand: { source: "file", program: "my-harness", found: true, file: "~/x", configured: true } },
      { installedRev: "0123456789abcdef", upToDate: true, skillsDir: "/home/u/.claude/skills" }
    );

  it("never prefills the input, shows only the program, and clears it after a save", async () => {
    api.saveVulnHuntHostCommand.mockResolvedValue({ success: true });
    const m = mount({ status: readyStatus() });
    await flush();
    const input = m.q<HTMLInputElement>('input[placeholder^="one line"]')!;
    expect(input.value).toBe("");
    expect(input.type).toBe("text");
    expect(input.autocomplete).toBe("off");
    expect(m.container.textContent).toContain("my-harness");
    expect(m.btn(/^Remove$/)).toBeDefined();
    const save = m.btn(/^Save command$/)!;
    expect(save.disabled).toBe(true);
    setValue(input, "my-harness --headless -p");
    expect(save.disabled).toBe(false);
    await submit(input.closest("form") as HTMLFormElement);
    expect(api.saveVulnHuntHostCommand).toHaveBeenCalledWith("s1", "my-harness --headless -p");
    expect(input.value).toBe("");
    expect(m.onRecheck).toHaveBeenCalledTimes(1);
    expect(m.container.textContent).not.toContain("--headless");
  });

  it("keeps the input and shows the server's message when the save is refused", async () => {
    api.saveVulnHuntHostCommand.mockRejectedValue(new VulnHuntApiError("my-harnes is not on the PATH", 400));
    const m = mount({ status: readyStatus() });
    await flush();
    const input = m.q<HTMLInputElement>('input[placeholder^="one line"]')!;
    setValue(input, "my-harnes -p");
    await submit(input.closest("form") as HTMLFormElement);
    expect(m.q('[role="alert"]')!.textContent).toContain("not on the PATH");
    expect(input.value).toBe("my-harnes -p");
    expect(m.onRecheck).not.toHaveBeenCalled();
  });

  it("shows a 403 refusal and disables saving when starting is not allowed", async () => {
    api.saveVulnHuntHostCommand.mockRejectedValue(new VulnHuntApiError("token required", 403));
    const m = mount({ status: readyStatus() });
    await flush();
    const input = m.q<HTMLInputElement>('input[placeholder^="one line"]')!;
    setValue(input, "h -p");
    await submit(input.closest("form") as HTMLFormElement);
    expect(m.q('[role="alert"]')!.textContent).toContain("token required");

    const blocked = mount({ status: readyStatus(), setup: setupData({ startAllowed: false, startBlockedReason: "No token set." }) });
    await flush();
    const b = blocked.container.querySelector<HTMLInputElement>('input[placeholder^="one line"]')!;
    setValue(b, "h -p");
    expect(Array.from(blocked.container.querySelectorAll("button")).find((x) => /^Save command$/.test(x.textContent ?? ""))!.disabled).toBe(true);
    expect(blocked.container.textContent).toContain("No token set.");
  });

  it("removes the saved command", async () => {
    api.clearVulnHuntHostCommand.mockResolvedValue({ success: true });
    const m = mount({ status: readyStatus() });
    await flush();
    await act(async () => m.btn(/^Remove$/)!.click());
    expect(api.clearVulnHuntHostCommand).toHaveBeenCalledWith("s1");
    expect(m.onRecheck).toHaveBeenCalledTimes(1);
  });
});

describe("source hygiene", () => {
  it("does not use dangerouslySetInnerHTML in the Security page", async () => {
    const files = import.meta.glob("./*.tsx", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    const offenders = Object.entries(files)
      .filter(([name, src]) => !name.endsWith(".test.tsx") && /dangerouslySetInnerHTML/.test(src))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });
});
