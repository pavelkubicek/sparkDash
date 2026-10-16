import { afterEach, describe, expect, it, vi } from "vitest";
import { stopVulnHuntScan } from "./client";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("stopVulnHuntScan", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("resolves when the unit stopped the scan", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ success: true, output: "stopped" })));
    await expect(stopVulnHuntScan("s1", "vh-1")).resolves.toMatchObject({ success: true });
  });

  it("rejects when the server answers 200 with success:false, instead of reporting a stop that did not happen", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ success: false, output: "ssh: connect to host x port 22: Connection refused" })));
    await expect(stopVulnHuntScan("s1", "vh-1")).rejects.toThrow(/did not stop the scan: ssh/);
  });

  it("explains a scan that was not running", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ success: false, output: "not running" })));
    await expect(stopVulnHuntScan("s1", "vh-1")).rejects.toThrow(/not running/);
  });
});
