import { useEffect, useState } from "react";
import type { VulnHuntRun } from "../../api/types";
import { formatDuration } from "../../shared/formatDuration";
import { LiveTerminal, terminalText } from "../ui/LiveTerminal";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import { ShieldIcon } from "../ui/icons";
import type { Followed } from "./hooks";
import { CopyButton, Notice } from "./parts";
import { isLive, runTitle, stageLabel, statusLabel, statusTone } from "./securityLogic";

interface LiveScanProps {
  followed: Followed;
  polling: boolean;
  pollError: string | null;
  onStop: () => Promise<boolean>;
  onStopWatching: () => void;
  onWatch: () => void;
  onRefresh: () => void;
  onDismiss: () => void;
  onViewReport: (run: VulnHuntRun) => void;
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

/** The scan being followed: stage, elapsed time, the streamed output and the stop controls. */
export function LiveScan({ followed, polling, pollError, onStop, onStopWatching, onWatch, onRefresh, onDismiss, onViewReport }: LiveScanProps) {
  const { run, job, lines, partial, stage, noLive } = followed;
  const live = isLive(run);
  const watching = live && polling;
  // Elapsed time keeps counting while the scan is live, watched or not.
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
      /* the runner reports the failure; the controls only need to come back */
    } finally {
      // A failed stop leaves the scan running: the confirmation closes and the error shows above.
      setStopping(false);
      setConfirmStop(false);
    }
  };

  return (
    <Panel
      title="Scan"
      icon={<ShieldIcon className="h-4 w-4" />}
      actions={
        <>
          <Tag tone={statusTone(run.status)}>{statusLabel(run.status)}</Tag>
          {watching ? <Tag tone="acc">{stageLabel(stage)}</Tag> : null}
        </>
      }
    >
      <div className="sec-stack">
        <div className="sec-live__meta">
          <b className="sec-live__title">{runTitle(run)}</b>
          <span className="sec-faint">
            {run.source.type === "url" ? "Git URL" : "Path on the unit"} · {run.readOnly ? "read-only requested" : "may execute code"} · limit {run.timeoutMinutes} min
            · {live ? "running for" : "took"} {formatDuration(elapsed)}
          </span>
        </div>

        {pollError ? <Notice tone="warn" title="Lost touch with the server">{pollError}. Retrying…</Notice> : null}
        {live && !polling ? (
          <Notice
            tone="warn"
            title="Not watching this scan"
            actions={
              <>
                <button type="button" className="btn btn--sm btn--primary" onClick={onWatch}>
                  Watch
                </button>
                <button type="button" className="btn btn--sm" onClick={onRefresh}>
                  Check status
                </button>
              </>
            }
          >
            The scan may still be running on the unit. Watch it to follow the output, or check whether it has finished.
          </Notice>
        ) : null}
        {!live && run.note ? <Notice tone={run.status === "failed" ? "bad" : "info"}>{run.note}</Notice> : null}
        {jobError ? <Notice tone="bad">{jobError}</Notice> : null}

        <LiveTerminal lines={lines} partial={partial} running={watching} emptyText="Waiting for output…" />
        {noLive && !live && lines.length === 0 ? <p className="sec-muted">The live output of this scan is no longer held by the server.</p> : null}

        <div className="sec-actions">
          {watching ? (
            confirmStop ? (
              <>
                <span className="sec-confirm">Stop this scan on the unit?</span>
                <button type="button" className="btn btn--danger" onClick={stop} disabled={stopping}>
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
                <button type="button" className="btn" onClick={onStopWatching} title="The scan keeps running on the unit">
                  Stop watching
                </button>
              </>
            )
          ) : null}
          {!live && run.status === "completed" && run.resultCached ? (
            <button type="button" className="btn btn--primary" onClick={() => onViewReport(run)}>
              View report
            </button>
          ) : null}
          <CopyButton text={() => terminalText(lines, partial)} label="Copy output" />
          {!live ? (
            <button type="button" className="btn btn--ghost sec-actions__end" onClick={onDismiss}>
              Dismiss
            </button>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}
