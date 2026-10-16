import { afterEach, describe, expect, it, vi } from "vitest";
import { ENERGY_ID, OVERVIEW_ID, TEMPS_ID, TOOLS_PREFIX, benchId, benchTypeOf, idToPath, initialActiveId, isPageId, isStaleSparkId, pathToId, toolId, toolTypeOf } from "./constants";

describe("route helpers", () => {
  it("round-trips ids and paths", () => {
    expect(pathToId("/energy")).toBe(ENERGY_ID);
    expect(pathToId("/temps")).toBe(TEMPS_ID);
    expect(idToPath(TEMPS_ID)).toBe("/temps");
    expect(pathToId("/spark/a%20b")).toBe("a b");
    expect(idToPath("a b")).toBe("/spark/a%20b");
    expect(pathToId(idToPath(benchId("decode")))).toBe(benchId("decode"));
    expect(pathToId("/showcase/x")).toBeNull();
    expect(pathToId("/nothing-here")).toBe(OVERVIEW_ID);
  });

  it("VulnHunter is a benchmark page; the old /security link lands on it", () => {
    expect(idToPath(benchId("vulnhunt"))).toBe("/bench/vulnhunt");
    expect(pathToId("/bench/vulnhunt")).toBe(benchId("vulnhunt"));
    expect(pathToId("/security")).toBe(benchId("vulnhunt"));
    expect(pathToId("/security/")).toBe(benchId("vulnhunt"));
    expect(isPageId(benchId("vulnhunt"))).toBe(true);
    expect(isStaleSparkId(benchId("vulnhunt"), [], true)).toBe(false);
  });

  it("tool pages round-trip through ids and /tools/<type> paths", () => {
    expect(toolId("rea")).toBe(`${TOOLS_PREFIX}rea`);
    expect(toolTypeOf(toolId("rea"))).toBe("rea");
    expect(toolTypeOf(benchId("rea"))).toBeNull();
    expect(benchTypeOf(toolId("rea"))).toBeNull();
    expect(toolTypeOf(null)).toBeNull();
    expect(idToPath(toolId("rea"))).toBe("/tools/rea");
    expect(pathToId("/tools/rea")).toBe(toolId("rea"));
    expect(pathToId("/tools/rea/")).toBe(toolId("rea"));
    expect(pathToId(idToPath(toolId("some-new-tool")))).toBe(toolId("some-new-tool"));
    expect(isPageId(toolId("rea"))).toBe(true);
    expect(isPageId("rea")).toBe(false);
  });

  it("an unknown tool type still resolves to a tool id (the page says Unknown tool); bare /tools is the Overview", () => {
    expect(pathToId("/tools/nope")).toBe(toolId("nope"));
    expect(pathToId("/tools")).toBe(OVERVIEW_ID);
    expect(pathToId("/tools/a/b")).toBe(OVERVIEW_ID);
  });

  it("tool ids are never stale Spark ids", () => {
    expect(isStaleSparkId(toolId("rea"), [], true)).toBe(false);
    expect(isStaleSparkId(toolId("nope"), ["a"], true)).toBe(false);
  });

  describe("initialActiveId", () => {
    afterEach(() => vi.unstubAllGlobals());
    it("reads the deep link synchronously, so /energy never starts on the Overview", () => {
      vi.stubGlobal("location", { pathname: "/energy" });
      expect(initialActiveId()).toBe(ENERGY_ID);
      vi.stubGlobal("location", { pathname: "/security" });
      expect(initialActiveId()).toBe(benchId("vulnhunt"));
      vi.stubGlobal("location", { pathname: "/spark/alpha" });
      expect(initialActiveId()).toBe("alpha");
    });
    it("a reload on /tools/rea lands on the tool, never the Overview", () => {
      vi.stubGlobal("location", { pathname: "/tools/rea" });
      expect(initialActiveId()).toBe(toolId("rea"));
      expect(isStaleSparkId(initialActiveId(), [], true)).toBe(false);
    });
    it("falls back to the Overview for showcase paths or a missing pathname", () => {
      vi.stubGlobal("location", { pathname: "/showcase/alpha" });
      expect(initialActiveId()).toBe(OVERVIEW_ID);
      vi.stubGlobal("location", {});
      expect(initialActiveId()).toBe(OVERVIEW_ID);
    });
  });

  describe("isStaleSparkId", () => {
    it("flags a Spark that left the fleet, once the fleet is known", () => {
      expect(isStaleSparkId("gone", ["a", "b"], true)).toBe(true);
      expect(isStaleSparkId("a", ["a", "b"], true)).toBe(false);
    });
    it("never flags pages, the Overview, or anything before the first fleet list", () => {
      expect(isStaleSparkId(ENERGY_ID, [], true)).toBe(false);
      expect(isStaleSparkId(benchId("decode"), [], true)).toBe(false);
      expect(isStaleSparkId(OVERVIEW_ID, [], true)).toBe(false);
      expect(isStaleSparkId(null, [], true)).toBe(false);
      expect(isStaleSparkId("gone", [], false)).toBe(false);
    });
  });
});
