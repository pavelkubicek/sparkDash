import { describe, expect, it } from "vitest";
import { primaryDecodeTps, railSubLabel, updatesDotTone } from "./sparkSummary";
import { makeSpark } from "../../testing/fixtures";
import type { UpdateSummaryUnit } from "../../api/types";

function withLlm(overrides: Record<string, unknown>) {
  const spark = makeSpark();
  Object.assign(spark.metrics.llm[0], { available: true, ...overrides });
  return spark;
}

describe("sparkSummary with an engine whose stats could not be read", () => {
  it("shows no decode rate on the rail instead of 0.0", () => {
    const spark = withLlm({ generationTps: 0, measurementValid: false });
    expect(primaryDecodeTps(spark)).toBeNull();
    expect(railSubLabel(spark)).toBe("—");
  });

  it("still shows a readable idle engine as 0.0", () => {
    const spark = withLlm({ generationTps: 0, measurementValid: true });
    expect(primaryDecodeTps(spark)).toBe(0);
    expect(railSubLabel(spark)).toBe("0.0");
  });
});

function makeUnit(overrides: Partial<UpdateSummaryUnit> = {}): UpdateSummaryUnit {
  return {
    id: "u",
    name: "Unit",
    online: true,
    state: "ok",
    aptCount: 0,
    fwCount: 0,
    rebootRequired: false,
    firmwareRebootNeeded: false,
    checkedAt: 0,
    indexAutoRefresh: "check-only",
    sudoSaved: false,
    ...overrides,
  };
}

describe("updatesDotTone", () => {
  it("is red when a firmware update is pending", () => {
    expect(updatesDotTone([makeUnit({ fwCount: 2 })])).toBe("bad");
  });

  it("is red when a staged firmware update only waits for a reboot", () => {
    expect(updatesDotTone([makeUnit({ firmwareRebootNeeded: true })])).toBe("bad");
  });

  it("is yellow when only apt packages are pending", () => {
    expect(updatesDotTone([makeUnit({ aptCount: 3 })])).toBe("warn");
  });

  it("is yellow when only the OS asks for a reboot", () => {
    expect(updatesDotTone([makeUnit({ rebootRequired: true })])).toBe("warn");
  });

  it("is null when nothing is pending", () => {
    expect(updatesDotTone([makeUnit()])).toBeNull();
  });

  it("ignores offline units no matter what they reported", () => {
    expect(updatesDotTone([makeUnit({ online: false, aptCount: 5, fwCount: 5, rebootRequired: true, firmwareRebootNeeded: true })])).toBeNull();
  });

  it("is null before the first summary answers", () => {
    expect(updatesDotTone(undefined)).toBeNull();
    expect(updatesDotTone(null)).toBeNull();
    expect(updatesDotTone([])).toBeNull();
  });

  it("red wins over yellow across units", () => {
    expect(updatesDotTone([makeUnit({ id: "a", aptCount: 3 }), makeUnit({ id: "b", fwCount: 1 })])).toBe("bad");
    // Order the other way round: the apt-only unit answers first, firmware still wins.
    expect(updatesDotTone([makeUnit({ id: "b", fwCount: 1 }), makeUnit({ id: "a", aptCount: 3 })])).toBe("bad");
  });
});
