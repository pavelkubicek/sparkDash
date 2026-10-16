import { useState } from "react";
import { compareReaRuns } from "../../api/client";
import type { ReaRun } from "../../api/types";
import { formatDuration } from "../../shared/formatDuration";
import { ListIcon, RotateIcon } from "../ui/icons";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import { Notice, fmtWhen } from "./parts";
import { EXEC_LABEL, boundedJson, execTone, isLive, runTitle, statusLabel, statusTone } from "./reaLogic";

interface HistoryProps {
  sparkId: string;
  runs: ReaRun[] | null;
  error: string | null;
  followedId: string | null;
  viewedId: string | null;
  onReload: () => void;
  onOpen: (run: ReaRun) => void;
  onRunAgain: (run: ReaRun) => void;
  onWatch: (run: ReaRun) => void;
  onRefresh: (run: ReaRun) => void;
  onDelete: (run: ReaRun, force: boolean) => Promise<{ ok: boolean; canForce: boolean }>;
}

/** Runs of this unit, newest first, with row actions and a compare of two finished runs of the same workflow. */
export function History({ sparkId, runs, error, followedId, viewedId, onReload, onOpen, onRunAgain, onWatch, onRefresh, onDelete }: HistoryProps) {
  const [confirm, setConfirm] = useState<{ id: string; force: boolean } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const [cmp, setCmp] = useState<{ result: unknown | null; error: string | null } | null>(null);

  const remove = async (run: ReaRun, force: boolean) => {
    setBusyId(run.id);
    const r = await onDelete(run, force);
    setBusyId(null);
    setConfirm(r.ok ? null : r.canForce ? { id: run.id, force: true } : null);
    if (r.ok) setPicked((p) => p.filter((x) => x !== run.id));
  };

  const pickedRuns = picked.map((id) => runs?.find((r) => r.id === id)).filter((r): r is ReaRun => Boolean(r));
  const sameFamily =
    pickedRuns.length === 2 && pickedRuns[0].workflowId === pickedRuns[1].workflowId && pickedRuns.every((r) => r.status === "completed");
  const toggle = (run: ReaRun) => {
    setCmp(null);
    setPicked((p) => (p.includes(run.id) ? p.filter((x) => x !== run.id) : p.length >= 2 ? [p[1], run.id] : [...p, run.id]));
  };
  const compare = async () => {
    if (!sameFamily) return;
    setComparing(true);
    setCmp(null);
    try {
      const r = await compareReaRuns(sparkId, pickedRuns[0].id, pickedRuns[1].id);
      setCmp({ result: r.result, error: null });
    } catch (e) {
      setCmp({ result: null, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setComparing(false);
    }
  };

  return (
    <Panel
      title="Run history"
      icon={<ListIcon className="h-4 w-4" />}
      actions={
        <button type="button" className="btn btn--sm btn--ghost" onClick={onReload}>
          <RotateIcon className="h-3.5 w-3.5" /> Reload
        </button>
      }
    >
      <div className="rea-stack">
        {error ? <Notice tone="bad">{error}</Notice> : null}
        {runs == null ? (
          error ? null : <p className="rea-muted">Loading…</p>
        ) : runs.length === 0 ? (
          <p className="rea-muted">No runs on this unit yet.</p>
        ) : (
          <>
            <div className="rea-actions">
              <button type="button" className="btn btn--sm" disabled={!sameFamily || comparing} onClick={() => void compare()}>
                {comparing ? "Comparing…" : "Compare selected"}
              </button>
              <span className="rea-hint" role="status">
                {picked.length === 2 && !sameFamily
                  ? "Pick two finished runs of the same workflow to compare."
                  : picked.length < 2
                    ? "Tick two finished runs of the same workflow to compare them."
                    : ""}
              </span>
            </div>
            {cmp?.error ? <Notice tone="bad" title="Could not compare">{cmp.error}</Notice> : null}
            {cmp?.result != null ? (
              <details className="rea-more" open>
                <summary>Comparison</summary>
                <pre className="rea-json">{boundedJson(cmp.result)}</pre>
              </details>
            ) : null}
            <ul className="rea-runs">
              {runs.map((run) => {
                const live = isLive(run);
                const confirming = confirm?.id === run.id;
                const comparable = run.status === "completed";
                return (
                  <li key={run.id} className={`rea-run${viewedId === run.id ? " is-viewed" : ""}${followedId === run.id ? " is-followed" : ""}`}>
                    <div className="rea-run__main">
                      <div className="rea-run__head">
                        {comparable ? (
                          <input
                            type="checkbox"
                            checked={picked.includes(run.id)}
                            onChange={() => toggle(run)}
                            aria-label={`Select ${runTitle(run)} to compare`}
                          />
                        ) : null}
                        <Tag tone={statusTone(run.status)}>{statusLabel(run.status)}</Tag>
                        <b className="rea-run__title">{runTitle(run)}</b>
                        <Tag tone={execTone(run.execClass)}>{EXEC_LABEL[run.execClass]}</Tag>
                      </div>
                      <div className="rea-run__sub">
                        <span>{run.workflowLabel}</span>
                        {run.target ? <span className="rea-mono">{run.target.display}</span> : null}
                        <span>{fmtWhen(run.startedAt)}</span>
                        {run.finishedAt ? <span>{formatDuration(run.finishedAt - run.startedAt)}</span> : null}
                      </div>
                      {run.status === "failed" && run.note ? <p className="rea-run__note">{run.note}</p> : null}
                    </div>
                    <div className="rea-run__actions">
                      {confirming ? (
                        <>
                          <span className="rea-confirm">{confirm.force ? "Could not confirm the run ended. Delete anyway?" : "Delete this run?"}</span>
                          <button type="button" className="btn btn--sm btn--danger" disabled={busyId === run.id} onClick={() => void remove(run, confirm.force)}>
                            {confirm.force ? "Delete anyway" : "Delete"}
                          </button>
                          <button type="button" className="btn btn--sm" onClick={() => setConfirm(null)}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          {run.status === "completed" ? (
                            <button type="button" className="btn btn--sm" onClick={() => onOpen(run)} aria-pressed={viewedId === run.id}>
                              Open
                            </button>
                          ) : null}
                          {live && followedId !== run.id ? (
                            <button type="button" className="btn btn--sm" onClick={() => onWatch(run)}>
                              Watch
                            </button>
                          ) : null}
                          {live ? (
                            <button type="button" className="btn btn--sm btn--ghost" onClick={() => onRefresh(run)}>
                              Refresh
                            </button>
                          ) : null}
                          <button type="button" className="btn btn--sm" onClick={() => onRunAgain(run)} aria-label={`Run again: ${runTitle(run)}`}>
                            Run again
                          </button>
                          <button type="button" className="btn btn--sm btn--ghost" onClick={() => setConfirm({ id: run.id, force: false })}>
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
    </Panel>
  );
}
