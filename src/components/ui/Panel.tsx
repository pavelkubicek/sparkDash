import { useEffect, useState, type ReactNode, type CSSProperties } from "react";
import { ChevronDownIcon } from "./icons";

/** Must match the shell's phone breakpoint in shell.css (@media max-width: 900px). */
const PHONE_MEDIA = "(max-width: 900px)";

interface PanelCollapsible {
  /** localStorage suffix; the open/closed choice persists across reloads. */
  key: string;
  /** Status line shown next to the heading while collapsed on a phone
   *  (running counts, active job, …). Hidden when expanded and on desktop. */
  summary?: ReactNode;
}

interface PanelProps {
  title: string;
  icon?: ReactNode;
  actions?: ReactNode;
  accent?: boolean;
  className?: string;
  bodyClassName?: string;
  style?: CSSProperties;
  /** Tooltip on the title, for readings that are easy to misread. */
  hint?: string;
  /**
   * Phone-only collapsible body. On phones (≤ 900px, the shell's mobile layout)
   * the panel starts COLLAPSED — the heading is a toggle button and the summary
   * (if given) shows its status line. Desktop is rendered exactly as before.
   * Anything that must survive being collapsed (dialogs) has to live outside
   * the panel body.
   */
  collapsible?: PanelCollapsible;
  children: ReactNode;
}

/**
 * Shared panel primitive. Flat surface with a thin neutral border and a
 * consistent title row: small muted icon, sentence-case title, and optional
 * actions on the right (wrapping under the title on narrow screens). `accent`
 * is kept for API compatibility; the redesign no longer draws the left tick.
 */
export function Panel({
  title,
  icon,
  actions,
  accent = false,
  className = "",
  bodyClassName = "",
  style,
  hint,
  collapsible,
  children,
}: PanelProps) {
  const [isPhone, setIsPhone] = useState(() => Boolean(window.matchMedia?.(PHONE_MEDIA)?.matches));
  useEffect(() => {
    const mq = window.matchMedia?.(PHONE_MEDIA);
    if (!mq) return;
    const onChange = () => setIsPhone(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const storageKey = collapsible ? `sparkdash-collapse-${collapsible.key}` : null;
  // Default collapsed: only an explicit "open" from a previous session expands.
  const [collapsed, setCollapsed] = useState(() => {
    if (!storageKey) return false;
    try {
      return localStorage.getItem(storageKey) !== "open";
    } catch {
      return true;
    }
  });
  const toggleCollapsed = () => {
    if (!storageKey) return;
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(storageKey, next ? "closed" : "open");
      } catch {
        /* private mode: state just doesn't persist */
      }
      return next;
    });
  };
  const isCollapsed = Boolean(collapsible) && isPhone && collapsed;

  return (
    <section
      className={`panel ${accent ? "panel-accent" : ""} ${isCollapsed ? "panel-collapsed" : ""} ${className}`}
      style={{ padding: "var(--density-panel-pad)", ...style }}
    >
      <header
        className={`panel-head flex flex-wrap items-center justify-between gap-x-3 gap-y-2 ${collapsible && isPhone ? "panel-head--stack" : ""}`}
        style={{ marginBottom: isCollapsed ? 0 : "var(--density-panel-title-mb)" }}
      >
        {collapsible && isPhone ? (
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!isCollapsed}
            title={hint}
            className="min-w-0 cursor-pointer text-left"
          >
            <span className="panel-title flex items-center gap-2">
              {icon}
              {title}
              <ChevronDownIcon
                className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
              />
            </span>
            {isCollapsed && collapsible.summary != null ? (
              <span className="mt-0.5 block font-tabular text-[11px] font-normal text-muted">
                {collapsible.summary}
              </span>
            ) : null}
          </button>
        ) : (
          <h3 className="panel-title flex min-w-0 items-center gap-2" title={hint}>
            {icon}
            {title}
          </h3>
        )}
        {actions ? <div className="panel-actions flex min-w-0 flex-wrap items-center gap-1.5">{actions}</div> : null}
      </header>
      {!isCollapsed && <div className={bodyClassName}>{children}</div>}
    </section>
  );
}
