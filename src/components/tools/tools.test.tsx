import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toolId } from "../../constants";
import { makeSpark } from "../../testing/fixtures";
import { render, cleanupRenders } from "../../testing/render";
import { TOOLS_SPARK_KEY, TOOL_TYPES, toolTypeById } from "./toolsCatalog";
import { ToolsPage } from "./ToolsPage";
import { toolPaletteCommands } from "./toolsPalette";

beforeEach(() => localStorage.clear());
afterEach(() => cleanupRenders());

describe("toolsCatalog", () => {
  it("lists REA first and looks tools up by id", () => {
    expect(TOOL_TYPES[0].id).toBe("rea");
    expect(toolTypeById("rea")?.label).toBe("REA");
    expect(toolTypeById("nope")).toBeNull();
    expect(toolTypeById(null)).toBeNull();
  });
});

describe("ToolsPage", () => {
  it("shows the Tools eyebrow, the title and a Run on picker; picking a unit is remembered", () => {
    const { container } = render(<ToolsPage type="rea" sparks={[makeSpark("a"), makeSpark("b")]} />);
    expect(container.querySelector(".eyebrow")?.textContent).toBe("Tools");
    expect(container.querySelector("h1")?.textContent).toBe("REA");
    const chips = [...container.querySelectorAll<HTMLButtonElement>(".bench-runon__chip")];
    expect(chips).toHaveLength(2);
    act(() => chips[1].click());
    expect(localStorage.getItem(TOOLS_SPARK_KEY)).toBe("b");
    expect(container.querySelectorAll(".bench-runon__chip")[1].getAttribute("aria-pressed")).toBe("true");
  });

  it("an unknown tool type renders a safe Unknown tool page", () => {
    const { container } = render(<ToolsPage type="nope" sparks={[makeSpark("a")]} />);
    expect(container.querySelector("h1")?.textContent).toBe("Unknown tool");
    expect(container.textContent).toContain("Unknown tool.");
    expect(container.querySelector(".bench-runon")).toBeNull();
  });
});

describe("palette", () => {
  it("offers Go to > REA and navigates to the tool id", () => {
    const seen: string[] = [];
    const cmds = toolPaletteCommands((id) => seen.push(id));
    expect(cmds).toHaveLength(1);
    expect(cmds[0].group).toBe("Go to");
    expect(cmds[0].label).toBe("REA");
    expect(cmds[0].keywords).toContain("reverse engineering");
    cmds[0].run();
    expect(seen).toEqual([toolId("rea")]);
  });
});
