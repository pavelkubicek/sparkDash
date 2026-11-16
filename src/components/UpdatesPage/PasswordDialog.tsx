import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useModalPresence } from "../../hooks/useModalPresence";
import { useOverlayClose } from "../../hooks/useOverlayClose";
import { LockIcon } from "../ui/icons";
import "../../styles/dialogs.css";

export interface PasswordRequest {
  /** Dialog heading, e.g. "Install updates". */
  title: string;
  /** What the password will be used for, in a few words: "to install updates on Pico". */
  purpose: string;
  /**
   * Run the action with the typed password. Return null to close the dialog, or the sentence to show
   * under the box ("That password was not accepted", the 429 wait, a plain failure).
   */
  submit: (password: string) => Promise<string | null>;
}

interface PasswordDialogProps {
  /** The waiting action; null keeps the (shared) dialog closed. */
  request: PasswordRequest | null;
  onCancel: () => void;
}

/**
 * The sudo password box every update action shares (one-time use, never stored): the Storage dialog
 * shell, a `field` password input, the submit disabled while it is empty, and one error line under it.
 * The box is emptied whenever the dialog closes.
 */
export function PasswordDialog({ request, onCancel }: PasswordDialogProps) {
  const open = request != null;
  const [password, setPassword] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const titleId = useId();
  const fieldId = useId();
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

  // One-time passwords: the box is wiped the moment the dialog closes, whoever closed it.
  useEffect(() => {
    if (open) return;
    setPassword("");
    setProblem(null);
    setBusy(false);
  }, [open]);

  if (!mounted || !request) return null;

  const confirm = async () => {
    if (!password || busy) return;
    setBusy(true);
    setProblem(null);
    const text = await request.submit(password);
    if (text == null) {
      // The action took it: close (and the close effect wipes the box).
      onCancel();
      return;
    }
    setBusy(false);
    setProblem(text);
  };

  return createPortal(
    <div className={`modal-overlay${visible ? " is-open" : ""}`} {...overlayClose}>
      <div ref={trapRef} className="modal-sheet up-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-sheet__header">
          <LockIcon className="h-4 w-4" />
          <h2 className="modal-sheet__title" id={titleId}>
            {request.title}
          </h2>
        </div>
        <div className="modal-sheet__body modal-sheet__stack">
          <div className="field">
            <label htmlFor={fieldId}>
              <LockIcon className="h-3.5 w-3.5" /> sudo password {request.purpose}
            </label>
            <input
              id={fieldId}
              type="password"
              autoComplete="new-password"
              data-1p-ignore
              data-lpignore="true"
              value={password}
              disabled={busy}
              autoFocus
              placeholder="Your password on the Spark"
              aria-invalid={problem ? true : undefined}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void confirm();
                }
              }}
            />
            {problem ? (
              <p className="up-pw__error" role="alert">
                {problem}
              </p>
            ) : null}
          </div>
          <p className="up-pw__note">Your sudo password is used once for this action and never stored on the dashboard.</p>
        </div>
        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions">
            <button type="button" className="btn btn--ghost" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn--primary" onClick={() => void confirm()} disabled={busy || password.length === 0}>
              {busy ? "Working…" : "Confirm"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
