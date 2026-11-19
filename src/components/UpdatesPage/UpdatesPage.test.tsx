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
}));

const NOW = 1_800_000_000_000;
const H = 3_600_000;

const SUMMARY: UpdateSummary = {
  now: NOW,
  sparks: [
    { id: "s1", name: "Pico", online: true, state: "ok", aptCount: 3, fwCount: 1, rebootRequired: true, firmwareRebootNeeded: false, checkedAt: NOW - 3 * H, indexAutoRefresh: "stored-password" },
    { id: "s2", name: "Dell", online: true, state: "ok", aptCount: 0, fwCount: 0, rebootRequired: false, firmwareRebootNeeded: false, checkedAt: NOW - 60_000, indexAutoRefresh: "stored-password" },
  ],
  anyUpgradable: true,
};

const DETAIL: SparkUpdateDetail = {
  now: NOW,
  sparkId: "s1",
  state: "ok",
  checkedAt: NOW - 3 * H,
  index: { refreshedAt: NOW - 2 * H },
  indexAutoRefresh: "stored-password",
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

const DASH: DashboardServiceStatus = {
  units: [
    { unit: "dgx-dashboard.service", enabled: "enabled", active: "active", memoryBytes: 123 * 1024 * 1024, mainPid: 4242 },
    { unit: "dgx-dashboard-admin.service", enabled: "enabled", active: "inactive", memoryBytes: null, mainPid: null },
  ],
  now: NOW,
};

const sparks = (): SparkSnapshot[] => [
  { ...makeSpark("s1"), name: "Pico" },
  { ...makeSpark("s2"), name: "Dell" },
];

const text = () => document.body.textContent ?? "";
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
    expect(refreshSparkUpdates).toHaveBeenCalledWith("s1", "hunter2", false);
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

  it("the unit panel says when the daily index refresh runs only as a sudo-free check", async () => {
    vi.mocked(fetchSparkUpdates).mockResolvedValue({ ...DETAIL, indexAutoRefresh: "check-only" });
    render(<UpdatesPage sparks={sparks()} />);
    await flush();
    expect(text()).toContain("daily refresh off — no stored sudo password");
    vi.mocked(fetchSparkUpdates).mockResolvedValue(DETAIL);
    act(() => button("Check now").click());
    await flush();
    expect(text()).not.toContain("daily refresh off");
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
      expect(installAllUpdates).toHaveBeenCalledWith("hunter2");
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
