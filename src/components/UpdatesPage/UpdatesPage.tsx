import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  checkSparkUpdates,
  fetchUpdatesSummary,
  forgetUpdatesSudo,
  installSparkUpdates,
  refreshSparkUpdates,
} from "../../api/client";
import type { InstallAllJob, InstallAllUnit, SparkSnapshot, UpdateSummary, UpdateSummaryUnit } from "../../api/types";
import { formatSince } from "../../shared/formatSince";
import { RotateIcon } from "../ui/icons";
import { Banner } from "./Banner";
import { DashboardServicePanel } from "./DashboardServicePanel";
import { PasswordDialog, type PasswordRequest } from "./PasswordDialog";
import { RemovalsDialog } from "./RemovalsDialog";
import { useInstallAllJob } from "./useInstallAllJob";
import { useSparkUpdates } from "./useSparkUpdates";
import "../../styles/updates.css";

/** The sentence under the password box: Storage's wording for the gate's codes, the server's for anything else. */
export function passwordProblem(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "That password was not accepted.";
    if (err.status === 429) return "Too many password attempts in a row; wait a minute and try again.";
    if (err.status === 409 && err.code === "unit-busy") return "The unit is busy with another job.";
  }
  return err instanceof Error ? err.message : "The action failed.";
}

/** One row of the fleet install-all / refresh-all panel: the unit, its outcome, its removals while it waits. */
function FleetUnitRow({ unit, refresh }: { unit: InstallAllUnit; refresh: boolean }) {
  const tone =
    unit.state === "done" ? "is-done"
      : unit.state === "error" || unit.state === "needs_confirmation" ? "is-error"
        : unit.state === "running" ? "" : "is-warn";
  const label =
    unit.state === "pending" ? "Queued"
      : unit.state === "running" ? (refresh ? "Refreshing…" : "Installing…")
        : unit.state === "done" ? (refresh ? "Refreshed" : "Updated")
          : unit.state === "error" ? `Failed${unit.code ? ` (${unit.code})` : ""}`
            : unit.state === "needs_confirmation" ? "Needs confirmation"
              : unit.state === "skipped-offline" ? "Skipped — offline" : "Skipped — busy";
  return (
    <li className="up-job__row">
      <span className="up-job__name">{unit.sparkName}</span>
      <span className={`up-job__state ${tone}`}>
        {unit.state === "running" ? <i className="up-spin" aria-hidden /> : null}
        {label}
        {unit.error ? ` — ${unit.error}` : ""}
      </span>
      {unit.removals && unit.removals.length > 0 ? (
        <ul className="up-job__removals">
          {unit.removals.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** What finished look like: one count per outcome that happened (a refresh run refreshed, an install run updated). */
function finishLine(job: InstallAllJob): string {
  const n = (s: InstallAllUnit["state"]) => job.units.filter((u) => u.state === s).length;
  const parts: string[] = [];
  if (n("done")) parts.push(`${n("done")} ${job.mode === "refresh" ? "refreshed" : "updated"}`);
  if (n("error")) parts.push(`${n("error")} failed`);
  if (n("needs_confirmation")) parts.push(`${n("needs_confirmation")} waiting for confirmation`);
  const skipped = n("skipped-offline") + n("skipped-busy");
  if (skipped) parts.push(`${skipped} skipped`);
  return job.state === "error" && parts.length === 0 ? "The run stopped with an error." : `Finished: ${parts.join(", ") || "nothing to do"}.`;
}

/** How often the cards and the open unit are read again while a fleet run walks the units one after
 * another: the first re-read a second after the run is seen, then every five seconds. */
const FLEET_REREAD_MS = 5000;
const FLEET_FIRST_REREAD_MS = 1000;

interface UpdatesPageProps {
  sparks: SparkSnapshot[];
}

/**
 * The updates server supports DGX Spark units plus the dashboard's own machine: it refuses Macs and
 * remote hosts with 400, so the page must not offer them either. Fail-closed like Storage's picker:
 * `isLocal` is optional on a snapshot, so only a strict true admits a host.
 */
export function isUpdatesSpark(spark: SparkSnapshot): boolean {
  // fork: the dashboard's own machine is kind "host" too, but it is a local Linux box, so isLocal admits it.
  return (spark.kind !== "host" || spark.isLocal === true) && spark.kind !== "mac" && spark.platform !== "darwin" && spark.platform !== "windows";
}

/**
 * Updates: check each DGX Spark and the dashboard's own machine for apt and firmware updates without a
 * password, install what the owner asks for with a sudo password — one-time, or the one remembered
 * encrypted for the unit's account, which is what makes the second install need no typing (per unit, or
 * the whole fleet at once) — and keep the DGX Dashboard service on or off on the Sparks. The layout
 * follows the Storage Manager; the jobs are the server's, so closing the page never stops one.
 */
export function UpdatesPage({ sparks }: UpdatesPageProps) {
  const candidates = useMemo(() => sparks.filter(isUpdatesSpark), [sparks]);

  // The summary behind the cards (and the nav dot's twin): read on open and after every action.
  const [summary, setSummary] = useState<UpdateSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const summaryGen = useRef(0);
  const loadSummary = useCallback(async () => {
    const mine = ++summaryGen.current;
    try {
      const next = await fetchUpdatesSummary();
      if (mine !== summaryGen.current) return;
      setSummary(next);
      setSummaryError(null);
    } catch (err) {
      if (mine !== summaryGen.current) return;
      setSummaryError(err instanceof Error ? err.message : "Could not read the update summary");
    }
  }, []);
  useEffect(() => {
    void loadSummary();
    return () => {
      summaryGen.current += 1;
    };
  }, [loadSummary]);

  const rows = useMemo(() => {
    const byId: Record<string, UpdateSummaryUnit> = {};
    for (const r of summary?.sparks ?? []) byId[r.id] = r;
    return candidates.map((spark) => ({ spark, row: byId[spark.id] ?? null }));
  }, [candidates, summary]);

  // The selected unit: remembered while it exists, else the first unit that is up.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => {
    if (selectedId && rows.some((r) => r.spark.id === selectedId)) return;
    const first = rows.find((r) => r.spark.online)?.spark ?? rows[0]?.spark ?? null;
    setSelectedId(first?.id ?? null);
  }, [rows, selectedId]);
  const selected = rows.find((r) => r.spark.id === selectedId) ?? null;

  const updates = useSparkUpdates(selectedId);
  const fleet = useInstallAllJob();
  const fleetRunning = fleet.job?.state === "running";
  const fleetRefresh = fleet.job?.mode === "refresh";
  const anyOnline = candidates.some((s) => s.online);

  // A fleet run that settles here (install-all or refresh-all) moves counts on the cards and the open
  // unit: re-read both, once per job. A run picked up already finished on mount is left as it reads.
  const settledFleetId = useRef<string | null>(null);
  useEffect(() => {
    const job = fleet.job;
    if (!job || job.state === "running") return;
    if (settledFleetId.current === job.id) return;
    settledFleetId.current = job.id;
    void loadSummary();
    void updates.refresh();
  }, [fleet.job, loadSummary, updates.refresh]);

  // A run that is still walking the units moves their states mid-job, so the job-start snapshot the
  // cards and the open unit are holding goes stale: re-read both on a cadence while it runs. The
  // settle effect above still does the final re-read, once per job.
  useEffect(() => {
    if (!fleetRunning) return;
    let cancelled = false;
    const reread = () => {
      if (cancelled) return;
      void loadSummary();
      void updates.refresh();
    };
    let interval: number | null = null;
    const first = window.setTimeout(() => {
      reread();
      if (!cancelled) interval = window.setInterval(reread, FLEET_REREAD_MS);
    }, FLEET_FIRST_REREAD_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      if (interval != null) window.clearInterval(interval);
    };
  }, [fleetRunning, loadSummary, updates.refresh]);

  const [actionError, setActionError] = useState<string | null>(null);
  const [pwRequest, setPwRequest] = useState<PasswordRequest | null>(null);
  const requirePassword = useCallback((request: PasswordRequest) => setPwRequest(request), []);
  const cancelPassword = useCallback(() => setPwRequest(null), []);

  // An install the server sent back for confirmation: the removals and, when one was typed, the
  // one-time password kept for the re-post only — dropped the moment the confirmation dialog closes
  // either way. No password means the unit runs on the one the dashboard remembers.
  const [pendingInstall, setPendingInstall] = useState<{ sparkId: string; sparkName: string; password: string | null; remember?: boolean; removals: string[] } | null>(null);
  const [installBusy, setInstallBusy] = useState(false);

  /**
   * Whether the dashboard remembers a sudo password for a unit's account: the server can elevate an
   * action on it with nothing typed. The open unit answers from its own detail (fresh after an
   * action), the cards from the summary.
   */
  const sudoSavedFor = useCallback(
    (id: string) =>
      (id === selectedId ? updates.detail?.sudoSaved : undefined) ??
      rows.find((r) => r.spark.id === id)?.row?.sudoSaved === true,
    [rows, selectedId, updates.detail]
  );

  const checkNow = async (id: string) => {
    setActionError(null);
    try {
      const detail = await checkSparkUpdates(id);
      updates.applyDetail(detail);
      void loadSummary();
    } catch (err) {
      setActionError(passwordProblem(err));
    }
  };

  /**
   * Run an action that needs administrator rights. With a password remembered for every unit it covers
   * there is nothing to type — it runs on the remembered one straight away, which is the whole point of
   * ticking "remember". Otherwise the shared password box opens, its tick box asking the server to keep
   * an accepted password for the next time.
   */
  const runElevated = (action: {
    title: string;
    purpose: string;
    /** Nothing to type: the dashboard remembers a password for every unit this action covers. */
    saved: boolean;
    /** The box may stay empty even though one unit has none remembered (a fleet run over mixed units). */
    optional?: boolean;
    hint?: string;
    rememberLabel?: string;
    run: (password: string | undefined, remember: boolean | undefined) => Promise<string | null>;
  }) => {
    setActionError(null);
    if (action.saved) {
      void action.run(undefined, undefined).then((problem) => {
        if (problem) setActionError(problem);
      });
      return;
    }
    requirePassword({
      title: action.title,
      purpose: action.purpose,
      allowRemember: true,
      rememberLabel: action.rememberLabel ?? "Remember this password so I do not have to type it again",
      optional: action.optional,
      hint: action.hint,
      submit: async (password, remember) => action.run(password.length > 0 ? password : undefined, remember),
    });
  };

  const askRefreshIndex = (id: string, name: string) =>
    runElevated({
      title: "Refresh the index",
      purpose: `to refresh the package index on ${name}`,
      saved: sudoSavedFor(id),
      rememberLabel: "Remember for the daily refresh",
      run: async (password, remember) => {
        try {
          const detail = await refreshSparkUpdates(id, password, remember);
          updates.applyDetail(detail);
          void loadSummary();
          return null;
        } catch (err) {
          return passwordProblem(err);
        }
      },
    });

  const askInstall = (id: string, name: string) =>
    runElevated({
      title: "Install updates",
      purpose: `to install updates on ${name}`,
      saved: sudoSavedFor(id),
      run: async (password, remember) => {
        try {
          await installSparkUpdates(id, { sudoPassword: password, remember });
          updates.followJob();
          return null;
        } catch (err) {
          if (err instanceof ApiError && err.status === 409 && err.code === "needs_confirmation") {
            const body = err.body as { removals?: unknown } | undefined;
            setPendingInstall({
              sparkId: id,
              sparkName: name,
              password: password ?? null,
              remember,
              removals: Array.isArray(body?.removals) ? (body.removals as string[]) : [],
            });
            return null; // the password box closes; the confirmation dialog takes over
          }
          return passwordProblem(err);
        }
      },
    });

  const confirmInstall = async () => {
    if (!pendingInstall) return;
    setInstallBusy(true);
    setActionError(null);
    try {
      await installSparkUpdates(pendingInstall.sparkId, {
        sudoPassword: pendingInstall.password ?? undefined,
        confirmRemovals: true,
        remember: pendingInstall.remember,
      });
      setPendingInstall(null);
      updates.followJob();
    } catch (err) {
      setPendingInstall(null);
      setActionError(passwordProblem(err));
    } finally {
      setInstallBusy(false);
    }
  };

  // What a fleet run covers: the online units. All of them remembered means nothing to type; a mix
  // still offers the box, whose empty answer leaves every unit on its own remembered password.
  const onlineRows = rows.filter((r) => r.spark.online);
  const fleetSaved = onlineRows.length > 0 && onlineRows.every((r) => sudoSavedFor(r.spark.id));
  const fleetAnySaved = onlineRows.some((r) => sudoSavedFor(r.spark.id));
  const fleetHint =
    fleetAnySaved || !fleetSaved
      ? "A unit whose password the dashboard already remembers uses that one; what you type here covers the units that have none. Leave it empty to run on the remembered passwords only."
      : undefined;

  const askInstallAll = () =>
    runElevated({
      title: "Update all machines",
      purpose: "to update every online unit, one after another",
      saved: fleetSaved,
      optional: fleetAnySaved,
      hint: fleetHint,
      run: async (password, remember) => {
        try {
          await fleet.start(password, remember);
          void loadSummary();
          return null;
        } catch (err) {
          if (err instanceof ApiError && err.status === 409 && err.code === "already-running") {
            return "A fleet update is already running.";
          }
          return passwordProblem(err);
        }
      },
    });

  const askRefreshAll = () =>
    runElevated({
      title: "Refresh all machines",
      purpose: "to refresh the package index on every online unit, one after another",
      saved: fleetSaved,
      optional: fleetAnySaved,
      hint: fleetHint,
      rememberLabel: "Remember for the daily refresh",
      run: async (password, remember) => {
        try {
          await fleet.startRefresh(password, remember);
          void loadSummary();
          return null;
        } catch (err) {
          if (err instanceof ApiError && err.status === 409 && err.code === "already-running") {
            return "A fleet job is already running.";
          }
          return passwordProblem(err);
        }
      },
    });

  /** Make the dashboard forget the sudo password it remembers for this unit's account. */
  const forgetPassword = async (id: string) => {
    setActionError(null);
    try {
      await forgetUpdatesSudo(id);
      await updates.refresh();
      void loadSummary();
    } catch (err) {
      setActionError(passwordProblem(err));
    }
  };

  const age = (at: number | null): string | null => {
    const s = formatSince(at, summary?.now);
    return s == null ? null : s === "0s" ? "just now" : `${s} ago`;
  };

  if (candidates.length === 0) {
    return (
      <div className="up">
        <div className="page-head">
          <div>
            <h1>Updates</h1>
            <p className="page-head__sub">Check each DGX Spark and this dashboard's own machine for apt and firmware updates and install them when you say so.</p>
          </div>
        </div>
        <section className="panel up-state" role="status">
          <h2>No unit to look at</h2>
          <p>Updates works with DGX Spark units and this dashboard's own machine. Add one from the sidebar and it will show up here.</p>
        </section>
      </div>
    );
  }

  const detail = updates.detail;
  const offline = selected ? !selected.spark.online : true;

  return (
    <div className="up">
      <div className="page-head">
        <div>
          <h1>Updates</h1>
          <p className="page-head__sub">
            Check every DGX Spark and this dashboard's own machine for apt and firmware updates without a password,
            install what you ask for with a sudo password — remembered encrypted, so the next one needs no typing —
            and keep the DGX Dashboard service on or off on the Sparks.
          </p>
        </div>
        <div className="page-head__tools">
          <button
            type="button"
            className="btn"
            disabled={fleetRunning || !anyOnline}
            onClick={askRefreshAll}
          >
            Refresh all machines
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={summary?.anyUpgradable !== true || fleetRunning}
            onClick={askInstallAll}
          >
            Update all machines
          </button>
        </div>
      </div>

      {summaryError ? (
        <Banner tone="warn" onDismiss={() => setSummaryError(null)}>
          {summaryError}
        </Banner>
      ) : null}

      {fleet.job ? (
        <section className="panel up-panel" aria-label={fleetRefresh ? "Refresh all machines" : "Update all machines"}>
          <div className="up-panel__head">
            <h2>{fleetRefresh ? "Refresh all machines" : "Update all machines"}</h2>
            {fleetRunning ? (
              <span className="up-sub">
                <i className="up-spin" aria-hidden /> {fleetRefresh ? "Refreshing machines…" : "Running"}
              </span>
            ) : null}
          </div>
          <ul className="up-job">
            {fleet.job.units.map((u) => (
              <FleetUnitRow key={u.sparkId} unit={u} refresh={fleetRefresh} />
            ))}
          </ul>
          {fleet.job.state !== "running" ? <p className="up-summary">{finishLine(fleet.job)}</p> : null}
        </section>
      ) : null}

      <div className="up-picker" role="radiogroup" aria-label="Spark to update">
        {rows.map(({ spark, row }) => {
          const active = spark.id === selectedId;
          const checkedAge = age(row?.checkedAt ?? null);
          return (
            <button
              key={spark.id}
              type="button"
              role="radio"
              aria-checked={active}
              className={`up-card${active ? " is-active" : ""}${spark.online ? "" : " is-offline"}`}
              onClick={() => setSelectedId(spark.id)}
            >
              <span className="up-card__top">
                <i className={`sdot${spark.online ? "" : " sdot--off"}`} aria-hidden />
                <span className="up-card__name">{spark.name}</span>
              </span>
              <span className="up-card__counts">
                {row ? `${row.aptCount} apt · ${row.fwCount} firmware` : "not checked yet"}
              </span>
              <span className="up-card__sub">
                {row?.state === "checking" ? (
                  <>
                    <i className="up-spin" aria-hidden /> Checking…
                  </>
                ) : checkedAge ? (
                  `Checked ${checkedAge}`
                ) : row?.state === "error" ? (
                  "Last check failed"
                ) : (
                  "Never checked"
                )}
              </span>
              {row?.rebootRequired || row?.firmwareRebootNeeded ? (
                <span className="up-card__row">
                  <span className="up-chip">Reboot required</span>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {selected ? (
        <section className="panel up-panel" aria-label={`Updates for ${selected.spark.name}`}>
          <div className="up-panel__head">
            <h2>{selected.spark.name}</h2>
            <div className="up-actions">
              <button type="button" className="btn btn--sm" disabled={offline || detail == null && updates.loading} onClick={() => void checkNow(selected.spark.id)}>
                <RotateIcon className="h-3.5 w-3.5" />
                Check now
              </button>
              <button type="button" className="btn btn--sm" disabled={offline} onClick={() => askRefreshIndex(selected.spark.id, selected.spark.name)}>
                Refresh index
              </button>
              <button type="button" className="btn btn--primary btn--sm" disabled={offline} onClick={() => askInstall(selected.spark.id, selected.spark.name)}>
                Install updates
              </button>
              {sudoSavedFor(selected.spark.id) ? (
                <button type="button" className="btn btn--sm" onClick={() => void forgetPassword(selected.spark.id)}>
                  Forget password
                </button>
              ) : null}
            </div>
          </div>

          {updates.loadError ? <Banner tone="error">{updates.loadError}</Banner> : null}
          {actionError ? (
            <Banner tone="error" onDismiss={() => setActionError(null)}>
              {actionError}
            </Banner>
          ) : null}
          {detail?.lastError ? (
            <Banner tone="error">
              The last check failed: {detail.lastError} — the state below is from an earlier check.
            </Banner>
          ) : null}

          {updates.loading && !detail ? (
            <p className="up-sub">Reading the update state…</p>
          ) : detail ? (
            <>
              <p className="up-sub">
                {(() => {
                  const checkedAge = age(detail.checkedAt);
                  const indexAge = age(detail.index.refreshedAt);
                  return [
                    checkedAge ? `Checked ${checkedAge}` : "Never checked",
                    indexAge ? `index refreshed ${indexAge}` : "index age unknown",
                    detail.sudoSaved ? "sudo password remembered — nothing to type" : "no sudo password stored — you will be asked for one",
                  ]
                    .filter((s): s is string => s != null)
                    .join(" · ");
                })()}
                {detail.rebootRequired ? " · Reboot required" : ""}
              </p>
              <div className="up-card__row">
                {detail.rebootRequired ? <span className="up-chip">Reboot required</span> : null}
                {detail.firmwareRebootNeeded === true ? <span className="up-chip">Firmware reboot pending</span> : null}
                {detail.sim.removals.length > 0 ? <span className="up-chip">{detail.sim.removals.length} removals pending</span> : null}
              </div>

              {/* The install status sits above what is installable: while a job runs (or after it
                  failed) it is the first thing on the unit, not something below the lists. */}
              {updates.job ? (
                <>
                  <h3 className="up-h3">Install job</h3>
                  <ul className="up-job">
                    {updates.job.phases.map((phase) => (
                      <li key={phase.key} className="up-job__row">
                        <span className="up-job__name">{phase.key === "apt" ? "System packages" : "Firmware"}</span>
                        <span
                          className={`up-job__state${phase.state === "done" ? " is-done" : phase.state === "error" ? " is-error" : ""}`}
                        >
                          {phase.state === "running" ? <i className="up-spin" aria-hidden /> : null}
                          {phase.state}
                          {phase.note ? ` — ${phase.note}` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {/* The reason a job died, next to the phase that died: an errored firmware
                      phase can read "error" with an empty note otherwise. */}
                  {updates.job.state === "error" && updates.job.error ? (
                    <Banner tone="error">
                      {updates.job.error}
                      {updates.job.code ? ` (${updates.job.code})` : ""}
                    </Banner>
                  ) : null}
                </>
              ) : null}

              <h3 className="up-h3">System packages</h3>
              {detail.apt.length === 0 ? (
                <p className="up-empty">No apt packages are upgradable.</p>
              ) : (
                <ul className="up-list">
                  {detail.apt.map((a) => (
                    <li key={a.name}>
                      <span className="mono">{a.name}</span>
                      <span className="up-from mono">
                        {a.oldVersion} → {a.newVersion}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="up-sub">
                Full upgrade: {detail.sim.upgrades} upgrades, {detail.sim.kept} kept back.
              </p>
              {detail.sim.removals.length > 0 ? (
                <Banner tone="warn">
                  The full upgrade wants to remove {detail.sim.removals.length === 1 ? "1 package" : `${detail.sim.removals.length} packages`}:{" "}
                  {detail.sim.removals.join(", ")}. You will be asked to confirm before anything installs.
                </Banner>
              ) : null}

              <h3 className="up-h3">Firmware</h3>
              {detail.firmware.devices == null ? (
                <p className="up-empty">{detail.firmware.count > 0 ? `${detail.firmware.count} firmware updates (devices not reported)` : "No firmware updates."}</p>
              ) : detail.firmware.devices.length === 0 ? (
                <p className="up-empty">No firmware updates.</p>
              ) : (
                <ul className="up-list">
                  {detail.firmware.devices.map((d) => (
                    <li key={d.name}>
                      <span>{d.name}</span>
                      <span className="up-from mono">
                        {d.current} → {d.available}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : null}
        </section>
      ) : null}

      {/* The dgx-dashboard.service/-admin.service units exist on a DGX Spark only: on the dashboard's
          own machine the panel would read not-found units and the toggle could only fail. */}
      {selected && selected.spark.kind === "spark" ? (
        <DashboardServicePanel
          sparkId={selected.spark.id}
          sparkName={selected.spark.name}
          online={selected.spark.online}
          sudoSaved={sudoSavedFor(selected.spark.id)}
          requirePassword={requirePassword}
          problem={passwordProblem}
        />
      ) : null}

      <PasswordDialog request={pwRequest} onCancel={cancelPassword} />
      <RemovalsDialog
        open={pendingInstall != null}
        busy={installBusy}
        sparkName={pendingInstall?.sparkName ?? ""}
        removals={pendingInstall?.removals ?? []}
        onCancel={() => setPendingInstall(null)}
        onConfirm={() => void confirmInstall()}
      />
    </div>
  );
}
