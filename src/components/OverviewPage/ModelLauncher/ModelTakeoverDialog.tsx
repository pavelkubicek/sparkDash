import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useModalPresence } from "../../../hooks/useModalPresence";
import {
  closeModelTakeoverDialog,
  useModelTakeoverDialog,
} from "../../../hooks/useModelTakeoverDialog";
import { restartModel, startModel } from "../../../api/modelClient";
import { openModelCommandDialog } from "../../../hooks/useModelCommandDialog";
import { PowerOffIcon, RotateIcon } from "../../ui/icons";

function useEscape(onClose: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, enabled]);
}

function useBodyScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [locked]);
}

/**
 * The choice dialog: a Start/Restart refused with takeover-confirm because
 * other models are running on the Sparks the target occupies. It names
 * exactly who dies and where — the operator either approves the swap (the
 * incumbents' stop.sh run first, in the same job) or cancels and nothing
 * runs. Closing by Escape/overlay is a cancel by design.
 */
export function ModelTakeoverDialog() {
  const target = useModelTakeoverDialog();
  const { mounted, visible } = useModalPresence(target != null);
  useEscape(closeModelTakeoverDialog, target != null && mounted);
  useBodyScrollLock(target != null && mounted);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setConfirming(false);
  }, [target?.modelId, target?.action]);

  if (!mounted || !target) return null;

  const confirm = async () => {
    setConfirming(true);
    setError(null);
    try {
      const run = target.action === "restart" ? restartModel : startModel;
      const res = await run(target.modelId, { confirmTakeover: true });
      openModelCommandDialog({
        jobId: res.jobId,
        modelId: target.modelId,
        modelName: target.modelName,
        action: target.action,
        stopping: res.stopping,
      });
      closeModelTakeoverDialog();
    } catch (err: unknown) {
      // A second refusal (the situation changed under the dialog) or a
      // transport error — either way the operator decides the next click.
      setError(err instanceof Error ? err.message : String(err));
      setConfirming(false);
    }
  };

  const plural = target.incumbents.length > 1 ? "s" : "";
  return createPortal(
    <div
      className={`modal-overlay${visible ? " is-open" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeModelTakeoverDialog();
      }}
    >
      <div
        className="modal-sheet max-w-md"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-takeover-title"
      >
        <header className="modal-sheet__header" id="model-takeover-title">
          <div className="flex items-center gap-2">
            <PowerOffIcon className="h-4 w-4 shrink-0 text-danger" />
            <span>Start {target.modelName}?</span>
          </div>
          <p className="mt-1 text-xs font-normal text-muted">
            {target.targetSparks?.length ? (
              <>
                It occupies{" "}
                <span className="font-tabular text-text">
                  {target.targetSparks.map((s) => s.name).join(", ")}
                </span>
                .{" "}
              </>
            ) : null}
            To start it, these running model{plural} must stop first — their stop scripts run
            before the new one starts.
          </p>
        </header>

        <div className="modal-sheet__body space-y-2">
          <ul className="space-y-1.5">
            {target.incumbents.map((inc) => (
              <li
                key={inc.id}
                className="flex flex-wrap items-center gap-1.5 rounded border border-border bg-surface-elevated px-2.5 py-1.5"
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success dot-glow-success" />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-strong">
                  {inc.name}
                </span>
                <span className="shrink-0 text-[10px] text-muted">on</span>
                {(inc.sparkNames?.length ? inc.sparkNames : inc.sparks).map((name) => (
                  <span
                    key={`${inc.id}:${name}`}
                    className="shrink-0 rounded bg-border/60 px-1.5 py-0.5 text-[10px] text-muted font-tabular"
                  >
                    {name}
                  </span>
                ))}
              </li>
            ))}
          </ul>
          <p className="text-[11px] leading-snug text-muted">
            Stopping runs each model&apos;s own stop script on its head Spark; workers are freed
            with it. Cancel starts nothing and leaves every running model alone.
          </p>
          {error && (
            <p className="break-words text-[11px] text-danger" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions" style={{ marginLeft: "auto" }}>
            <button
              type="button"
              onClick={closeModelTakeoverDialog}
              disabled={confirming}
              className="rounded border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50"
              title="Run nothing — every running model keeps serving"
            >
              Cancel — run nothing
            </button>
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={confirming}
              className="flex items-center gap-1.5 rounded bg-danger px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-danger/80 disabled:opacity-50"
              title={`Stop ${target.incumbents.map((i) => i.name).join(", ")} and start ${target.modelName}`}
            >
              {confirming ? (
                <RotateIcon className="h-3 w-3 animate-spin" />
              ) : (
                <PowerOffIcon className="h-3 w-3" />
              )}
              {confirming
                ? "Starting…"
                : `Stop ${target.incumbents.length} model${plural} and start`}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
