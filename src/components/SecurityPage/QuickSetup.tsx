import { useId, useState } from "react";
import type { VulnHuntHarnessId, VulnHuntSetup, VulnHuntStatus } from "../../api/types";
import { CheckIcon } from "../ui/icons";
import { Tag } from "../ui/Tag";
import { InstallOutput } from "./InstallOutput";
import { errorTitle, type InstallState } from "./InstallStep";
import { Notice } from "./parts";
import { activeHarness, quickSetupProblems, shortRev } from "./securityLogic";

interface QuickSetupProps {
  unitName: string;
  setup: VulnHuntSetup | null;
  setupError: string | null;
  status: VulnHuntStatus;
  install: InstallState;
  /** Turns the VulnHunter opt-in on (and reloads the setup). Rejects with the reason it could not. */
  onEnableOptIn?: () => Promise<void>;
}

const OPT_IN_CONSENT =
  "Turning this on lets this dashboard install VulnHunter and run an AI agent on this unit. Anyone who can reach the dashboard can then use it.";

/**
 * The one-click path: a button per agent CLI found on the unit. One click turns the opt-in on when it is off
 * (the sentence above the buttons is the consent), installs VulnHunter and wires up that harness, streaming the output.
 * When the unit is ready it collapses into a summary with a "Change harness" disclosure.
 */
export function QuickSetup({ unitName, setup, setupError, status, install, onEnableOptIn }: QuickSetupProps) {
  const uid = useId();
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<VulnHuntHarnessId | null>(null);

  const info = status.install;
  const harnesses = info.harnesses ?? [];
  const found = harnesses.filter((h) => h.found);
  const missing = harnesses.filter((h) => !h.found);
  const outdated = status.installed && !info.upToDate;
  const compact = status.ready && !outdated && !install.running;
  const problems = quickSetupProblems(status);
  const optIn = setup != null && !setup.enabled;

  const gate =
    setup && setup.enabled && !setup.startAllowed
      ? (setup.startBlockedReason ?? "Changing a unit is not allowed on this dashboard.")
      : optIn && !onEnableOptIn
        ? (setup.startBlockedReason ?? "VulnHunter is turned off.")
        : !setup && !setupError
          ? "Checking whether this dashboard allows changes…"
          : null;
  const reason = problems[0] ?? gate ?? (install.running ? "An install is already running on this unit." : null);
  const busy = enabling || install.starting || install.running;

  const go = async (id: VulnHuntHarnessId) => {
    if (reason || busy) return;
    setChosen(id);
    setEnableError(null);
    if (optIn && onEnableOptIn) {
      setEnabling(true);
      try {
        await onEnableOptIn();
      } catch (e) {
        setEnableError(e instanceof Error ? e.message : String(e));
        return;
      } finally {
        setEnabling(false);
      }
    }
    await install.start({ harness: id });
  };

  const verb = status.installed ? "Update" : "Set up";
  const choices = (
    <div className="sec-quick__choices">
      {optIn ? <p className="sec-quick__consent">{OPT_IN_CONSENT}</p> : null}
      {found.length ? (
        <ul className="sec-quick__list" aria-label="Agent CLIs found on this unit">
          {found.map((h) => (
            <li key={h.id} className="sec-quick__item">
              <div className="sec-quick__row">
                <button type="button" className="btn btn--primary" disabled={Boolean(reason) || busy} onClick={() => void go(h.id)}>
                  {busy && chosen === h.id ? "Setting up…" : `${verb} with ${h.label}`}
                </button>
                {h.roEnforced ? <Tag tone="good">read-only enforced</Tag> : null}
                {h.wrapperInstalled ? <Tag tone="neutral">set up before</Tag> : null}
              </div>
              {h.note ? <small className="sec-quick__note">{h.note}</small> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="sec-muted">
          No supported agent CLI was found on {unitName}
          {missing.length ? ` (${missing.map((h) => h.label).join(", ")})` : ""}. Install one there, or use the Advanced section below to
          set the harness command yourself.
        </p>
      )}
      {found.length && missing.length ? <p className="sec-muted">Not found on this unit: {missing.map((h) => h.label).join(", ")}</p> : null}
      {problems.length ? (
        <ul className="sec-problems" aria-label="Problems on this unit">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
      {reason && !problems.length && found.length ? (
        <p className="sec-hint" role="status">
          {reason}
        </p>
      ) : null}
      {enableError ? (
        <Notice tone="bad" title="Could not turn VulnHunter on">
          {enableError}
        </Notice>
      ) : null}
      {install.error && install.lastRequest && "harness" in install.lastRequest && !install.running ? (
        <Notice tone="bad" title={errorTitle(install.error)}>
          {install.error.message}
        </Notice>
      ) : null}
    </div>
  );

  if (compact) {
    const h = activeHarness(status) ?? harnesses.find((x) => x.id === chosen && x.wrapperInstalled) ?? null;
    const program = status.hostCommand.program;
    return (
      <section className="sec-quick" aria-label={`VulnHunter setup on ${unitName}`}>
        <p className="sec-quick__ready" role="status">
          <CheckIcon className="h-3.5 w-3.5" />
          <span>
            <b>Ready</b> — VulnHunter {h ? `via ${h.label}` : program ? `with harness command ${program}` : "installed"}
            {info.installedRev ? (
              <>
                {" "}
                · revision <code>{shortRev(info.installedRev)}</code>
              </>
            ) : null}
          </span>
        </p>
        <InstallOutput install={install} hideWhenDone />
        {found.length ? (
          <details className="sec-manual">
            <summary>Change harness</summary>
            {choices}
          </details>
        ) : null}
      </section>
    );
  }

  return (
    <section className="sec-quick" aria-labelledby={`${uid}-title`}>
      <h3 className="sec-step__title" id={`${uid}-title`}>
        Set up VulnHunter on {unitName}
      </h3>
      <p className="sec-muted">
        One click installs VulnHunter on {unitName} (as the user the dashboard connects with), adds its skill for the agent you pick and saves the
        command that runs it. Nothing is installed on the machine running the dashboard.
      </p>
      {choices}
      <InstallOutput install={install} />
    </section>
  );
}
