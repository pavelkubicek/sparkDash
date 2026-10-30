import { describe, expect, it } from "vitest";
import {
  defaultGpuClockSchedule,
  formatGpuClockSpec,
  formatGpuClockWindows,
  gpuClockCapAt,
  normalizeGpuClockSchedule,
  parseGpuClockWindows,
  validateGpuClockSchedule,
} from "./gpuClockSchedule.js";

const DAY_NIGHT = {
  enabled: true,
  tz: "Europe/Prague",
  windows: [
    { start: "08:00", end: "20:00", maxMHz: 2200 },
    { start: "20:00", end: "08:00", maxMHz: 1900 },
  ],
};

/** Prague is UTC+1 in January and UTC+2 in July. */
const utc = (iso: string) => Date.parse(iso);

describe("gpuClockCapAt", () => {
  it("switches at 08:00 and 20:00 local time, half-open", () => {
    expect(gpuClockCapAt(DAY_NIGHT, utc("2026-01-15T06:59:00Z"))?.maxMHz).toBe(1900); // 07:59
    expect(gpuClockCapAt(DAY_NIGHT, utc("2026-01-15T07:00:00Z"))?.maxMHz).toBe(2200); // 08:00
    expect(gpuClockCapAt(DAY_NIGHT, utc("2026-01-15T18:59:00Z"))?.maxMHz).toBe(2200); // 19:59
    expect(gpuClockCapAt(DAY_NIGHT, utc("2026-01-15T19:00:00Z"))?.maxMHz).toBe(1900); // 20:00
  });

  it("follows the zone across DST instead of the host clock", () => {
    // July: 08:00 local is 06:00 UTC.
    expect(gpuClockCapAt(DAY_NIGHT, utc("2026-07-15T05:59:00Z"))?.maxMHz).toBe(1900);
    expect(gpuClockCapAt(DAY_NIGHT, utc("2026-07-15T06:00:00Z"))?.maxMHz).toBe(2200);
  });

  it("names the next switch and its cap", () => {
    const at = gpuClockCapAt(DAY_NIGHT, utc("2026-01-15T07:00:00Z"));
    expect(at?.nextChangeMHz).toBe(1900);
    expect(at?.nextChangeAt).toBe(utc("2026-01-15T19:00:00Z"));
  });
});

describe("validateGpuClockSchedule", () => {
  it("accepts the shipped schedule and the two-window tiling", () => {
    expect(validateGpuClockSchedule(defaultGpuClockSchedule()).ok).toBe(true);
    expect(validateGpuClockSchedule(DAY_NIGHT).ok).toBe(true);
  });

  it("rejects gaps, overlaps, duplicate windows and bad values", () => {
    expect(validateGpuClockSchedule({ ...DAY_NIGHT, windows: [{ start: "08:00", end: "20:00", maxMHz: 2200 }] }).errors)
      .toContain("windows must cover every minute of the day without gaps.");
    expect(
      validateGpuClockSchedule({
        ...DAY_NIGHT,
        windows: [
          { start: "08:00", end: "20:00", maxMHz: 2200 },
          { start: "19:00", end: "08:00", maxMHz: 1900 },
        ],
      }).ok,
    ).toBe(false);
    expect(
      validateGpuClockSchedule({
        ...DAY_NIGHT,
        windows: [
          { start: "08:00", end: "20:00", maxMHz: 2200 },
          { start: "08:00", end: "20:00", maxMHz: 1900 },
        ],
      }).ok,
    ).toBe(false);
    expect(validateGpuClockSchedule({ ...DAY_NIGHT, tz: "Nowhere/Land" }).ok).toBe(false);
    expect(validateGpuClockSchedule({ ...DAY_NIGHT, windows: [{ start: "00:00", end: "00:00", maxMHz: 100 }] }).ok).toBe(
      false,
    );
  });

  it("clamps a damaged persisted config back to usable defaults", () => {
    const cfg = normalizeGpuClockSchedule({ enabled: true, tz: "nope", windows: [{ start: "x" }] });
    expect(cfg.enabled).toBe(true);
    expect(cfg.tz).toBe(defaultGpuClockSchedule().tz);
    expect(cfg.windows).toEqual(defaultGpuClockSchedule().windows);
  });
});

describe("spec and status encoding", () => {
  it("round-trips windows through the compact status form", () => {
    const compact = formatGpuClockWindows([
      { startMin: 480, endMin: 1200, maxMHz: 2200 },
      { startMin: 1200, endMin: 480, maxMHz: 1900 },
    ]);
    expect(compact).toBe("480:1200:2200,1200:480:1900");
    expect(parseGpuClockWindows(compact)).toEqual(DAY_NIGHT.windows);
  });

  it("writes the spec the unit reads", () => {
    expect(formatGpuClockSpec(DAY_NIGHT)).toBe("TZ=Europe/Prague\n480 1200 2200\n1200 480 1900\n");
  });
});
