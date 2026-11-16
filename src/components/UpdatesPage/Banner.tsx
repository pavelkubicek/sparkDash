import type { ReactNode } from "react";
import { AlertTriangleIcon, CheckIcon, InfoIcon, XIcon } from "../ui/icons";

export type BannerTone = "ok" | "info" | "warn" | "error";

export interface BannerProps {
  tone: BannerTone;
  children: ReactNode;
  /** A button on the right, e.g. the way to fix what the banner says. */
  action?: ReactNode;
  onDismiss?: () => void;
}

/** The Storage Manager's Banner, with the page's own `up-banner` classes: same tones, scoped under .up. */
export function Banner({ tone, children, action, onDismiss }: BannerProps) {
  const Icon = tone === "ok" ? CheckIcon : tone === "info" ? InfoIcon : AlertTriangleIcon;
  return (
    <div className={`up-banner is-${tone}`} role={tone === "error" || tone === "warn" ? "alert" : "status"}>
      <Icon className="up-banner__icon h-4 w-4" />
      <div className="up-banner__text">{children}</div>
      {action ? <div className="up-banner__action">{action}</div> : null}
      {onDismiss ? (
        <button type="button" className="up-banner__x" onClick={onDismiss} aria-label="Dismiss">
          <XIcon className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}
