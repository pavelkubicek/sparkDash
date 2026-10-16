import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from "react";
import type { VulnHuntScanRequest } from "../../api/types";
import { Panel } from "../ui/Panel";
import { ShieldIcon } from "../ui/icons";
import { Notice } from "./parts";
import { FALLBACK_LIMITS, SOURCE_PLACEHOLDER, checkScanForm, detectSourceType, initialForm, type ScanFormState, type ScanLimits } from "./securityLogic";

interface ScanFormProps {
  unitName: string;
  limits?: ScanLimits;
  /** Why the form cannot be used right now (setup missing, a scan running…); null when it can. */
  disabledReason?: string | null;
  /** Message from the server for the last attempt (400 / 409). */
  error?: string | null;
  /** Resolves true when the scan was accepted. */
  onStart: (request: VulnHuntScanRequest) => Promise<boolean>;
  onDismissError?: () => void;
  /** Sources of earlier scans on this unit, newest first (shown as chips that fill the input). */
  recent?: string[];
  /** A source to put in the input (from a history row); a new `nonce` fills it again. */
  prefill?: { value: string; nonce: number } | null;
  /** The harness whose preset enforces read-only with tool restrictions, when the saved command is one. */
  enforcedBy?: string | null;
}

/** Start a scan: what to scan, the two explicit confirmations, and a few options. */
export function ScanForm({
  unitName,
  limits = FALLBACK_LIMITS,
  disabledReason = null,
  error = null,
  onStart,
  onDismissError,
  recent = [],
  prefill = null,
  enforcedBy = null,
}: ScanFormProps) {
  const [form, setForm] = useState<ScanFormState>(() => initialForm(limits));
  const [starting, setStarting] = useState(false);
  const uid = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const check = useMemo(() => checkScanForm(form, limits), [form, limits]);
  const locked = disabledReason != null || starting;
  const patch = (p: Partial<ScanFormState>) => {
    onDismissError?.();
    // The source type follows what was typed: a path starts with / or ~/, anything else is a URL.
    setForm((f) => {
      const next = { ...f, ...p };
      return p.value !== undefined ? { ...next, sourceType: detectSourceType(p.value) } : next;
    });
  };

  // A history row's "Scan again" (or any new prefill) fills the input and moves focus there.
  const prefillNonce = prefill?.nonce;
  useEffect(() => {
    if (!prefill) return;
    setForm((f) => ({ ...f, value: prefill.value, sourceType: detectSourceType(prefill.value) }));
    inputRef.current?.focus();
    // Only a new nonce counts, not a re-render with the same object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillNonce]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!check.request || locked) return;
    setStarting(true);
    let ok = false;
    try {
      ok = await onStart(check.request);
    } finally {
      setStarting(false);
    }
    // Every scan is attested anew.
    if (ok) setForm((f) => ({ ...f, authorized: false, confirmExecute: false }));
  };

  const sourceId = `${uid}-source`;
  const hintId = `${uid}-hint`;
  const showHint = form.value.trim() !== "" && check.sourceHint != null;

  return (
    <Panel title="New scan" icon={<ShieldIcon className="h-4 w-4" />}>
      <form className="sec-form" onSubmit={submit} aria-label="New security scan">
        {disabledReason ? <Notice tone="info">{disabledReason}</Notice> : null}
        <fieldset className="sec-fieldset" disabled={locked}>
          <div className="sec-field sec-field--wide">
            <label className="sec-label" htmlFor={sourceId}>
              Repository URL or a path on this unit
            </label>
            <input
              id={sourceId}
              ref={inputRef}
              type="text"
              className="sec-mono"
              value={form.value}
              placeholder={`${SOURCE_PLACEHOLDER.url} or ${SOURCE_PLACEHOLDER.path}`}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-describedby={showHint ? hintId : undefined}
              aria-invalid={showHint || undefined}
              onChange={(e) => patch({ value: e.target.value })}
            />
            {showHint ? (
              <p className="sec-hint is-warn" id={hintId}>
                {check.sourceHint}
              </p>
            ) : (
              <p className="sec-hint">
                {form.value.trim() === ""
                  ? `https:// URLs are cloned by the unit; a path (/… or ~/…) must already exist on ${unitName}, under the user's home directory.`
                  : form.sourceType === "url"
                    ? "The unit clones it over https, then scans the checkout."
                    : `A checkout that already exists on ${unitName}, under the user's home directory.`}
              </p>
            )}
            {recent.length ? (
              <div className="sec-recent" role="group" aria-label="Recent sources">
                <span className="sec-faint">Recent</span>
                {recent.map((value) => (
                  <button key={value} type="button" className="sec-recent__chip sec-mono" title={value} onClick={() => patch({ value })}>
                    {value}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="sec-scanrow">
            <label className="sec-check-field sec-scanrow__auth">
              <input type="checkbox" checked={form.authorized} onChange={(e) => patch({ authorized: e.target.checked })} />
              <span>
                <b>I am authorized to scan this code</b>
                <small>Dual-use security tool: scan only code you own or are authorized to audit.</small>
              </span>
            </label>
            <button type="submit" className="btn btn--primary sec-scanrow__go" disabled={!check.ok || locked} aria-label={`Scan on ${unitName}`}>
              {starting ? "Starting…" : "Scan"}
            </button>
          </div>

          <details className="sec-manual sec-options">
            <summary>Options</summary>
            <div className="sec-form">
              <div className="sec-row">
                <div className="sec-field">
                  <label className="sec-label" htmlFor={`${uid}-label`}>
                    Label <span className="sec-faint">(optional)</span>
                  </label>
                  <input
                    id={`${uid}-label`}
                    type="text"
                    value={form.label}
                    maxLength={120}
                    placeholder="e.g. pre-release audit"
                    onChange={(e) => patch({ label: e.target.value })}
                  />
                </div>
                <div className="sec-field sec-field--narrow">
                  <label className="sec-label" htmlFor={`${uid}-timeout`}>
                    Time limit (minutes, whole scan)
                  </label>
                  <input
                    id={`${uid}-timeout`}
                    type="number"
                    inputMode="numeric"
                    min={limits.minTimeoutMinutes}
                    max={limits.maxTimeoutMinutes}
                    step={1}
                    value={form.timeoutMinutes}
                    aria-invalid={check.timeoutError ? true : undefined}
                    onChange={(e) => patch({ timeoutMinutes: e.target.value })}
                  />
                  {check.timeoutError ? <p className="sec-hint is-warn">{check.timeoutError}</p> : null}
                </div>
              </div>

              <label className="sec-check-field">
                <input
                  type="checkbox"
                  checked={form.readOnly}
                  onChange={(e) => patch({ readOnly: e.target.checked, confirmExecute: e.target.checked ? false : form.confirmExecute })}
                />
                <span>
                  {enforcedBy ? (
                    <>
                      <b>Read-only scan (enforced by {enforcedBy}&apos;s tool restrictions)</b>
                      <small>
                        The prompt tells the agent to read the source and report, and not to install dependencies or execute anything; the{" "}
                        {enforcedBy} preset set up by this dashboard also starts the agent with tool restrictions. That holds only while the saved
                        harness command is that preset.
                      </small>
                    </>
                  ) : (
                    <>
                      <b>Read-only scan (asks the harness not to run code)</b>
                      <small>
                        The prompt tells the agent to read the source and report, and not to install dependencies or execute anything. It is an
                        instruction to your harness, not a sandbox: use a harness or container that confines the agent if you need a guarantee.
                      </small>
                    </>
                  )}
                </span>
              </label>

              {!form.readOnly ? (
                <div className="sec-danger" role="group" aria-label="Code execution">
                  <label className="sec-check-field">
                    <input type="checkbox" checked={form.confirmExecute} onChange={(e) => patch({ confirmExecute: e.target.checked })} />
                    <span>
                      <b>Allow the scan to execute code on this unit (dependencies, exploit tests)</b>
                      <small>
                        The scanned project&apos;s dependencies may be installed and its code run as the user the dashboard connects with on{" "}
                        {unitName}. Only do this for code you trust enough to run there.
                      </small>
                    </span>
                  </label>
                </div>
              ) : null}
            </div>
          </details>
        </fieldset>

        {error ? (
          <Notice tone="bad" title="The scan was not started">
            {error}
          </Notice>
        ) : null}

        {!check.ok && !disabledReason ? (
          <p className="sec-hint" role="status">
            {check.blockers[0]}
          </p>
        ) : null}
      </form>
    </Panel>
  );
}
