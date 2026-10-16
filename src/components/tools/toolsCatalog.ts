/**
 * Every tool sparkDash has a page for (sidebar "Tools" section, above "Benchmarks").
 * Same shape discipline as benchCatalog.ts: append an entry here, add its page in ToolsPage.tsx.
 * `engine` says what runs it on the unit.
 */
export type ToolEngine = "rea";

export interface ToolType {
  id: string;
  label: string;
  /** One line shown under the page title and in the palette. */
  blurb: string;
  engine: ToolEngine;
}

export const TOOL_TYPES: readonly ToolType[] = [
  {
    id: "rea",
    label: "REA",
    blurb: "Reverse-engineering analysis of a binary or app on the unit: static inspection, layout, native functions and JavaScript bundles.",
    engine: "rea",
  },
];

const BY_ID = new Map(TOOL_TYPES.map((t) => [t.id, t]));

export function toolTypeById(id: string | null | undefined): ToolType | null {
  return (id && BY_ID.get(id)) || null;
}

/** localStorage key remembering which Spark the tool pages act on. */
export const TOOLS_SPARK_KEY = "sparkdash.tools.spark";
