import type { ReactNode } from "react";
import { AlertTriangleIcon, InfoIcon } from "../ui/icons";
import { CopyButton } from "../bench/tooleval/parts";

export { CopyButton };

/** Inline notice. `bad` is announced as an alert, the rest as a status. */
export function Notice({
  tone = "info",
  title,
  children,
  actions,
}: {
  tone?: "info" | "warn" | "bad";
  title?: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={`sec-notice sec-notice--${tone}`} role={tone === "bad" ? "alert" : "status"}>
      {tone === "info" ? <InfoIcon className="sec-notice__icon" /> : <AlertTriangleIcon className="sec-notice__icon" />}
      <div className="sec-notice__body">
        {title ? <b>{title}</b> : null}
        {children ? <div>{children}</div> : null}
      </div>
      {actions ? <div className="sec-notice__actions">{actions}</div> : null}
    </div>
  );
}

/** A shell command to copy: monospace block with a Copy button. */
export function CommandBlock({ label, command }: { label?: string; command: string }) {
  return (
    <div className="sec-cmd">
      <div className="sec-cmd__head">
        <span className="eyebrow">{label ?? "Command"}</span>
        <CopyButton text={command} />
      </div>
      <pre className="sec-cmd__body">{command}</pre>
    </div>
  );
}

export function fmtWhen(ms: number | null | undefined): string {
  if (!ms) return "–";
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Who built what this page runs: VulnHunter is someone else's project and is credited and linked here. */
export function VulnHuntCredits() {
  return (
    <footer className="sec-credits" aria-label="VulnHunter credits">
      <p>
        Scans are run by{" "}
        <a href="https://github.com/nealbridges/VulnHunter" target="_blank" rel="noopener noreferrer">
          VulnHunter
        </a>
        , an open-source (Apache-2.0) agentic security scanner maintained by{" "}
        <a href="https://github.com/nealbridges" target="_blank" rel="noopener noreferrer">
          Neal Bridges
        </a>
        , a fork of{" "}
        <a href="https://github.com/capitalone/VulnHunter" target="_blank" rel="noopener noreferrer">
          Capital One&apos;s VulnHunter
        </a>
        . sparkDash only installs and drives it; no VulnHunter code is bundled here, and its methodology, skills and reports are the
        VulnHunter authors&apos; work.
      </p>
      <p className="sec-credits__links">
        <a href="https://github.com/nealbridges/VulnHunter" target="_blank" rel="noopener noreferrer">
          github.com/nealbridges/VulnHunter
        </a>
        <span aria-hidden> · </span>
        <a href="https://github.com/nealbridges/VulnHunter/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">
          Apache-2.0 license
        </a>
        <span aria-hidden> · </span>
        <a href="https://github.com/nealbridges/VulnHunter/blob/main/SECURITY.md" target="_blank" rel="noopener noreferrer">
          Security policy
        </a>
      </p>
    </footer>
  );
}
