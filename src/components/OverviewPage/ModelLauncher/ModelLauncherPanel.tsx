import { useCallback, useEffect, useState } from "react";
import type { WsSnapshot } from "../../../api/types";
import type { ModelInfo, SchedulerStatus } from "../../../api/modelTypes";
import {
  clearSchedulerOverride,
  refreshModels,
  setModelOrder,
  updateSchedulerConfig,
} from "../../../api/modelClient";
import { Panel } from "../../ui/Panel";
import { BoltIcon, CalendarIcon, PlusIcon, RotateIcon } from "../../ui/icons";
import { ModelCard } from "./ModelCard";
import { openNewModelDialog } from "../../../hooks/useModelEditDialog";

interface ModelLauncherPanelProps {
  /** `models` block from the WS snapshot (undefined until the first one). */
  models: WsSnapshot["models"] | null | undefined;
  /** WS socket state — the models block only ever arrives over it. */
  connected: boolean;
}

/** "in 42 min" / "in 1 h 40 min" from an absolute epoch ms. */
function countdown(epochMs: number, nowMs: number): string {
  const mins = Math.max(0, Math.round((epochMs - nowMs) / 60_000));
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

/**
 * Half-width Overview card: one card per model repo, each with a
 * colour-swapped Start/Stop, Restart, and (running-only) Logs. It is the 4th
 * child of the integration-cards grid (AI Proxy + Orchestrator / Auditor +
 * Model Launcher), so it is ~50% wide; the model list is a single column
 * capped at ~2 cards tall and scrolls (slim themed scrollbar).
 *
 * Data path: the `models` block rides the existing WS snapshot — no second
 * socket and no polling loop here. Actions just POST and then let the next
 * snapshot plus the job transcript describe the result. Panel chrome and the
 * graceful-degrade behaviour follow OrchestratorPanel.
 */
export function ModelLauncherPanel({ models, connected }: ModelLauncherPanelProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const rawList: ModelInfo[] = models?.models ?? [];
  // The registry already stores the array in `position` order; sort again so a
  // stale/hand-edited payload still renders qwen → deepseek → glm rather than
  // trusting the wire order. Stable: models without a position keep server order.
  const list: ModelInfo[] = rawList.every((m) => m.position == null)
    ? rawList
    : [...rawList].sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9));
  const scheduler: SchedulerStatus | null = models?.scheduler ?? null;
  const activeJob = models?.activeJob ?? null;

  /**
   * Move one card a single slot up (-1) or down (1) and persist the new order
   * via PUT /api/models/order. Fire-and-forget: the next WS snapshot confirms
   * (or silently reverts) — nothing local is trusted.
   */
  const handleMove = useCallback(
    (id: string, dir: -1 | 1) => {
      const ids = list.map((m) => m.id);
      const from = ids.indexOf(id);
      const to = from + dir;
      if (from === -1 || to < 0 || to >= ids.length) return;
      const next = [...ids];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      void setModelOrder(next).catch(() => {
        /* a rejected order simply never arrives through the snapshot */
      });
    },
    [list]
  );

  // The countdown is rendered from a local clock so the payload itself can
  // carry a fixed epochMs — that is what keeps the WS payload byte-stable.
  const boundaryMs = scheduler?.nextBoundary?.epochMs ?? null;
  useEffect(() => {
    if (boundaryMs == null) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [boundaryMs]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshModels();
    } catch {
      /* the next snapshot reflects it anyway */
    } finally {
      setRefreshing(false);
    }
  }, []);

  const handleToggleScheduler = useCallback(async () => {
    if (!scheduler) return;
    try {
      await updateSchedulerConfig({ enabled: !scheduler.enabled });
    } catch {
      /* surfaces through the next snapshot */
    }
  }, [scheduler]);

  const scheduledNowId = scheduler?.activeModelId ?? null;
  const nextModelId = scheduler?.nextModelId ?? null;
  const autoIn = boundaryMs != null ? countdown(boundaryMs, now) : null;
  // The model the schedule switches to at the upcoming boundary — what the
  // header surfaces (the current model is already visible on its own card).
  const nextModelName =
    nextModelId != null ? list.find((m) => m.id === nextModelId)?.name ?? nextModelId : null;
  const overrideName =
    scheduler?.override?.modelId != null
      ? list.find((m) => m.id === scheduler?.override?.modelId)?.name ?? scheduler?.override?.modelId
      : null;

  const addButton = (
    <button
      type="button"
      onClick={openNewModelDialog}
      className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:border-accent hover:text-accent"
      title="Register a model repo"
    >
      <PlusIcon className="h-3 w-3" /> Add model
    </button>
  );

  // Nothing yet: say why, but keep Add available — the server is reachable
  // even while the socket is still opening.
  if (list.length === 0) {
    return (
      <Panel
        title="Model Launcher"
        icon={<BoltIcon className="h-3.5 w-3.5 shrink-0 text-muted" />}
        accent
        actions={addButton}
      >
        {models == null ? (
          <p className="text-xs text-muted">
            {connected
              ? "Waiting for the live feed…"
              : "Server unreachable — the model list arrives over the live feed."}
          </p>
        ) : (
          <p className="text-xs text-muted">
            No model repos registered.{" "}
            <button
              type="button"
              onClick={openNewModelDialog}
              className="text-accent underline-offset-2 hover:underline"
            >
              Add one
            </button>{" "}
            to get Start / Stop / Restart on the Overview.
          </p>
        )}
      </Panel>
    );
  }

  return (
    <Panel
      title="Model Launcher"
      icon={
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            activeJob ? "animate-pulse bg-warning" : "bg-accent dot-glow-success"
          }`}
          title={activeJob ? `${activeJob.action} job running` : "Idle"}
        />
      }
      accent
      className="flex flex-col"
      bodyClassName="flex flex-1 flex-col space-y-3"
      actions={
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {activeJob && (
            <span
              className="inline-flex items-center gap-1 rounded border border-warning/40 px-1.5 py-0.5 text-[11px] text-warning"
              title={`Running ./${activeJob.script || "?"} for ${activeJob.model}`}
            >
              <RotateIcon className="h-3 w-3 animate-spin" />
              {activeJob.action} {activeJob.model}
            </span>
          )}

          {scheduler && (
            <>
              {scheduler.lastDecision?.action === "blocked" && (
                <span
                  className="inline-flex items-center gap-1 rounded border border-warning/40 px-1.5 py-0.5 text-[11px] text-warning"
                  title={scheduler.lastDecision.reason || ""}
                >
                  scheduler waiting — {scheduler.lastDecision.reason}
                </span>
              )}
              <span
                className="inline-flex items-center gap-1 text-[11px] text-muted"
                title={
                  scheduler.enabled
                    ? scheduler.override
                      ? `Manual choice is holding${
                          overrideName ? ` for ${overrideName}` : " (nothing running)"
                        } — the schedule re-asserts at the next window boundary${
                          autoIn ? ` (auto in ${autoIn})` : ""
                        }`
                      : scheduler.window
                        ? `Starts next: ${nextModelName ?? "nothing"}${
                            scheduler.nextWindow
                              ? ` (${scheduler.nextWindow.label}, ${scheduler.tz})`
                              : ` (gap — nothing follows ${scheduler.window.label}, ${scheduler.tz})`
                          }${autoIn ? ` · in ${autoIn}` : ""}`
                        : `No window active in ${scheduler.tz} — nothing should run`
                    : "Automation is off — schedules are inert"
                }
              >
                <CalendarIcon
                  className={`h-3.5 w-3.5 shrink-0 ${
                    scheduler.enabled && !scheduler.override ? "text-accent" : ""
                  }`}
                />
                {scheduler.enabled && autoIn ? (
                  <span className="text-accent">{autoIn}</span>
                ) : null}
                {scheduler.enabled
                  ? (() => {
                      const name = scheduler.override ? overrideName : nextModelName;
                      return name ? (
                        <span className="text-muted">({name})</span>
                      ) : null;
                    })()
                  : null}
              </span>

              {scheduler.enabled && scheduler.override && (
                <button
                  type="button"
                  onClick={() => void clearSchedulerOverride()}
                  className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:border-accent hover:text-accent"
                  title="Give up the manual choice now and let the schedule take over"
                >
                  Re-assert
                </button>
              )}

              <button
                type="button"
                role="switch"
                aria-checked={scheduler.enabled}
                onClick={() => void handleToggleScheduler()}
                title={
                  scheduler.enabled
                    ? `Automation ON (${scheduler.tz}) — click to make every schedule inert`
                    : "Automation OFF — models stay on call, but nothing starts or stops on its own"
                }
                className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
                  scheduler.enabled
                    ? "border-accent/50 bg-accent/10 text-accent"
                    : "border-border text-muted hover:text-text"
                }`}
              >
                Auto {scheduler.enabled ? "on" : "off"}
              </button>
            </>
          )}

          <button
            type="button"
            onClick={() => void handleRefresh()}
            className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:border-accent hover:text-accent"
            title="Re-probe every model now"
          >
            <RotateIcon className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </button>
          {addButton}
        </div>
      }
    >
      {/* Single-column list: fills the card and scrolls when its own content
          is taller (slim nice-scrollbar). The card stretches to its grid-row
          partner (the Auditor is usually the taller one), so bottoms align —
          this list absorbs the difference instead of leaving dead space under
          the footer. min-height floors it at exactly 3 compact cards
          (--density-models-cap per density) when the row is short. Cards
          reorder with their ↑/↓ buttons. */}
      <div className="nice-scroll min-h-[var(--density-models-cap)] flex-1 overflow-y-auto pr-1">
        <div className="model-list-compact grid" style={{ gap: "var(--density-card-gap)" }}>
          {list.map((m, i) => (
            <ModelCard
              key={m.id}
              model={m}
              busy={activeJob != null}
              busyHere={activeJob?.modelId === m.id}
              scheduledNow={scheduledNowId === m.id}
              canMoveUp={i > 0}
              canMoveDown={i < list.length - 1}
              onMove={handleMove}
            />
          ))}
        </div>
      </div>

      {/* Whisper hints tucked under card bottom padding. */}
      <footer
        className="pointer-events-none flex flex-wrap items-center gap-x-4 border-t border-border/60 pt-2 text-[9px] leading-none text-muted/60"
        style={{ left: "var(--density-panel-pad)", right: "var(--density-panel-pad)" }}
      >
        <span>one model at a time — starting one stops the other first</span>
        <span>actions run the repo&apos;s own script on the host</span>
        <span>closing a transcript never stops a model</span>
        <span>reorder with a card&apos;s ↑ / ↓ buttons</span>
      </footer>
    </Panel>
  );
}
