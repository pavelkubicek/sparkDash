import { toolId } from "../../constants";
import type { PaletteCommand } from "../shell/CommandPalette";
import { MicroscopeIcon } from "../ui/icons";
import { TOOL_TYPES } from "./toolsCatalog";

/** "Go to → <tool>" palette entries, one per tool type. */
export function toolPaletteCommands(navigate: (id: string) => void): PaletteCommand[] {
  return TOOL_TYPES.map((t) => ({
    id: `tool:${t.id}`,
    group: "Go to",
    label: t.label,
    hint: "Tool",
    icon: <MicroscopeIcon className="h-4 w-4" />,
    keywords: `tool tools ${t.id} ${t.blurb} reverse engineering binary analysis`,
    run: () => navigate(toolId(t.id)),
  }));
}
