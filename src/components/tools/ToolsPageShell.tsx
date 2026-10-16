import type { ReactNode } from "react";
import type { SparkSnapshot } from "../../api/types";
import { SparkChips } from "../bench/SparkChips";
import { toolTypeById } from "./toolsCatalog";

interface ToolsPageShellProps {
  type: string;
  spark: SparkSnapshot | null;
  sparks: readonly SparkSnapshot[];
  onSelectSpark: (id: string) => void;
  children: ReactNode;
}

/** Common header for every tool page: eyebrow, title and blurb, then a "Run on" unit picker. */
export function ToolsPageShell({ type, spark, sparks, onSelectSpark, children }: ToolsPageShellProps) {
  const tool = toolTypeById(type);
  return (
    <div className="bench-page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Tools</div>
          <h1>{tool?.label ?? "Unknown tool"}</h1>
          {tool ? <p className="page-head__sub">{tool.blurb}</p> : null}
        </div>
      </div>
      {tool ? (
        <div className="bench-runon">
          <span className="eyebrow">Run on</span>
          {sparks.length === 0 ? <span className="bench-runon__none">No units available</span> : null}
          <SparkChips sparks={sparks} activeId={spark?.id ?? null} onSelect={onSelectSpark} ariaLabel="Unit to run the tool on" />
        </div>
      ) : null}
      {children}
    </div>
  );
}
