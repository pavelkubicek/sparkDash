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
    <div className={`rea-notice rea-notice--${tone}`} role={tone === "bad" ? "alert" : "status"}>
      {tone === "info" ? <InfoIcon className="rea-notice__icon" /> : <AlertTriangleIcon className="rea-notice__icon" />}
      <div className="rea-notice__body">
        {title ? <b>{title}</b> : null}
        {children ? <div>{children}</div> : null}
      </div>
      {actions ? <div className="rea-notice__actions">{actions}</div> : null}
    </div>
  );
}

export function fmtWhen(ms: number | null | undefined): string {
  if (!ms) return "–";
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** REA is someone else's project: credited and linked, with its disclaimer and a responsible-use reminder. */
export function ReaCredits() {
  return (
    <footer className="rea-credits" aria-label="REA credits">
      <p>
        <a href="https://github.com/morluto/rea" target="_blank" rel="noopener noreferrer">
          REA — Reverse Engineer Anything
        </a>{" "}
        by morluto, MIT license. sparkDash installs and drives it; no REA code is bundled here, and its analyses are the REA authors&apos; work.
      </p>
      <p className="rea-credits__links">
        <a href="https://github.com/morluto/rea/blob/main/DISCLAIMER.md" target="_blank" rel="noopener noreferrer">
          REA disclaimer
        </a>
        <span aria-hidden> · </span>
        <span>Only analyze software you are authorized to analyze, and follow the law and license terms that apply to it.</span>
      </p>
    </footer>
  );
}
