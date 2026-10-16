import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ReaJob, ReaLine } from "../../api/types";
import { render } from "../../testing/render";
import { ghidraData, setupData, statusData } from "./fixtures";
import type { InstallState } from "./hooks";
import { SetupCard } from "./SetupCard";

const job = (over: Partial<ReaJob> = {}): ReaJob => ({
  id: "j1",
  sparkId: "s1",
  status: "running",
  exitCode: null,
  startedAt: 1,
  finishedAt: null,
  error: null,
  ...over,
});

const install = (over: Partial<InstallState> = {}): InstallState => ({
  job: null,
  lines: [],
  partial: "",
  error: null,
  starting: false,
  running: false,
  start: vi.fn().mockResolvedValue(true),
  ...over,
});

const mount = (p: Partial<React.ComponentProps<typeof SetupCard>> = {}) =>
  render(
    <SetupCard
      unitName="spark-1"
      setup={setupData()}
      setupError={null}
      status={statusData({ installed: false, version: null, upToDate: false })}
      statusError={null}
      loading={false}
      install={install()}
      onRecheck={vi.fn()}
      {...p}
    />
  );

const button = (c: HTMLElement, text: RegExp) => Array.from(c.querySelectorAll("button")).find((b) => text.test(b.textContent ?? ""));

describe("SetupCard", () => {
  it("offers the one-click install of the pinned version and starts it", () => {
    const i = install();
    const { container } = mount({ install: i });
    const b = button(container, /Install REA 6\.4\.0/)!;
    expect(b.disabled).toBe(false);
    act(() => b.click());
    expect(i.start).toHaveBeenCalledTimes(1);
  });

  it("blocks the install while the opt-in is off, with the reason", () => {
    const { container } = mount({ setup: setupData({ enabled: false, startAllowed: false }) });
    expect(button(container, /Install REA/)!.disabled).toBe(true);
    expect(container.textContent).toContain("REA is turned off");
  });

  it("blocks the install when node is too old and cannot be fetched, and says why", () => {
    const { container } = mount({
      status: statusData({ node: { path: "/usr/bin/node", version: "20.1.0", ok: false, installable: false, installReason: "tar is not installed" }, installed: false }),
    });
    expect(button(container, /Install REA/)!.disabled).toBe(true);
    expect(container.textContent).toContain("Node.js 20.1.0 is older than 22.19");
    expect(container.textContent).toContain("tar is not installed");
  });

  it("offers the install when node is missing but the installer can fetch it, and says it will", () => {
    const { container } = mount({
      status: statusData({ node: { path: null, version: null, ok: false, installable: true, installVersion: "22.23.3" }, npm: false, installed: false }),
    });
    expect(button(container, /Install REA/)!.disabled).toBe(false);
    expect(container.textContent).toContain("will also set up Node.js 22.23.3");
    expect(container.textContent).toContain("SHA-256");
  });

  it.each([
    [127, /npm was not found next to the Node\.js/],
    [3, /A download failed/],
    [4, /checksum pinned/],
    [5, /cannot get Node\.js/],
    [6, /could not be unpacked/],
  ])("explains install exit code %i", (code, re) => {
    const lines: ReaLine[] = [{ seq: 1, text: "npm ERR! something" }];
    const { container } = mount({ install: install({ job: job({ status: "failed", exitCode: code }), lines }) });
    expect(container.textContent).toMatch(re);
    expect(container.textContent).toContain(`exit code ${code}`);
    expect(container.textContent).toContain("npm ERR! something");
  });

  it("streams output while running and shows doctor remediation, providers and engines", () => {
    const lines: ReaLine[] = [{ seq: 1, text: "added 144 packages" }];
    const status = statusData({
      doctor: { healthy: false, checks: [{ name: "node-pty", ok: false, classification: "environment", detail: "no prebuilt", remediation: "Reinstall REA." }] },
    });
    const { container } = mount({ status, install: install({ job: job(), lines, running: true }) });
    expect(container.textContent).toContain("added 144 packages");
    expect(container.textContent).toContain("Installing…");
    expect(container.textContent).toContain("Fix: Reinstall REA.");
    expect(container.textContent).toContain("Ghidra");
    expect(container.textContent).toContain("Android resource decoding.");
    expect(container.textContent).toContain("not sandboxed");
  });

  it("keeps agent-client registrations and optional engines out of the needs-attention verdict", () => {
    const checks = [
      { name: "node", ok: true, classification: "environment", detail: "22.23.1" },
      { name: "hopper", ok: false, classification: "missing_analysis_engine", remediation: "Run rea setup to install Hopper." },
      { name: "skill:identity", ok: false, classification: "config_drift", remediation: "Run rea setup to update the installed REA skill." },
      { name: "registration:claude_code", ok: false, classification: "config_drift", remediation: "Run rea setup to refresh this registration." },
    ];
    const { container } = mount({ status: statusData({ doctor: { healthy: false, checks } }) });
    const doctor = container.querySelector(".rea-doctor")!.closest("section")!;
    expect(doctor.textContent).toContain("healthy");
    expect(doctor.textContent).not.toContain("needs attention");
    expect(doctor.querySelectorAll("details")).toHaveLength(2);
    // the failing-looking ones are only inside the collapsed groups, never in the main list
    expect(doctor.querySelector(":scope > .rea-doctor")!.textContent).not.toContain("registration:");
    expect(doctor.textContent).toContain("never runs rea setup");
  });

  describe("Ghidra", () => {
    const withGhidra = (g: Parameters<typeof ghidraData>[0], extra: Partial<React.ComponentProps<typeof SetupCard>> = {}) => {
      const gi = install();
      const r = mount({ status: statusData({ ghidra: ghidraData(g) }), ghidraInstall: gi, ...extra });
      return { ...r, gi };
    };

    it("offers the install with an honest account of what it does, and starts only the Ghidra job", () => {
      const { container, gi } = withGhidra({});
      const text = container.textContent ?? "";
      expect(text).toContain("not installed");
      expect(text).toContain("about 570 MB");
      expect(text).toContain("Temurin 21");
      expect(text).toContain("Builds Ghidra's native decompiler on the unit (aarch64)");
      expect(text).toContain("g++");
      expect(text).toContain("GHIDRA_INSTALL_DIR");
      const b = button(container, /Install Ghidra 12\.1\.4/)!;
      expect(b.disabled).toBe(false);
      act(() => b.click());
      expect(gi.start).toHaveBeenCalledTimes(1);
    });

    it("does not mention the decompiler build on x86_64 or the JDK download when Java 21 is there", () => {
      const { container } = withGhidra({ arch: "x86_64", javaMajor: 21 });
      const text = container.textContent ?? "";
      expect(text).not.toContain("Builds Ghidra's native decompiler");
      expect(text).toContain("Uses the JDK 21+ already on the unit");
    });

    it("shows a ready Ghidra without an install button", () => {
      const { container } = withGhidra({ dir: "/home/mia/.local/share/sparkdash/ghidra/12.1.4", version: "12.1.4", nativeOk: true, javaMajor: 21, managed: true });
      expect(container.textContent).toContain("Ghidra 12.1.4 with Java 21");
      expect(container.textContent).toContain("by this dashboard");
      expect(button(container, /Install Ghidra/)).toBeUndefined();
      expect(button(container, /Replace it with/)).toBeUndefined();
    });

    it("says why an existing Ghidra is unusable and offers to replace it", () => {
      const { container } = withGhidra({ dir: "/opt/ghidra", version: "11.3.1", nativeOk: false, javaMajor: 17 });
      const text = container.textContent ?? "";
      expect(text).toContain("is not in the 12.1.x line");
      expect(text).toContain("native decompiler is missing");
      expect(text).toContain("Java 17 is too old");
      expect(button(container, /Replace it with Ghidra 12\.1\.4/)).toBeDefined();
    });

    it("blocks the install with the unit's reason (missing compiler) and when disk is short", () => {
      const a = withGhidra({ installable: false, installReason: "g++ and make are needed to build Ghidra's decompiler for this CPU" });
      expect(button(a.container, /Install Ghidra/)!.disabled).toBe(true);
      expect(a.container.textContent).toContain("g++ and make are needed");
      const b = withGhidra({ freeKib: 700 * 1024 });
      expect(button(b.container, /Install Ghidra/)!.disabled).toBe(true);
      expect(b.container.textContent).toContain("Only 700 MiB are free");
    });

    it("is blocked while the REA install runs, and blocks the REA install while it runs", () => {
      const a = withGhidra({}, { install: install({ running: true, job: job() }) });
      expect(button(a.container, /Install Ghidra/)!.disabled).toBe(true);
      const b = mount({
        status: statusData({ installed: false, version: null, upToDate: false, ghidra: ghidraData() }),
        ghidraInstall: install({ running: true, job: job() }),
      });
      expect(button(b.container, /Install REA/)!.disabled).toBe(true);
      expect(button(b.container, /Re-check/)!.disabled).toBe(true);
    });

    it.each([
      [3, /github\.com/],
      [4, /checksum pinned/],
      [5, /g\+\+ and make on ARM/],
      [6, /native decompiler could not be built/],
    ])("explains Ghidra install exit code %i with Ghidra wording, not the Node.js one", (code, re) => {
      const { container } = withGhidra({}, { ghidraInstall: install({ job: job({ status: "failed", exitCode: code }), lines: [{ seq: 1, text: "[sparkdash] boom" }] }) });
      expect(container.textContent).toMatch(re);
      expect(container.textContent).toContain(`exit code ${code}`);
      expect(container.textContent).not.toContain("Node.js from nodejs.org");
    });

    it("shows nothing when the status carries no Ghidra block (older server)", () => {
      const { container } = mount({ status: statusData({ ghidra: undefined }), ghidraInstall: install() });
      expect(container.textContent).not.toContain("Install Ghidra");
    });
  });

  it("shows ready and Re-check calls back", () => {
    const onRecheck = vi.fn();
    const { container } = mount({ status: statusData(), onRecheck });
    expect(container.textContent).toContain("Ready");
    expect(button(container, /Install REA/)).toBeUndefined();
    act(() => button(container, /Re-check/)!.click());
    expect(onRecheck).toHaveBeenCalled();
  });
});
