import { useId, useMemo, useState } from "react";
import type { ReaSetup, ReaStatus, ReaTarget, ReaWorkflowSpec } from "../../api/types";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import { Notice } from "./parts";
import { TargetPicker, type TargetPrefill } from "./TargetPicker";
import {
  EXEC_LABEL,
  checkRunForm,
  defaultOptionValues,
  execTone,
  needsConfirm,
  type OptionValues,
} from "./reaLogic";
import type { ReaRunRequest } from "../../api/types";

export interface RunPrefill {
  nonce: number;
  workflowId: string;
  label: string;
  provider: string | null;
  timeoutMinutes: number;
  targets: [ReaTarget | null, ReaTarget | null];
}

interface RunFormProps {
  sparkId: string;
  unitName: string;
  workflow: ReaWorkflowSpec;
  setup: ReaSetup | null;
  status: ReaStatus | null;
  /** Why starting is not possible right now (setup incomplete, a run is live...). */
  disabledReason: string | null;
  error: string | null;
  onStart: (req: ReaRunRequest) => Promise<boolean>;
  onDismissError: () => void;
  prefill: RunPrefill | null;
}

function OptionField({
  arg,
  value,
  error,
  onChange,
}: {
  arg: ReaWorkflowSpec["args"][number];
  value: string | boolean;
  error?: string;
  onChange: (v: string | boolean) => void;
}) {
  const uid = useId();
  const id = `${uid}-${arg.name}`;
  const v = typeof value === "string" ? value : "";
  const hint = (
    <>
      {arg.help ? <span className="rea-hint">{arg.help}</span> : null}
      {error ? <span className="rea-hint is-warn" role="alert">{error}</span> : null}
    </>
  );
  if (arg.kind === "bool") {
    return (
      <label className="rea-check-field">
        <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        <span>
          <b>{arg.name}</b>
          {hint}
        </span>
      </label>
    );
  }
  const req = arg.required ? " (required)" : "";
  let control;
  if (arg.kind === "choice") {
    control = (
      <select id={id} value={v} onChange={(e) => onChange(e.target.value)} aria-invalid={error ? true : undefined}>
        <option value="">{arg.default !== undefined ? `default (${String(arg.default)})` : "not set"}</option>
        {(arg.choices ?? []).map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    );
  } else if (arg.kind === "list" || arg.kind === "json") {
    control = (
      <textarea
        id={id}
        rows={arg.kind === "json" ? 4 : 3}
        className="rea-mono"
        value={v}
        spellCheck={false}
        placeholder={arg.kind === "list" ? "one entry per line" : arg.jsonType === "array" ? "[ ]" : "{ }"}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  } else {
    control = (
      <input
        id={id}
        type={arg.secret ? "password" : arg.kind === "int" ? "number" : "text"}
        inputMode={arg.kind === "int" ? "numeric" : undefined}
        className={arg.kind === "path" || arg.kind === "string" ? "rea-mono" : undefined}
        value={v}
        min={arg.kind === "int" ? arg.min : undefined}
        max={arg.kind === "int" ? arg.max : undefined}
        placeholder={arg.default !== undefined ? `default ${String(arg.default)}` : arg.kind === "intlist" ? "e.g. 0 1 2" : arg.kind === "path" ? "/path/on/the/unit" : undefined}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <div className="rea-field">
      <label className="rea-label" htmlFor={id}>
        {arg.name}
        {req}
      </label>
      {control}
      {hint}
    </div>
  );
}

/** Targets, options, provider, authorization and (for risky classes) the red confirmation; then Run. */
export function RunForm({ sparkId, unitName, workflow, setup, status, disabledReason, error, onStart, onDismissError, prefill }: RunFormProps) {
  const uid = useId();
  const [values, setValues] = useState<OptionValues>(() => defaultOptionValues(workflow));
  const [targets, setTargets] = useState<[ReaTarget | null, ReaTarget | null]>([null, null]);
  const [provider, setProvider] = useState("auto");
  const [timeout, setTimeoutText] = useState(String(workflow.defaultTimeoutMinutes));
  const [label, setLabel] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [appliedNonce, setAppliedNonce] = useState(0);
  const [prefillT, setPrefillT] = useState<[TargetPrefill | null, TargetPrefill | null]>([null, null]);

  // "Run again": apply a prefill once per nonce (the form is keyed by workflow, so it is already the right one).
  if (prefill && prefill.workflowId === workflow.id && prefill.nonce !== appliedNonce) {
    setAppliedNonce(prefill.nonce);
    setLabel(prefill.label);
    setProvider(prefill.provider || "auto");
    setTimeoutText(String(prefill.timeoutMinutes));
    setPrefillT([
      prefill.targets[0] ? { target: prefill.targets[0], nonce: prefill.nonce } : null,
      prefill.targets[1] ? { target: prefill.targets[1], nonce: prefill.nonce } : null,
    ]);
  }

  const check = useMemo(
    () => checkRunForm({ workflow, targets, provider, values, timeoutMinutes: timeout, label, authorized, confirmed }, setup),
    [workflow, targets, provider, values, timeout, label, authorized, confirmed, setup]
  );
  const confirmNeeded = needsConfirm(workflow.execClass);
  const limits = { maxBytes: setup?.limits.uploadMaxBytes ?? 1073741824, maxFiles: setup?.limits.uploadMaxFiles ?? 5000 };
  const kinds = workflow.targetKinds.length ? workflow.targetKinds : (["path", "upload"] as const);
  const allowPath = kinds.includes("path");
  const allowUpload = kinds.includes("upload");
  const providers = status?.providers ?? [];
  const maxTimeout = setup?.limits.maxTimeoutMinutes ?? 240;
  const positional = workflow.args.filter((a) => a.positional);
  const others = workflow.args.filter((a) => !a.positional);
  const setTarget = (i: 0 | 1) => (t: ReaTarget | null) => setTargets((p) => (i === 0 ? [t, p[1]] : [p[0], t]));
  const blocked = disabledReason ?? (check.ok ? null : check.blockers[0]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (blocked || !check.request || starting) return;
    setStarting(true);
    try {
      await onStart(check.request);
    } finally {
      setStarting(false);
    }
  };

  const optionFields = (list: typeof workflow.args) =>
    list.map((a) => (
      <OptionField key={a.name} arg={a} value={values[a.name] ?? ""} error={check.fieldErrors[a.name]} onChange={(v) => setValues((p) => ({ ...p, [a.name]: v }))} />
    ));

  return (
    <Panel title={workflow.label} actions={<Tag tone={execTone(workflow.execClass)}>{EXEC_LABEL[workflow.execClass]}</Tag>}>
      <form className="rea-form" onSubmit={(e) => void submit(e)} aria-label={`Run ${workflow.label} on ${unitName}`}>
        <p className="rea-muted">{workflow.blurb}</p>

        {workflow.targets === 0 ? (
          <p className="rea-hint">This workflow needs no file or folder.</p>
        ) : (
          <>
            <TargetPicker
              sparkId={sparkId}
              unitName={unitName}
              label={workflow.targetLabel ?? (workflow.targets === 2 ? "First target" : "Target")}
              limits={limits}
              allowPath={allowPath}
              allowUpload={allowUpload}
              value={targets[0]}
              onChange={setTarget(0)}
              prefill={prefillT[0]}
            />
            {workflow.targets === 2 ? (
              <TargetPicker
                sparkId={sparkId}
                unitName={unitName}
                label={workflow.target2Label ?? "Second target"}
                limits={limits}
                allowPath={allowPath}
                allowUpload={allowUpload}
                value={targets[1]}
                onChange={setTarget(1)}
                prefill={prefillT[1]}
              />
            ) : null}
          </>
        )}

        {workflow.needsProvider ? (
          <div className="rea-field">
            <label className="rea-label" htmlFor={`${uid}-provider`}>
              Analysis provider
            </label>
            <select id={`${uid}-provider`} value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="auto">Auto (REA chooses among those found)</option>
              {providers
                .filter((p) => p.id !== "auto")
                .map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.available}>
                    {p.label}
                    {p.available ? "" : " (not available)"}
                  </option>
                ))}
            </select>
          </div>
        ) : null}

        {positional.length || others.length ? (
          <div className="rea-options" role="group" aria-label="Options">
            {optionFields(positional)}
            {others.length ? (
              <details className="rea-more" open={others.some((a) => a.required) || workflow.args.length <= 4}>
                <summary>Options ({others.length})</summary>
                <div className="rea-options">{optionFields(others)}</div>
              </details>
            ) : null}
            {workflow.requireOneOf?.length ? <p className="rea-hint">Set at least one of: {workflow.requireOneOf.join(", ")}.</p> : null}
          </div>
        ) : null}

        <div className="rea-row">
          <div className="rea-field rea-field--grow">
            <label className="rea-label" htmlFor={`${uid}-label`}>
              Label <span className="rea-faint">(optional)</span>
            </label>
            <input id={`${uid}-label`} type="text" value={label} maxLength={120} autoComplete="off" onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="rea-field rea-field--narrow">
            <label className="rea-label" htmlFor={`${uid}-timeout`}>
              Time limit (minutes)
            </label>
            <input
              id={`${uid}-timeout`}
              type="number"
              inputMode="numeric"
              min={1}
              max={maxTimeout}
              value={timeout}
              aria-invalid={check.timeoutError ? true : undefined}
              onChange={(e) => setTimeoutText(e.target.value)}
            />
            {check.timeoutError ? <p className="rea-hint is-warn">{check.timeoutError}</p> : null}
          </div>
        </div>

        <label className="rea-check-field">
          <input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} />
          <span>
            <b>I am authorized to analyze this target</b>
            <small>You own it, or you have permission to analyze it, and doing so is lawful where you are.</small>
          </span>
        </label>

        {confirmNeeded ? (
          <div className="rea-danger" role="group" aria-label="Confirm that this runs the target">
            <label className="rea-check-field">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>
                <b>This runs or interacts with the target on {unitName} as its SSH user. It is not a sandbox.</b>
                <small>
                  {workflow.execClass === "executes-target"
                    ? "The program is launched, driven or observed live with that user's permissions, files and network access."
                    : workflow.execClass === "device"
                      ? "The dashboard talks to a device attached to the unit through adb, as that user."
                      : "The unit contacts a live endpoint (such as a local debugging port) as that user."}{" "}
                  Only continue for something you would be willing to run there yourself.
                </small>
                {workflow.effects.mutatesDevice ? (
                  <small className="rea-danger__extra">
                    This also changes the device (install, uninstall, push, start or stop). Changes made to the device are not undone by this dashboard.
                  </small>
                ) : null}
              </span>
            </label>
          </div>
        ) : null}

        {error ? (
          <Notice
            tone="bad"
            title="The run was not started"
            actions={
              <button type="button" className="btn btn--sm" onClick={onDismissError}>
                Dismiss
              </button>
            }
          >
            {error}
          </Notice>
        ) : null}

        <div className="rea-actions">
          <button type="submit" className={`btn ${confirmNeeded ? "btn--danger" : "btn--primary"}`} disabled={Boolean(blocked) || starting}>
            {starting ? "Starting…" : `Run on ${unitName}`}
          </button>
          {blocked ? (
            <span className="rea-hint" role="status">
              {blocked}
            </span>
          ) : null}
        </div>
      </form>
    </Panel>
  );
}
