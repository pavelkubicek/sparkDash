import { useCallback, useEffect, useRef, useState } from "react";
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
  // Drag-to-reorder: which card is in flight, which slot it hovers, and the
  // previewed order (null = none). The drop commits via PUT /api/models/order
  // and the WS snapshot brings the truth back — nothing local is trusted.
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [preview, setPreview] = useState<string[] | null>(null);
  const dragRef = useRef<{ from: string; to: string[] } | null>(null);
  // Auto-scroll while dragging: cards outside the visible list must stay
  // reachable, so moving near the list edge scrolls it at an edge-distance
  // ramp. The rAF loop lives only while a drag is active.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const dragScroll = useRef<{ y: number; raf: number } | null>(null);

  const rawList: ModelInfo[] = models?.models ?? [];
  // The registry already stores the array in `position` order; sort again so a
  // stale/hand-edited payload still renders qwen → deepseek → glm rather than
  // trusting the wire order. Stable: models without a position keep server order.
  const serverList: ModelInfo[] = rawList.every((m) => m.position == null)
    ? rawList
    : [...rawList].sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9));
  // While dragging, show the previewed order so the drop lands where it looks.
  const list: ModelInfo[] =
    preview != null
      ? [...serverList].sort((a, b) => preview.indexOf(a.id) - preview.indexOf(b.id))
      : serverList;
  const scheduler: SchedulerStatus | null = models?.scheduler ?? null;
  const activeJob = models?.activeJob ?? null;

  const handleDragStart = useCallback((id: string) => {
    setDragId(id);
    setOverId(id);
    dragRef.current = null;
    setPreview(null);
  }, []);

  const EDGE_ZONE_PX = 56; // distance from the list edge where scrolling ramps in
  const EDGE_MAX_SPEED = 14; // px/frame at (or beyond) the edge, ≈ 840 px/s

  /** One rAF step: scroll the list toward dragScroll.y, re-arm while dragging. */
  const dragScrollStep = useCallback(() => {
    const state = dragScroll.current;
    const el = scrollRef.current;
    if (!state || !el) {
      dragScroll.current = null;
      return;
    }
    const max = el.scrollHeight - el.clientHeight;
    if (max > 0) {
      const next = Math.max(0, Math.min(max, el.scrollTop + state.y));
      if (next !== el.scrollTop) el.scrollTop = next;
    }
    state.raf = requestAnimationFrame(dragScrollStep);
  }, []);

  // Track the pointer over the list while a drag is active and translate it
  // into an edge-ramp scroll velocity; a plain dragover throttles on some
  // browsers, so the raw pointer position drives a constant loop instead.
  useEffect(() => {
    if (!dragId) {
      if (dragScroll.current) {
        cancelAnimationFrame(dragScroll.current.raf);
        dragScroll.current = null;
      }
      return;
    }
    const el = scrollRef.current;
    if (!el) return;

    const onMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const fromTop = e.clientY - rect.top;
      const fromBottom = rect.bottom - e.clientY;
      const inside = fromTop > -EDGE_ZONE_PX && fromBottom > -EDGE_ZONE_PX;
      let vy = 0;
      if (inside) {
        if (fromTop < EDGE_ZONE_PX) {
          vy = -((EDGE_ZONE_PX - Math.max(0, fromTop)) / EDGE_ZONE_PX) * EDGE_MAX_SPEED;
        } else if (fromBottom < EDGE_ZONE_PX) {
          vy = ((EDGE_ZONE_PX - Math.max(0, fromBottom)) / EDGE_ZONE_PX) * EDGE_MAX_SPEED;
        }
      }
      if (!dragScroll.current) dragScroll.current = { y: vy, raf: 0 };
      else dragScroll.current.y = vy;
      if (!dragScroll.current.raf) dragScroll.current.raf = requestAnimationFrame(dragScrollStep);
    };
    // pointermove keeps firing outside the window edge zone — clamp there.
    window.addEventListener("pointermove", onMove, { passive: true });
    // dragover on the list keeps the browser from refusing the drop on gaps.
    const onDragOver = (e: DragEvent) => {
      if (el.contains(e.target as Node)) e.preventDefault();
    };
    el.addEventListener("dragover", onDragOver);
    return () => {
      window.removeEventListener("pointermove", onMove);
      el.removeEventListener("dragover", onDragOver);
      if (dragScroll.current) {
        cancelAnimationFrame(dragScroll.current.raf);
        dragScroll.current = null;
      }
    };
  }, [dragId, dragScrollStep]);


  /**
   * Hovering a card: preview moving the dragged card into that slot. Hovering
   * the dragged card itself keeps the last preview — the preview swap often
   * slides the dragged card under the cursor, and wiping the order there made
   * the whole list flicker and the drop never committed.
   */
  const handleDragEnter = useCallback(
    (id: string) => {
      setOverId(id);
      if (!dragId || id === dragId) return;
      const ids = serverList.map((m) => m.id);
      const from = ids.indexOf(dragId);
      const to = ids.indexOf(id);
      if (from === -1 || to === -1) return;
      const next = [...ids];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      dragRef.current = { from: dragId, to: next };
      // dragover fires continuously — only re-render when the preview changes.
      setPreview((prev) => (prev && prev.join("\u0000") === next.join("\u0000") ? prev : next));
    },
    [dragId, serverList]
  );

  const clearDrag = useCallback(() => {
    setDragId(null);
    setOverId(null);
    setPreview(null);
    dragRef.current = null;
  }, []);

  /** Drop landed on a card — persist the previewed order, if any. */
  const handleDrop = useCallback(() => {
    const pending = dragRef.current;
    clearDrag();
    if (!pending) return;
    // Fire-and-forget: the next WS snapshot confirms (or silently reverts).
    void setModelOrder(pending.to).catch(() => {
      /* a rejected order simply never arrives through the snapshot */
    });
  }, [clearDrag]);

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
      {/* Single-column list that stretches: the panel is a grid sibling of
          Auditor (equal row height), so the list grows to match — 2 cards is
          the minimum visible; taller content scrolls (slim nice-scrollbar).
          Drag-to-reorder works across the scroll (HTML5 DnD). */}
      <div ref={scrollRef} className="nice-scroll min-h-[21.5rem] flex-1 overflow-y-auto pr-1">
        <div className="grid" style={{ gap: "var(--density-card-gap)" }}>
          {list.map((m) => (
            <ModelCard
              key={m.id}
              model={m}
              busy={activeJob != null}
              busyHere={activeJob?.modelId === m.id}
              scheduledNow={scheduledNowId === m.id}
              dragging={dragId === m.id}
              dragOver={overId === m.id && dragId != null && dragId !== m.id}
              onCardDragStart={handleDragStart}
              onCardDragEnter={handleDragEnter}
              onCardDrop={handleDrop}
              onCardDragEnd={clearDrag}
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
        <span>drag a card onto another to reorder</span>
      </footer>
    </Panel>
  );
}
