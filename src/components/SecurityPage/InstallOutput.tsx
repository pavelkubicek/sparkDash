import { CheckIcon } from "../ui/icons";
import { LiveTerminal, terminalText } from "../ui/LiveTerminal";
import { Tag } from "../ui/Tag";
import type { InstallState } from "./InstallStep";
import { CopyButton, Notice } from "./parts";
import { installExitExplanation } from "./securityLogic";

const LAST_LINES = 6;

/**
 * The live output of the install job (one-click or manual), its outcome, and Retry. Rendered once per card.
 * With `hideWhenDone` a finished, successful job is not shown (the card has moved on to its ready summary).
 */
export function InstallOutput({ install, hideWhenDone = false }: { install: InstallState; hideWhenDone?: boolean }) {
  const job = install.job;
  if (!job) return null;
  if (hideWhenDone && job.status === "completed") return null;
  const failed = job.status !== "running" && job.status !== "completed";
  const lastLines = failed ? install.lines.slice(-LAST_LINES) : [];
  const why = failed ? installExitExplanation(job.exitCode) : null;

  return (
    <div className="sec-install-out">
      {install.running && install.error ? (
        <Notice tone="warn" title="Lost contact with the install output (still trying)">
          {install.error.message}
        </Notice>
      ) : null}
      <div className="sec-install-out__head">
        <Tag tone={job.status === "running" ? "acc" : job.status === "completed" ? "good" : "bad"}>
          {job.status === "running"
            ? "Installing…"
            : job.status === "completed"
              ? "Installed"
              : job.status === "cancelled"
                ? "Install cancelled"
                : "Install failed"}
        </Tag>
        <CopyButton text={() => terminalText(install.lines, install.partial)} label="Copy output" />
      </div>
      <LiveTerminal lines={install.lines} partial={install.partial} running={job.status === "running"} emptyText="Waiting for output…" />
      {job.status === "completed" ? (
        <p className="sec-ok" role="status">
          <CheckIcon className="h-3.5 w-3.5" /> Done. Checking the unit again…
        </p>
      ) : null}
      {failed ? (
        <Notice
          tone="bad"
          title={job.exitCode != null ? `The install did not finish (exit code ${job.exitCode})` : "The install did not finish"}
          actions={
            install.lastRequest ? (
              <button type="button" className="btn btn--sm" onClick={() => void install.retry()} disabled={install.starting}>
                Retry
              </button>
            ) : null
          }
        >
          {why ? <p>{why}</p> : null}
          {job.error ? <p>{job.error}</p> : null}
          {lastLines.length ? <pre className="sec-install-out__tail">{lastLines.map((l) => l.text).join("\n")}</pre> : null}
        </Notice>
      ) : null}
    </div>
  );
}
