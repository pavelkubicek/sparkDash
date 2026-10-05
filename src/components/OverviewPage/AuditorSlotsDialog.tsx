import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  fetchAuditorSlotsConfig,
  updateAuditorSlotsConfig,
} from "../../api/client";
import type { AuditorSlotsConfig } from "../../api/types";
import { useModalPresence } from "../../hooks/useModalPresence";
import { BoltIcon } from "../ui/icons";

function useEscape(onClose: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, enabled]);
}

/** Lock body scroll while the modal is open (important on iOS). */
function useBodyScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [locked]);
}

interface AuditorSlotsDialogProps {
  open: boolean;
  onClose: () => void;
  onSaved?: (config: AuditorSlotsConfig) => void;
}

function clampInt(v: string): string {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return "1";
  return String(Math.max(1, Math.min(999, n)));
}

function clampHour(v: string): string {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return "0";
  return String(Math.max(0, Math.min(23, n)));
}

/**
 * Edit the Auditor analysis slot settings (day/night concurrency + night
 * window). Reads the current plan via the sparkDash bridge and persists a
 * PATCH (only touched keys) to the auditor's /api/slots-config through the
 * same bridge. Half-open [start, end) window — end ≤ start wraps midnight.
 */
export function AuditorSlotsDialog({ open, onClose, onSaved }: AuditorSlotsDialogProps) {
  const { mounted, visible } = useModalPresence(open);
  useEscape(onClose, open && mounted);
  useBodyScrollLock(open && mounted);

  const [config, setConfig] = useState<AuditorSlotsConfig | null>(null);
  const [day, setDay] = useState("4");
  const [nightEnabled, setNightEnabled] = useState(true);
  const [night, setNight] = useState("2");
  const [startHour, setStartHour] = useState("21");
  const [endHour, setEndHour] = useState("6");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setSaved(false);
    fetchAuditorSlotsConfig()
      .then((cfg) => {
        if (cancelled) return;
        setConfig(cfg);
        setDay(String(cfg.daytime_concurrency));
        setNightEnabled(cfg.nighttime_enabled);
        setNight(String(cfg.nighttime_concurrency));
        setStartHour(String(cfg.nighttime_start_hour));
        setEndHour(String(cfg.nighttime_end_hour));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      // PATCH discipline: only the keys the operator sees in this dialog; the
      // auditor treats omitted keys as "untouched" and 422s unknown ones.
      const next = await updateAuditorSlotsConfig({
        daytime_concurrency: parseInt(day, 10),
        nighttime_enabled: nightEnabled,
        nighttime_concurrency: nightEnabled ? parseInt(night, 10) : undefined,
        nighttime_start_hour: nightEnabled ? parseInt(startHour, 10) : undefined,
        nighttime_end_hour: nightEnabled ? parseInt(endHour, 10) : undefined,
      });
      setConfig(next);
      setDay(String(next.daytime_concurrency));
      setNightEnabled(next.nighttime_enabled);
      setNight(String(next.nighttime_concurrency));
      setStartHour(String(next.nighttime_start_hour));
      setEndHour(String(next.nighttime_end_hour));
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      onSaved?.(next);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (!mounted) return null;

  const isDirty =
    config !== null &&
    (parseInt(day, 10) !== config.daytime_concurrency ||
      nightEnabled !== config.nighttime_enabled ||
      parseInt(night, 10) !== config.nighttime_concurrency ||
      parseInt(startHour, 10) !== config.nighttime_start_hour ||
      parseInt(endHour, 10) !== config.nighttime_end_hour);

  return createPortal(
    <div
      className={`modal-overlay${visible ? " is-open" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal-sheet max-w-md"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auditor-slots-title"
      >
        <header className="modal-sheet__header">
          <div className="flex items-center gap-2">
            <BoltIcon className="h-4 w-4 shrink-0 text-accent" />
            <span>Auditor slot settings</span>
          </div>
          {config && (
            <p className="mt-1 text-xs font-normal text-muted">
              Effective concurrency:{" "}
              <span className="font-tabular text-accent">{config.effective_concurrency}</span>
            </p>
          )}
        </header>

        <div className="modal-sheet__body space-y-4">
          {error && !config && (
            <p className="text-xs text-danger">Could not load slot settings — {error}</p>
          )}

          {config && (
            <>
              <div className="space-y-2">
                <label className="block text-xs text-muted">
                  Daytime concurrency
                  <input
                    type="number"
                    min={1}
                    value={day}
                    onChange={(e) => setDay(clampInt(e.target.value))}
                    className="mt-1 w-full rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 font-tabular text-xs text-text outline-none focus:border-accent"
                  />
                </label>
              </div>

              <div className="flex items-center justify-between rounded-md border border-border bg-surface-elevated px-3 py-2">
                <span className="text-xs text-text">Enable nighttime settings</span>
                <label className="relative inline-flex cursor-pointer items-center">
                  <input
                    type="checkbox"
                    checked={nightEnabled}
                    onChange={(e) => setNightEnabled(e.target.checked)}
                    className="peer sr-only"
                  />
                  <span className="h-5 w-9 rounded-full bg-border transition-colors peer-checked:bg-accent" />
                  <span className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform peer-checked:translate-x-4" />
                </label>
              </div>

              {nightEnabled && (
                <div className="space-y-3 rounded-md border border-border bg-surface-elevated p-3">
                  <label className="block text-xs text-muted">
                    Nighttime concurrency
                    <input
                      type="number"
                      min={1}
                      value={night}
                      onChange={(e) => setNight(clampInt(e.target.value))}
                      className="mt-1 w-full rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 font-tabular text-xs text-text outline-none focus:border-accent"
                    />
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    <label className="block text-xs text-muted">
                      Start hour (0–23)
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={startHour}
                        onChange={(e) => setStartHour(clampHour(e.target.value))}
                        className="mt-1 w-full rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 font-tabular text-xs text-text outline-none focus:border-accent"
                      />
                    </label>
                    <label className="block text-xs text-muted">
                      End hour (0–23)
                      <input
                        type="number"
                        min={0}
                        max={23}
                        value={endHour}
                        onChange={(e) => setEndHour(clampHour(e.target.value))}
                        className="mt-1 w-full rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 font-tabular text-xs text-text outline-none focus:border-accent"
                      />
                    </label>
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted">
                    Reviews may start between {startHour}:00 and {endHour}:00
                    {config.nighttime_timezone ? ` (${config.nighttime_timezone})` : ""}. If
                    end ≤ start, the window wraps across midnight.
                  </p>
                </div>
              )}

              {error && <p className="text-xs text-danger">{error}</p>}
            </>
          )}
        </div>

        <div className="modal-sheet__footer">
          <div className="modal-sheet__footer-actions" style={{ marginLeft: "auto" }}>
            {saved && <span className="text-xs text-success">Saved ✓</span>}
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="rounded border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-hover hover:text-text disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!config || !isDirty || saving}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
