import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  checkSparkUpdates,
  fetchDashboardService,
  fetchInstallAllJob,
  fetchSparkUpdates,
  fetchSparkUpdatesJob,
  fetchUpdatesSummary,
  forgetUpdatesSudo,
  installAllUpdates,
  installSparkUpdates,
  refreshAllUpdates,
  refreshSparkUpdates,
  setDashboardService,
} from "../../api/client";
import type { DashboardServiceStatus, InstallAllJob, SparkSnapshot, SparkUpdateDetail, UpdateInstallJob, UpdateSummary } from "../../api/types";
import { flush, render } from "../../testing/render";
import { makeSpark } from "../../testing/fixtures";
import { AppSidebar } from "../shell/AppSidebar";
import { UpdatesPage } from "./UpdatesPage";

vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/client")>()),
  fetchUpdatesSummary: vi.fn(),
  fetchSparkUpdates: vi.fn(),
  checkSparkUpdates: vi.fn(),
  refreshSparkUpdates: vi.fn(),
  installSparkUpdates: vi.fn(),
  fetchSparkUpdatesJob: vi.fn(),
  installAllUpdates: vi.fn(),
  refreshAllUpdates: vi.fn(),
  fetchInstallAllJob: vi.fn(),
  fetchDashboardService: vi.fn(),
  setDashboardService: vi.fn(),
  forgetUpdatesSudo: vi.fn(),
}));

const NOW = 1_800_000_000_000;
const H = 3_600_000;

const SUMMARY: UpdateSummary = {
  now: NOW,
  sparks: [
    { id: "s1", name: "Pico", online: true, state: "ok", aptCount: 3, fwCount: 1, rebootRequired: true, firmwareRebootNeeded: false, checkedAt: NOW - 3 * H, indexAutoRefresh: "check-only", sudoSaved: false },
    { id: "s2", name: "Dell", online: true, state: "ok", aptCount: 0, fwCount: 0, rebootRequired: false, firmwareRebootNeeded: false, checkedAt: NOW - 60_000, indexAutoRefresh: "check-only", sudoSaved: false },
  ],
  anyUpgradable: true,
};

/** The same fleet with a sudo password remembered for every unit: the page asks for none. */
const SUMMARY_SAVED: UpdateSummary = {
  ...SUMMARY,
  sparks: SUMMARY.sparks.map((s) => ({ ...s, indexAutoRefresh: "stored-password" as const, sudoSaved: true })),
};

const DETAIL: SparkUpdateDetail = {
  now: NOW,
  sparkId: "s1",
  state: "ok",
  checkedAt: NOW - 3 * H,
  index: { refreshedAt: NOW - 2 * H },
  indexAutoRefresh: "check-only",
  sudoSaved: false,
  apt: [
    { name: "curl", newVersion: "8.5.0-2", oldVersion: "8.5.0-1" },
    { name: "libssl3", newVersion: "3.0.11", oldVersion: "3.0.10" },
    { name: "linux-image-generic", newVersion: "6.8.0-40", oldVersion: "6.8.0-39" },
  ],
  sim: { upgrades: 3, kept: 0, removals: ["liblegacy0 1.2.3-1"] },
  firmware: { count: 1, devices: [{ name: "NVMe SSD", current: "1.0", available: "1.1" }] },
  rebootRequired: true,
  firmwareRebootNeeded: null,
  lastError: null,
};

/** The same unit with a sudo password the dashboard remembers: every action on it needs no typing. */
const SAVED_DETAIL: SparkUpdateDetail = { ...DETAIL, indexAutoRefresh: "stored-password", sudoSaved: true };

/** Tell the page — and every action's answer — that these units' passwords are remembered. */
function rememberPasswords() {
  vi.mocked(fetchUpdatesSummary).mockResolvedValue(SUMMARY_SAVED);
  vi.mocked(fetchSparkUpdates).mockResolvedValue(SAVED_DETAIL);
  vi.mocked(checkSparkUpdates).mockResolvedValue(SAVED_DETAIL);
  vi.mocked(refreshSparkUpdates).mockResolvedValue(SAVED_DETAIL);
}

const DASH: DashboardServiceStatus = {
  units: [
    { unit: "dgx-dashboard.service", enabled: "enabled", active: "active", memoryBytes: 123 * 1024 * 1024, mainPid: 4242 },
    { unit: "dgx-dashboard-admin.service", enabled: "enabled", active: "inactive", memoryBytes: null, mainPid: null },
  ],
  now: NOW,
};

/** An install of the selected unit in flight: apt finished, firmware still spinning. */
const RUNNING_FW_JOB: UpdateInstallJob = {
  id: "j-run",
  state: "running",
  startedAt: NOW,
  finishedAt: null,
  phases: [{ key: "apt", state: "done" }, { key: "firmware", state: "running" }],
  rebootRequired: false,
  firmwareRebootNeeded: false,
};

/** The same install gone wrong on the firmware phase — the answer the server keeps after it stops. */
const ERRORED_FW_JOB: UpdateInstallJob = {
  ...RUNNING_FW_JOB,
  id: "j-err",
  state: "error",
  finishedAt: NOW,
  phases: [{ key: "apt", state: "done" }, { key: "firmware", state: "error", note: "fwupdater exited 1" }],
  error: "firmware update failed",
};

const sparks = (): SparkSnapshot[] => [
  { ...makeSpark("s1"), name: "Pico" },
  { ...makeSpark("s2"), name: "Dell" },
];

const text = () => document.body.textContent ?? "";

/** The selected unit's panel: the install status and the two lists, and nothing of the fleet panel. */
const unitPanel = (name = "Pico") =>
  document.body.querySelector(`section[aria-label="Updates for ${name}"]`) as HTMLElement;

/** Section headings and the lists under them, in DOM order — what sits above what. */
const unitSectionOrder = (name = "Pico") =>
  [...unitPanel(name).querySelectorAll("h3.up-h3, ul.up-job, ul.up-list")].map((el) =>
    el.matches("h3") ? `h3:${el.textContent}` : el.className,
  );

/** True when a comes before b in the document. */
const before = (a: Element, b: Element) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

/** The install job of the selected unit: its heading, its rows and the state of each phase. */
function installJob(name = "Pico") {
  const panel = unitPanel(name);
  const heading = [...panel.querySelectorAll("h3.up-h3")].find((h) => h.textContent === "Install job")!;
  const rows = [...panel.querySelectorAll<HTMLElement>("ul.up-job .up-job__row")];
  const states = rows.map((row) => row.querySelector<HTMLElement>(".up-job__state")!);
  return {
    heading,
    names: rows.map((row) => row.querySelector(".up-job__name")?.textContent),
    states,
    stateTexts: states.map((s) => s.textContent),
    spinners: states.map((s) => s.querySelector("i.up-spin")),
    systemHeading: [...panel.querySelectorAll("h3.up-h3")].find((h) => h.textContent === "System packages")!,
    firmwareHeading: [...panel.querySelectorAll("h3.up-h3")].find((h) => h.textContent === "Firmware")!,
  };
}

const button = (label: string | RegExp) =>
  [...document.body.querySelectorAll("button")].find((b) => (typeof label === "string" ? b.textContent?.includes(label) : label.test(b.textContent ?? ""))) as HTMLButtonElement;
const dialog = () => document.body.querySelector('[role="dialog"]') as HTMLElement | null;

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const typePassword = (pw: string) => {
  const input = dialog()!.querySelector('input[type="password"]') as HTMLInputElement;
  setInput(input, pw);
  return input;
};

/** Let a mocked action's promise chain (and React's re-render after it) finish. */
const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

beforeEach(() => {
  window.history.replaceState(null, "", "/updates");
  try {
    localStorage.clear();
  } catch {
    /* jsdom storage */
  }
  vi.mocked(fetchUpdatesSummary).mockResolvedValue(SUMMARY);
  vi.mocked(fetchSparkUpdates).mockResolvedValue(DETAIL);
  vi.mocked(checkSparkUpdates).mockResolvedValue(DETAIL);
  vi.mocked(refreshSparkUpdates).mockResolvedValue(DETAIL);
  vi.mocked(installSparkUpdates).mockResolvedValue({ jobId: "j1" });
  vi.mocked(fetchSparkUpdatesJob).mockResolvedValue({ job: null });
  vi.mocked(installAllUpdates).mockResolvedValue({ jobId: "f1" });
  vi.mocked(refreshAllUpdates).mockResolvedValue({ jobId: "r1" });
  vi.mocked(fetchInstallAllJob).mockResolvedValue({ job: null });
  vi.mocked(fetchDashboardService).mockResolvedValue(DASH);
  vi.mocked(setDashboardService).mockResolvedValue(DASH);
  vi.mocked(forgetUpdatesSudo).mockResolvedValue({ success: true, forgotten: true });
});

describe("UpdatesPage", () => {
  it("renders a card per unit with counts, checked-at and the reboot chip, and leaves out what the server refuses", async () => {
    const localHost = { ...makeSpark("dell-lan"), kind: "host" as const, isLocal: true, name: "dell.lan" };
    const mac = { ...makeSpark("studio"), kind: "mac" as const, platform: "darwin" as const, name: "Studio" };
    render(<UpdatesPage sparks={[...sparks(), localHost, mac]} />);
    await flush();
    expect(text()).toContain("Updates");
    expect(text()).toContain("Pico");
    expect(text()).toContain("Dell");
    expect(text()).toContain("3 apt · 1 firmware");
    expect(text()).toContain("0 apt · 0 firmware");
    expect(text()).toContain("Checked 3h ago");
    expect(text()).toContain("Checked 60s ago");
    // The dashboard's own machine (isLocal host) is a candidate like any Spark; Macs are never offered: the routes 400 them.
    expect(text()).toContain("dell.lan");
    expect(text()).not.toContain("Studio");
    // The reboot-required chip shows only on the unit that needs one.
    const picoCard = button("Pico");
    expect(picoCard.textContent).toContain("Reboot required");
    expect(button("Dell").textContent).not.toContain("Reboot required");
    // Picking the other card reads that unit instead.
    act(() => button("Dell").click());
    await flush();
    expect(fetchSparkUpdates).toHaveBeenCalledWith("s2");
  });

  it("keeps the DGX Dashboard panel on the Sparks: the dashboard's own machine does not get it", async () => {
    const localHost = { ...makeSpark("dell-lan"), kind: "host" as const, isLocal: true, platform: "linux" as const, name: "dell.lan" };
    render(<UpdatesPage sparks={[...sparks(), localHost]} />);
    await flush();
    // Pico is the unit on screen: its DGX services are the page's business.
    expect(document.body.querySelector('section[aria-label="DGX Dashboard"]')).toBeTruthy();
    act(() => button("dell.lan").click());
    await flush();
    expect(fetchSparkUpdates).toHaveBeenCalledWith("dell-lan");
    // Dell.lan is a plain Linux box: the dgx-dashboard units exist only on the DGX, so the panel must not even ask.
    expect(document.body.querySelector('section[aria-label="DGX Dashboard"]')).toBeNull();
    expect(fetchDashboardService).not.toHaveBeenCalledWith("dell-lan");
  });

  it("shows the last check failure as an error banner, never as healthy", async () => {
    vi.mocked(fetchSparkUpdates).mockResolvedValue({ ...DETAIL, lastError: "apt list died" });
    render(<UpdatesPage sparks={sparks()} />);
    await flush();
    expect(text()).toContain("The last check failed: apt list died");
    expect(document.body.querySelector(".up-banner.is-error")).toBeTruthy();
  });

  it("Check now runs the sudo-free check and shows what it answered", async () => {
    render(<UpdatesPage sparks={sparks()} />);
    await flush();
    act(() => button("Check now").click());
    await flush();
    expect(checkSparkUpdates).toHaveBeenCalledWith("s1");
    expect(text()).toContain("curl");
    expect(text()).toContain("8.5.0-1 → 8.5.0-2");
    expect(text()).toContain("NVMe SSD");
    expect(text()).toContain("1.0 → 1.1");
    // The check itself never asks for a password.
    expect(dialog()).toBeNull();
  });

  it("Refresh index asks for the password once and posts it", async () => {
    render(<UpdatesPage sparks={sparks()} />);
    await flush();
    act(() => button("Refresh index").click());
    expect(dialog()).toBeTruthy();
    const confirm = button("Confirm");
    expect(confirm.disabled).toBe(true); // nothing typed yet
    const input = typePassword("hunter2");
    expect(confirm.disabled ?? button("Confirm").disabled).toBe(false);
    act(() => button("Confirm").click());
    await flush();
    expect(refreshSparkUpdates).toHaveBeenCalledWith("s1", "hunter2", undefined);
    expect(input.value === "hunter2" || dialog() == null).toBe(true);
  });

  it("Refresh index offers the remember tick and passes it through", async () => {
    render(<UpdatesPage sparks={sparks()} />);
    await flush();
    act(() => button("Refresh index").click());
    expect(dialog()).toBeTruthy();
    expect(dialog()!.textContent).toContain("Remember for the daily refresh");
    const box = dialog()!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => box.click());
    typePassword("hunter2");
    act(() => button("Confirm").click());
    await flush();
    expect(refreshSparkUpdates).toHaveBeenCalledWith("s1", "hunter2", true);
  });

  it("the remember tick is wiped when the dialog closes, like the password box", async () => {
    render(<UpdatesPage sparks={sparks()} />);
    await flush();
    act(() => button("Refresh index").click());
    const box = dialog()!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => box.click());
    expect(box.checked).toBe(true);
    typePassword("hunter2");
    act(() => button("Cancel").click());
    await flush();
    act(() => button("Refresh index").click());
    const again = dialog()!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(again.checked).toBe(false);
    expect((dialog()!.querySelector('input[type="password"]') as HTMLInputElement).value).toBe("");
  });

  it("the unit panel says whether a sudo password is remembered for the unit", async () => {
    render(<UpdatesPage sparks={sparks()} />);
    await flush();
    // Nothing remembered: the page says so and offers no forgetting.
    expect(text()).toContain("no sudo password stored");
    expect(button(/Forget password/) ?? null).toBeNull();
    vi.mocked(checkSparkUpdates).mockResolvedValue(SAVED_DETAIL);
    act(() => button("Check now").click());
    await flush();
    expect(text()).toContain("sudo password remembered");
    expect(text()).not.toContain("no sudo password stored");
    expect(button("Forget password")).toBeTruthy();
  });

  it("Forget password asks the server to drop the remembered one and re-reads the unit", async () => {
    vi.mocked(fetchSparkUpdates).mockResolvedValue(SAVED_DETAIL);
    render(<UpdatesPage sparks={sparks()} />);
    await flush();
    act(() => button("Forget password").click());
    await flush();
    expect(forgetUpdatesSudo).toHaveBeenCalledWith("s1");
    expect(vi.mocked(fetchSparkUpdates).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("an action on a unit with a remembered password runs without the box and sends no password", async () => {
    rememberPasswords();
    render(<UpdatesPage sparks={sparks()} />);
    await flush();
    act(() => button("Install updates").click());
    await flush();
    expect(dialog()).toBeNull();
    expect(installSparkUpdates).toHaveBeenCalledWith("s1", {});
    act(() => button("Refresh index").click());
    await flush();
    expect(dialog()).toBeNull();
    expect(refreshSparkUpdates).toHaveBeenCalledWith("s1", undefined, undefined);
    // The DGX Dashboard switch is the same: nothing to type, no box.
    act(() => button("Disable").click());
    await flush();
    expect(dialog()).toBeNull();
    expect(setDashboardService).toHaveBeenCalledWith("s1", { enabled: false });
  });

  it("a fleet install needs no typing when every online unit has its password remembered", async () => {
    rememberPasswords();
    render(<UpdatesPage sparks={sparks()} />);
    await flush();
    act(() => button("Update all machines").click());
    await flush();
    expect(dialog()).toBeNull();
    expect(installAllUpdates).toHaveBeenCalledWith({});
  });

  it("a fleet index refresh needs no typing when every online unit has its password remembered", async () => {
    rememberPasswords();
    render(<UpdatesPage sparks={sparks()} />);
    await flush();
    act(() => button("Refresh all machines").click());
    await flush();
    expect(dialog()).toBeNull();
    expect(refreshAllUpdates).toHaveBeenCalledWith({});
  });

  it("a mixed fleet still opens the box, but an empty box is an answer: remembered units use theirs", async () => {
    vi.mocked(fetchUpdatesSummary).mockResolvedValue({
      ...SUMMARY,
      sparks: SUMMARY.sparks.map((s, i) => ({ ...s, sudoSaved: i === 1, indexAutoRefresh: i === 1 ? ("stored-password" as const) : ("check-only" as const) })),
    });
    render(<UpdatesPage sparks={sparks()} />);
    await flush();
    act(() => button("Update all machines").click());
    expect(dialog()).toBeTruthy();
    // The box may stay empty: Confirm is live without typing.
    expect(button("Confirm").disabled).toBe(false);
    expect(dialog()!.textContent).toContain("A unit whose password the dashboard already remembers");
    act(() => button("Confirm").click());
    await flush();
    expect(installAllUpdates).toHaveBeenCalledWith({});
  });

  it("Refresh all machines starts the shared job in refresh mode and follows it with refresh wording", async () => {
    vi.useFakeTimers();
    try {
      const running: InstallAllJob = {
        id: "r1",
        mode: "refresh",
        state: "running",
        startedAt: NOW,
        finishedAt: null,
        units: [
          { sparkId: "s1", sparkName: "Pico", state: "running" },
          { sparkId: "s2", sparkName: "Dell", state: "pending" },
        ],
      };
      const done: InstallAllJob = {
        id: "r1",
        mode: "refresh",
        state: "done",
        startedAt: NOW,
        finishedAt: NOW + 5000,
        units: [
          { sparkId: "s1", sparkName: "Pico", state: "done" },
          { sparkId: "s2", sparkName: "Dell", state: "skipped-offline" },
        ],
      };
      render(<UpdatesPage sparks={sparks()} />);
      await flush();
      act(() => button("Refresh all machines").click());
      expect(dialog()).toBeTruthy();
      expect(dialog()!.textContent).toContain("Remember for the daily refresh");
      const box = dialog()!.querySelector('input[type="checkbox"]') as HTMLInputElement;
      act(() => box.click());
      typePassword("hunter2");
      act(() => button("Confirm").click());
      await flush();
      expect(refreshAllUpdates).toHaveBeenCalledWith({ sudoPassword: "hunter2", remember: true });
      vi.mocked(fetchInstallAllJob).mockResolvedValueOnce({ job: running }).mockResolvedValueOnce({ job: done });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(text()).toContain("Refreshing machines…");
      expect(text()).toContain("Refreshing…");
      expect(text()).toContain("Queued");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(text()).toContain("Refreshed");
      expect(text()).toContain("Finished: 1 refreshed, 1 skipped.");
      // With the run settled, both fleet buttons answer to the summary again.
      expect(button("Refresh all machines").disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-reads the cards and the open unit while a fleet refresh is still walking the units", async () => {
    vi.useFakeTimers();
    try {
      const running: InstallAllJob = {
        id: "r1",
        mode: "refresh",
        state: "running",
        startedAt: NOW,
        finishedAt: null,
        units: [
          { sparkId: "s1", sparkName: "Pico", state: "running" },
          { sparkId: "s2", sparkName: "Dell", state: "pending" },
        ],
      };
      const done: InstallAllJob = {
        id: "r1",
        mode: "refresh",
        state: "done",
        startedAt: NOW,
        finishedAt: NOW + 9000,
        units: [
          { sparkId: "s1", sparkName: "Pico", state: "done" },
          { sparkId: "s2", sparkName: "Dell", state: "skipped-offline" },
        ],
      };
      render(<UpdatesPage sparks={sparks()} />);
      await flush();
      act(() => button("Refresh all machines").click());
      typePassword("hunter2");
      act(() => button("Confirm").click());
      await flush();
      // The run keeps answering "running" for the whole walk; the page follows it every second.
      let live: InstallAllJob = running;
      vi.mocked(fetchInstallAllJob).mockImplementation(async () => ({ job: live }));
      // The first follow tick lands; the reads so far are only the mount ones plus the one the
      // submit fires right after the job starts — the frozen snapshot this test is about.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      const summaryAtStart = vi.mocked(fetchUpdatesSummary).mock.calls.length;
      const detailAtStart = vi.mocked(fetchSparkUpdates).mock.calls.length;
      expect(summaryAtStart).toBe(2);
      expect(detailAtStart).toBe(1);
      // Two cadence ticks (the first ~1s after the run is seen, then every 5s) while it is still running.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(text()).toContain("Refreshing machines…");
      expect(vi.mocked(fetchUpdatesSummary).mock.calls.length).toBeGreaterThanOrEqual(summaryAtStart + 2);
      expect(vi.mocked(fetchSparkUpdates).mock.calls.length).toBeGreaterThanOrEqual(detailAtStart + 2);
      expect(vi.mocked(fetchSparkUpdates)).toHaveBeenLastCalledWith("s1");
      // Settle: the run finishes and the settle effect re-reads, once, as before.
      live = done;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(text()).toContain("Finished: 1 refreshed, 1 skipped.");
      const summaryAfterSettle = vi.mocked(fetchUpdatesSummary).mock.calls.length;
      const detailAfterSettle = vi.mocked(fetchSparkUpdates).mock.calls.length;
      expect(summaryAfterSettle).toBeGreaterThanOrEqual(summaryAtStart + 3);
      expect(detailAfterSettle).toBeGreaterThanOrEqual(detailAtStart + 3);
      // Nothing keeps polling once the run is over.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(vi.mocked(fetchUpdatesSummary).mock.calls.length).toBe(summaryAfterSettle);
      expect(vi.mocked(fetchSparkUpdates).mock.calls.length).toBe(detailAfterSettle);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the Refresh all machines button is disabled while no unit is online", async () => {
    render(<UpdatesPage sparks={[makeSpark("s1", false), makeSpark("s2", false)]} />);
    await flush();
    expect(button("Refresh all machines").disabled).toBe(true);
  });

  it("Install updates opens the password dialog and posts the typed password", async () => {
    render(<UpdatesPage sparks={sparks()} />);
    await flush();
    act(() => button("Install updates").click());
    expect(dialog()).toBeTruthy();
    expect(text()).toContain("used once");
    const submit = button("Confirm");
    expect(submit.disabled).toBe(true);
    typePassword("hunter2");
    expect(button("Confirm").disabled).toBe(false);
    act(() => button("Confirm").click());
    await flush();
    expect(installSparkUpdates).toHaveBeenCalledWith("s1", { sudoPassword: "hunter2" });
  });

  it("Install updates offers the remember tick and hands it to the server", async () => {
    render(<UpdatesPage sparks={sparks()} />);
    await flush();
    act(() => button("Install updates").click());
    expect(dialog()!.textContent).toContain("Remember this password");
    const box = dialog()!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    act(() => box.click());
    typePassword("hunter2");
    act(() => button("Confirm").click());
    await flush();
    expect(installSparkUpdates).toHaveBeenCalledWith("s1", { sudoPassword: "hunter2", remember: true });
  });

  it("a 409 needs_confirmation lists the removals verbatim and the confirm re-posts with confirmRemovals", async () => {
    const gate = new ApiError("packages would be removed", 409, "needs_confirmation", false, { removals: ["liblegacy0 1.2.3-1", "old-daemon 0.9"] });
    vi.mocked(installSparkUpdates)
      .mockRejectedValueOnce(gate)
      .mockResolvedValueOnce({ jobId: "j2" });
    render(<UpdatesPage sparks={sparks()} />);
    await flush();
    act(() => button("Install updates").click());
    typePassword("hunter2");
    act(() => button("Confirm").click());
    await settle();
    // The password box gave way to the explicit confirmation, removals as the server sent them.
    const d = dialog()!;
    expect(d.textContent).toContain("The update wants to remove packages");
    expect(d.textContent).toContain("liblegacy0 1.2.3-1");
    expect(d.textContent).toContain("old-daemon 0.9");
    expect(installSparkUpdates).toHaveBeenLastCalledWith("s1", { sudoPassword: "hunter2" });
    act(() => button("Install anyway").click());
    await settle();
    expect(installSparkUpdates).toHaveBeenCalledTimes(2);
    expect(installSparkUpdates).toHaveBeenLastCalledWith("s1", { sudoPassword: "hunter2", confirmRemovals: true });
    expect(dialog()).toBeNull();
  });

  it("a removals confirmation on a remembered password re-posts without typing anything", async () => {
    vi.mocked(fetchSparkUpdates).mockResolvedValue(SAVED_DETAIL);
    const gate = new ApiError("packages would be removed", 409, "needs_confirmation", false, { removals: ["liblegacy0 1.2.3-1"] });
    vi.mocked(installSparkUpdates)
      .mockRejectedValueOnce(gate)
      .mockResolvedValueOnce({ jobId: "j3" });
    render(<UpdatesPage sparks={sparks()} />);
    await flush();
    act(() => button("Install updates").click());
    await settle();
    expect(dialog()!.textContent).toContain("The update wants to remove packages");
    act(() => button("Install anyway").click());
    await settle();
    expect(installSparkUpdates).toHaveBeenLastCalledWith("s1", { confirmRemovals: true });
  });

  it("a bad password keeps the dialog open with the 403 line", async () => {
    vi.mocked(installSparkUpdates).mockRejectedValueOnce(new ApiError("refused", 403, "bad-password"));
    render(<UpdatesPage sparks={sparks()} />);
    await flush();
    act(() => button("Install updates").click());
    typePassword("wrong");
    act(() => button("Confirm").click());
    await flush();
    await settle();
    expect(dialog()).toBeTruthy();
    // And 429 says to wait.
    act(() => button("Cancel").click());
    act(() => button("Install updates").click());
    typePassword("wrong");
    vi.mocked(installSparkUpdates).mockRejectedValueOnce(new ApiError("locked", 429, "password-locked"));
    act(() => button("Confirm").click());
    await settle();
    expect(dialog()!.textContent).toContain("wait a minute");
  });

  it("the password box is emptied when the dialog closes", async () => {
    render(<UpdatesPage sparks={sparks()} />);
    await flush();
    act(() => button("Install updates").click());
    const input = typePassword("hunter2");
    expect(input.value).toBe("hunter2");
    act(() => button("Cancel").click());
    await flush();
    act(() => button("Install updates").click());
    const again = dialog()!.querySelector('input[type="password"]') as HTMLInputElement;
    expect(again.value).toBe("");
  });

  it("Update all machines posts once and follows the fleet job to its summary line", async () => {
    vi.useFakeTimers();
    try {
      const running: InstallAllJob = {
        id: "f1",
        state: "running",
        startedAt: NOW,
        finishedAt: null,
        units: [
          { sparkId: "s1", sparkName: "Pico", state: "running" },
          { sparkId: "s2", sparkName: "Dell", state: "pending" },
        ],
      };
      const done: InstallAllJob = {
        id: "f1",
        state: "done",
        startedAt: NOW,
        finishedAt: NOW + 9000,
        units: [
          { sparkId: "s1", sparkName: "Pico", state: "done", rebootRequired: true },
          { sparkId: "s2", sparkName: "Dell", state: "needs_confirmation", removals: ["liblegacy0 1.2.3-1"] },
          { sparkId: "s3", sparkName: "Old", state: "skipped-offline" },
          { sparkId: "s4", sparkName: "Busy", state: "error", code: "bad-password", error: "The sudo password was refused." },
        ],
      };
      render(<UpdatesPage sparks={sparks()} />);
      await flush();
      const all = button("Update all machines");
      expect(all.disabled).toBe(false); // the mocked summary says anyUpgradable
      act(() => all.click());
      expect(dialog()).toBeTruthy();
      typePassword("hunter2");
      act(() => button("Confirm").click());
      await flush();
      expect(installAllUpdates).toHaveBeenCalledWith({ sudoPassword: "hunter2" });
      vi.mocked(fetchInstallAllJob).mockResolvedValueOnce({ job: running }).mockResolvedValueOnce({ job: done });
      // The first follow comes early (short runs end within a second), then every second.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(text()).toContain("Installing…");
      expect(text()).toContain("Queued");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(text()).toContain("Updated");
      expect(text()).toContain("Needs confirmation");
      expect(text()).toContain("liblegacy0 1.2.3-1"); // removals listed under the waiting unit
      expect(text()).toContain("Skipped — offline");
      expect(text()).toContain("Failed (bad-password)");
      expect(text()).toContain("Finished: 1 updated, 1 failed, 1 waiting for confirmation, 1 skipped.");
      // With a run gone, the button answers to the summary again.
      expect(button("Update all machines").disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops following when the fleet job vanishes (a restarted dashboard)", async () => {
    vi.useFakeTimers();
    try {
      render(<UpdatesPage sparks={sparks()} />);
      await flush();
      const before = vi.mocked(fetchInstallAllJob).mock.calls.length; // the mount probe
      act(() => button("Update all machines").click());
      typePassword("pw");
      act(() => button("Confirm").click());
      await flush();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400); // the first tick sees { job: null }
      });
      const afterFirstTick = vi.mocked(fetchInstallAllJob).mock.calls.length;
      expect(afterFirstTick).toBe(before + 1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000); // and nothing reschedules forever
      });
      expect(vi.mocked(fetchInstallAllJob).mock.calls.length).toBe(afterFirstTick);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the install job above the update lists while the firmware phase runs", async () => {
    vi.mocked(fetchSparkUpdatesJob).mockResolvedValue({ job: RUNNING_FW_JOB });
    render(<UpdatesPage sparks={sparks()} />);
    await flush();

    const job = installJob();
    expect(job.heading).toBeTruthy();
    // The status is the first section of the unit: above System packages, which is above Firmware.
    expect(before(job.heading, job.systemHeading)).toBe(true);
    expect(before(job.systemHeading, job.firmwareHeading)).toBe(true);
    expect(unitSectionOrder()).toEqual(["h3:Install job", "up-job", "h3:System packages", "up-list", "h3:Firmware", "up-list"]);
    // The rows are the job's own, with their phase names and states — the spinner on the running one.
    expect(job.names).toEqual(["System packages", "Firmware"]);
    expect(job.stateTexts).toEqual(["done", "running"]);
    expect(job.states[0].classList.contains("is-done")).toBe(true);
    expect(job.states[1].querySelector("i.up-spin")).toBeTruthy();
    expect(job.spinners[0]).toBeNull();
    // It is rendered once: the lists below it are the unit's, not a second copy of the job.
    expect(unitPanel().querySelectorAll("ul.up-job")).toHaveLength(1);
    expect(unitPanel().querySelectorAll("h3.up-h3")).toHaveLength(3);
  });

  it("keeps the install job above the update lists when the firmware phase fails", async () => {
    rememberPasswords();
    vi.useFakeTimers();
    try {
      render(<UpdatesPage sparks={sparks()} />);
      await flush();
      // Nothing running: no install status, only the two lists.
      expect(unitPanel().querySelector("ul.up-job")).toBeNull();
      expect(unitSectionOrder()).toEqual(["h3:System packages", "up-list", "h3:Firmware", "up-list"]);

      act(() => button("Install updates").click());
      await flush();
      expect(installSparkUpdates).toHaveBeenCalledWith("s1", {});
      // The job answers with the firmware failure, and stays on screen above the lists.
      vi.mocked(fetchSparkUpdatesJob).mockResolvedValue({ job: ERRORED_FW_JOB });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400); // the first tick of the follow
      });

      const job = installJob();
      expect(before(job.heading, job.systemHeading)).toBe(true);
      expect(unitSectionOrder()).toEqual(["h3:Install job", "up-job", "h3:System packages", "up-list", "h3:Firmware", "up-list"]);
      expect(job.names).toEqual(["System packages", "Firmware"]);
      expect(job.stateTexts).toEqual(["done", "error — fwupdater exited 1"]);
      expect(job.states[1].classList.contains("is-error")).toBe(true);
      expect(job.spinners[1]).toBeNull(); // a finished phase does not spin
      expect(unitPanel().querySelectorAll("ul.up-job")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the failed firmware job's error and code above the System packages heading", async () => {
    // The spark3/spark4 failure: the phase row alone read "error" with an empty note and
    // job.error was rendered nowhere. The reason must be visible, above the lists, with its code.
    rememberPasswords();
    const failedFwJob: UpdateInstallJob = {
      ...ERRORED_FW_JOB,
      error: "fwupdmgr update failed (exit 1): Failed to parse arguments: Unknown option --offline",
      code: "fw-failed",
    };
    vi.useFakeTimers();
    try {
      render(<UpdatesPage sparks={sparks()} />);
      await flush();
      act(() => button("Install updates").click());
      await flush();
      vi.mocked(fetchSparkUpdatesJob).mockResolvedValue({ job: failedFwJob });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400); // the first tick of the follow
      });

      const panel = unitPanel();
      const banners = [...panel.querySelectorAll<HTMLElement>(".up-banner.is-error")];
      expect(banners).toHaveLength(1);
      expect(banners[0].textContent).toContain("fwupdmgr update failed (exit 1)");
      expect(banners[0].textContent).toContain("Failed to parse arguments: Unknown option --offline");
      expect(banners[0].textContent).toContain("(fw-failed)");
      // It is part of the install status: above System packages, not below the lists.
      const job = installJob();
      expect(before(job.heading, banners[0])).toBe(true);
      expect(before(banners[0], job.systemHeading)).toBe(true);
      // And the failing phase still carries its note — the row and the banner tell the same story.
      expect(job.stateTexts[1]).toContain("error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops an install job read for a unit that was replaced while the read was in flight", async () => {
    let release: (result: { job: UpdateInstallJob | null }) => void = () => {};
    vi.mocked(fetchSparkUpdatesJob).mockImplementation((id: string) => {
      if (id === "s1") return new Promise((resolve) => { release = resolve; });
      return Promise.resolve({ job: null });
    });
    render(<UpdatesPage sparks={sparks()} />);
    await flush();
    act(() => button("Dell").click()); // the s1 read is still in flight
    await flush();
    act(() => {
      release({
        job: {
          id: "j9",
          state: "running",
          startedAt: NOW,
          finishedAt: null,
          phases: [{ key: "apt", state: "running" }],
          rebootRequired: false,
          firmwareRebootNeeded: false,
        },
      });
    });
    await settle();
    // Pico's answer arrives after Dell took over: the Install job section never shows for Dell.
    expect(text()).not.toContain("Install job");
  });

  it("the Update all machines button is disabled while nothing is upgradable", async () => {
    vi.mocked(fetchUpdatesSummary).mockResolvedValue({ ...SUMMARY, anyUpgradable: false });
    render(<UpdatesPage sparks={sparks()} />);
    await flush();
    expect(button("Update all machines").disabled).toBe(true);
  });

  it("disabling the DGX Dashboard services posts enabled:false with the password and re-reads", async () => {
    render(<UpdatesPage sparks={sparks()} />);
    await flush();
    expect(text()).toContain("DGX Dashboard");
    expect(text()).toContain("dgx-dashboard.service");
    expect(text()).toContain("dgx-dashboard-admin.service");
    expect(text()).toContain("123 MB RAM"); // Storage's size format, from memoryBytes
    act(() => button("Disable").click());
    expect(dialog()).toBeTruthy();
    typePassword("hunter2");
    act(() => button("Confirm").click());
    await flush();
    expect(setDashboardService).toHaveBeenCalledWith("s1", { enabled: false, sudoPassword: "hunter2" });
    expect(fetchDashboardService).toHaveBeenCalledWith("s1");
  });

  it("the rail shows the Updates item and the warn dot only while something is upgradable", async () => {
    render(
      <AppSidebar
        sparks={[makeSpark("s1")]}
        activeId={null}
        onSelect={() => {}}
        onAdd={() => {}}
        onOpenSettings={() => {}}
        onOpenSearch={() => {}}
        connected={false}
        updatesWarn
      />
    );
    await flush();
    const link = document.querySelector('a[href="/updates"]') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.textContent).toContain("Updates");
    expect(link.querySelector("i.sdot--warn")).toBeTruthy();
  });

  it("the rail Updates item carries no dot when nothing is upgradable (or before the first summary)", async () => {
    render(
      <AppSidebar
        sparks={[makeSpark("s1")]}
        activeId={null}
        onSelect={() => {}}
        onAdd={() => {}}
        onOpenSettings={() => {}}
        onOpenSearch={() => {}}
        connected={false}
      />
    );
    await flush();
    const link = document.querySelector('a[href="/updates"]') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.querySelector("i.sdot--warn")).toBeNull();
  });
});
