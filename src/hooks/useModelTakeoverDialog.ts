import { useSyncExternalStore } from "react";
import type { ModelTakeoverIncumbent } from "../api/modelTypes";

/**
 * Single-slot store controlling the model takeover (choice) dialog.
 *
 * Module-global on purpose — same reasoning as useModelCommandDialog: any
 * card's Start/Restart can hit a 409 takeover-confirm, and the dialog is
 * mounted exactly once in App.tsx. The dialog is the operator's choice:
 * stop the named models (they share Sparks with the target) or cancel —
 * canceling starts nothing.
 */
export interface ModelTakeoverTarget {
  modelId: string;
  modelName: string;
  /** The refused click — re-posted with confirmTakeover on "Stop and start". */
  action: "start" | "restart";
  /** Running models that occupy the target's Sparks and must be stopped. */
  incumbents: ModelTakeoverIncumbent[];
  /** Sparks the target occupies, for the dialog's "needs these units" line. */
  targetSparks?: { id: string; name: string }[];
}

let target: ModelTakeoverTarget | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function openModelTakeoverDialog(t: ModelTakeoverTarget) {
  target = t;
  emit();
}

export function closeModelTakeoverDialog() {
  target = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ModelTakeoverTarget | null {
  return target;
}

export function useModelTakeoverDialog(): ModelTakeoverTarget | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
