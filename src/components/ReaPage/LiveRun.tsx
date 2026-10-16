import { useEffect, useState } from "react";
import type { ReaRun } from "../../api/types";
import { formatDuration } from "../../shared/formatDuration";
import { LiveTerminal, terminalText } from "../ui/LiveTerminal";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import type { Followed } from "./hooks";
import { CopyButton, Notice } from "./parts";
import { EXEC_LABEL, execTone, isLive, runTitle, stageLabel, statusLabel, statusTone } from "./reaLogic";

interface LiveRunProps {
  followed: Followed;
  polling: boolean;
  pollError: string | null;
  onStop: () => Promise<boolean>;
  onStopWatching: () => void;
  onWatch: () => void;
  onRefresh: () => void;
  onDismiss: () => void;
  onViewResult: (run: ReaRun) => void;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

/** The run being followed: stage, elapsed time, streamed output and the stop / watch controls. */
export function LiveRun({ followed, polling, pollError, onStop, onStopWatching, onWatch, onRefresh, onDismiss, onViewResult }: LiveRunProps) {
  const { run, job, lines, partial, stage, noLive } = followed;
  const live = isLive(run);
  const watching = live && polling;
  // Elapsed time keeps counting while the run is live, watched or not.
  const now = useNow(live);
  const [confirmStop, setConfirmStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (!live) {
      setConfirmStop(false);
      setStopping(false);
    }
  }, [live]);
  const elapsed = (run.finishedAt ?? now) - run.startedAt;
  const jobError = job?.error && !live ? job.error : null;

  const stop = async () => {
    setStopping(true);
    try {
      await onStop();
    } catch {
      /* the runner reports it; the controls only need to come back */
    } finally {
      setStopping(false);
      setConfirmStop(false);
    }
  };

  return (
    <Panel
      title="Run"
      actions={
        <>
          <Tag tone={statusTone(run.status)}>{statusLabel(run.status)}</Tag>
          {watching ? <Tag tone="acc">{stageLabel(stage)}</Tag> : null}
        </>
      }
    >
      <div className="rea-stack">
        <div className="rea-live__meta">
          <b className="rea-live__title">{runTitle(run)}</b>
          <span className="rea-faint">
            <Tag tone={execTone(run.execClass)}>{EXEC_LABEL[run.execClass]}</Tag> {run.target ? `${run.target.display} · ` : ""}limit {run.timeoutMinutes} min ·{" "}
            {live ? "running for" : "took"} {formatDuration(elapsed)}
          </span>
          <code className="rea-live__cmd">{run.command}</code>
        </div>

        {pollError ? <Notice tone="warn" title="Lost touch with the server">{pollError}. Retrying…</Notice> : null}
        {live && !polling ? (
          <Notice
            tone="warn"
            title="Not watching this run"
            actions={
              <>
                <button type="button" className="btn btn--sm btn--primary" onClick={onWatch}>
                  Watch
                </button>
                <button type="button" className="btn btn--sm" onClick={onRefresh}>
                  Refresh
                </button>
              </>
            }
          >
            The run may still be going on the unit. Watch it to follow the output, or refresh to check whether it has finished.
          </Notice>
        ) : null}
        {!live && run.note ? <Notice tone={run.status === "failed" ? "bad" : "info"}>{run.note}</Notice> : null}
        {jobError ? <Notice tone="bad">{jobError}</Notice> : null}

        <LiveTerminal lines={lines} partial={partial} running={watching} />
        {noLive && !live && lines.length === 0 ? <p className="rea-muted">The live output of this run is no longer held by the server.</p> : null}

        <div className="rea-actions">
          {watching ? (
            confirmStop ? (
              <>
                <span className="rea-confirm">Stop this run on the unit?</span>
                <button type="button" className="btn btn--danger" onClick={() => void stop()} disabled={stopping}>
                  {stopping ? "Stopping…" : "Yes, stop it"}
                </button>
                <button type="button" className="btn" onClick={() => setConfirmStop(false)} disabled={stopping}>
                  Keep running
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn btn--danger" onClick={() => setConfirmStop(true)}>
                  Stop
                </button>
                <button type="button" className="btn" onClick={onStopWatching} title="The run keeps going on the unit">
                  Stop watching
                </button>
              </>
            )
          ) : null}
          {live && polling ? (
            <button type="button" className="btn btn--ghost" onClick={onRefresh}>
              Refresh
            </button>
          ) : null}
          {!live && run.status === "completed" ? (
            <button type="button" className="btn btn--primary" onClick={() => onViewResult(run)}>
              View result
            </button>
          ) : null}
          <CopyButton text={() => terminalText(lines, partial)} label="Copy output" />
          {!live ? (
            <button type="button" className="btn btn--ghost rea-actions__end" onClick={onDismiss}>
              Dismiss
            </button>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
