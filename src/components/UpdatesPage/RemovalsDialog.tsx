import { useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useModalPresence } from "../../hooks/useModalPresence";
import { useOverlayClose } from "../../hooks/useOverlayClose";
import { AlertTriangleIcon } from "../ui/icons";
import "../../styles/dialogs.css";

interface RemovalsDialogProps {
  open: boolean;
  /** Closing is blocked while the confirmed install is being posted. */
  busy: boolean;
  sparkName: string;
  /** The packages the dry-run says the full upgrade would remove, listed exactly as reported. */
  removals: string[];
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * The explicit confirmation the install gate asks for when `apt-get -s full-upgrade` wants to remove
 * packages: every removal is listed verbatim and nothing installs until the button is pressed.
 */
export function RemovalsDialog({ open, busy, sparkName, removals, onCancel, onConfirm }: RemovalsDialogProps) {
  const titleId = useId();
  const { mounted, visible } = useModalPresence(open);
  const trapRef = useFocusTrap(mounted);
  const overlayClose = useOverlayClose(onCancel, !busy);

  useEffect(() => {
    if (!open || busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  useEffect(() => {
    if (!mounted) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mounted]);
  if (!mounted || !open) return null;
  return createPortal(
    <div className={`modal-overlay${visible ? " is-open" : ""}`} {...overlayClose}>
      <div ref={trapRef} className="modal-sheet up-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-sheet__header modal-sheet__header--danger">
          <AlertTriangleIcon className="h-4 w-4" />
          <h2 className="modal-sheet__title" id={titleId}>
            The update wants to remove packages
          </h2>
        </div>
        <div className="modal-sheet__body modal-sheet__stack">
          <p className="up-sub">
            On {sparkName}, the planned full upgrade would remove {removals.length === 1 ? "this package" : `${removals.length} packages`}:
          </p>
          <ul className="up-removals__list mono" role="list">
            {removals.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
          <p className="up-sub">Nothing is installed until you confirm. A reboot is never run by the dashboard.</p>
        </div>
        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions">
            <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" onClick={onConfirm} disabled={busy}>
              {busy ? "Working…" : "Install anyway"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
