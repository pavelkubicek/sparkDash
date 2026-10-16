import { useId, useState } from "react";
import type { VulnHuntSetup, VulnHuntStatus } from "../../api/types";
import { Tag } from "../ui/Tag";
import type { useVulnHuntHostCommand } from "./hooks";
import { Notice } from "./parts";
import { changeBlockedReason } from "./securityLogic";

interface HarnessStepProps {
  unitName: string;
  setup: VulnHuntSetup | null;
  setupError: string | null;
  status: VulnHuntStatus;
  hc: ReturnType<typeof useVulnHuntHostCommand>;
  /** The step number shown in the heading. */
  num?: number;
}

/**
 * Step 2: the command that runs the user's agent harness headlessly. Write-only: the input is never
 * filled from the unit, and is emptied after a successful save.
 */
export function HarnessStep({ unitName, setup, setupError, status, hc, num = 2 }: HarnessStepProps) {
  const uid = useId();
  const [command, setCommand] = useState("");
  const h = status.hostCommand;
  const gate = changeBlockedReason(setup, setupError);
  const trimmed = command.trim();
  const reason = gate ?? (!trimmed ? "Enter the command first." : trimmed.length > 500 ? "The command can be at most 500 characters." : null);
  const canRemove = h.configured && h.source !== "env";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (reason || hc.busy) return;
    const ok = await hc.save(trimmed);
    if (ok) setCommand("");
  };

  return (
    <section className="sec-step" aria-labelledby={`${uid}-h`}>
      <h3 className="sec-step__title" id={`${uid}-h`}>
        <span className="sec-step__num">{num}</span> Harness command
      </h3>

      <p className="sec-step__status" role="status">
        {h.configured ? (
          <>
            <Tag tone="good">Configured</Tag> program <code>{h.program ?? "unknown"}</code>
            {h.source === "env" ? " (from the unit's environment)" : ""}
          </>
        ) : h.source === "unsafe" ? (
          <>
            <Tag tone="warn">Not usable</Tag> the command file on {unitName} is not safe to use. Saving a command below writes it again.
          </>
        ) : h.source !== "none" && !h.found ? (
          <>
            <Tag tone="warn">Program not found</Tag> <code>{h.program ?? "unknown"}</code> is not on the PATH of {unitName}.
          </>
        ) : (
          <>
            <Tag tone="warn">Not configured</Tag>
          </>
        )}
      </p>

      <form className="sec-form" onSubmit={submit} aria-label="Harness command">
        <fieldset className="sec-fieldset" disabled={hc.busy}>
          <div className="sec-field">
            <label className="sec-label" htmlFor={`${uid}-cmd`}>
              Command that runs your agent harness headlessly (the prompt file path is appended as the last argument)
            </label>
            <input
              id={`${uid}-cmd`}
              type="text"
              className="sec-mono"
              value={command}
              maxLength={500}
              placeholder="one line, e.g. my-harness --headless --prompt-file"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => setCommand(e.target.value)}
            />
            <p className="sec-hint">Saved on the unit in a file only its user can read. It is never shown again.</p>
          </div>
        </fieldset>

        {hc.error ? (
          <Notice tone="bad" title={hc.error.status === 403 ? "The dashboard does not allow this" : "The command was not saved"}>
            {hc.error.message}
          </Notice>
        ) : null}

        <div className="sec-actions">
          <button type="submit" className="btn btn--primary" disabled={Boolean(reason) || hc.busy}>
            {hc.busy ? "Saving…" : "Save command"}
          </button>
          {canRemove ? (
            <button type="button" className="btn" disabled={hc.busy || Boolean(gate)} onClick={() => void hc.clear()}>
              Remove
            </button>
          ) : null}
          {gate ? (
            <span className="sec-hint" role="status">
              {gate}
            </span>
          ) : null}
        </div>
      </form>
    </section>
  );
}
