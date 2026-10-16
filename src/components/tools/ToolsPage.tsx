import type { SparkSnapshot } from "../../api/types";
import { ReaToolPage } from "../ReaPage/ReaPage";
import { toolTypeById } from "./toolsCatalog";
import { ToolsPageShell } from "./ToolsPageShell";
import { useToolsSpark } from "./useToolsSpark";

interface ToolsPageProps {
  type: string;
  sparks: readonly SparkSnapshot[];
}

/** Router for the tool pages: shared header + unit picker, then the page for this tool type. */
export function ToolsPage({ type, sparks }: ToolsPageProps) {
  const { spark, select, eligible } = useToolsSpark(sparks);
  const tool = toolTypeById(type);
  let body;
  if (!tool) body = <p className="page-stub">Unknown tool.</p>;
  else body = <ReaToolPage spark={spark} sparks={eligible} />;
  return (
    <ToolsPageShell type={type} spark={spark} sparks={eligible} onSelectSpark={select}>
      {body}
    </ToolsPageShell>
  );
}
