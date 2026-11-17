import { useCallback, useEffect, useRef, useState } from "react";
import { fetchDashboardService, setDashboardService } from "../../api/client";
import type { DashboardServiceUnit } from "../../api/types";
import { formatBytes } from "../../shared/formatBytes";
import { PowerOffIcon, PowerOnIcon } from "../ui/icons";
import { Banner } from "./Banner";
import type { PasswordRequest } from "./PasswordDialog";

interface DashboardServicePanelProps {
  sparkId: string;
  sparkName: string;
  online: boolean;
  /** Open the shared password dialog for an action (the page owns the one dialog). */
  requirePassword: (request: PasswordRequest) => void;
  /** Map a failure to the sentence shown under the password box. */
  problem: (err: unknown) => string;
}

/** True only for the plain dashboard service being up: the admin one follows it or stands alone. */
function runningNow(units: DashboardServiceUnit[]): boolean {
  return units.some((u) => u.active === "active" || u.enabled === "enabled");
}

/**
 * The DGX Dashboard services of a unit: systemctl's view of both units (enabled, active, RAM from
 * MemoryCurrent) and one sudo action that enables or disables them together, then re-reads the status.
 */
export function DashboardServicePanel({ sparkId, sparkName, online, requirePassword, problem }: DashboardServicePanelProps) {
  const [units, setUnits] = useState<DashboardServiceUnit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const res = await fetchDashboardService(sparkId);
      if (mine !== generation.current) return;
      setUnits(res.units);
      setError(null);
    } catch (err) {
      if (mine !== generation.current) return;
      // A unit that cannot answer is not healthy: say so instead of showing empty rows.
      setError(err instanceof Error ? err.message : "Could not read the DGX Dashboard status");
    }
  }, [sparkId]);

  useEffect(() => {
    setUnits(null);
    setError(null);
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);

  if (!units && !error) {
    return (
      <section className="panel up-panel" aria-label="DGX Dashboard">
        <h2>DGX Dashboard</h2>
        <p className="up-sub">Reading the service status…</p>
      </section>
    );
  }

  const on = units ? runningNow(units) : false;
  const toggle = (enabled: boolean) =>
    requirePassword({
      title: enabled ? "Start DGX Dashboard" : "Stop DGX Dashboard",
      purpose: `to ${enabled ? "enable" : "disable"} the DGX Dashboard services on ${sparkName}`,
      submit: async (sudoPassword) => {
        try {
          const res = await setDashboardService(sparkId, { enabled, sudoPassword });
          setUnits(res.units); // the server answers with the status after applying
          setError(null);
          return null;
        } catch (err) {
          return problem(err);
        }
      },
    });

  return (
    <section className="panel up-panel" aria-label="DGX Dashboard">
      <div className="up-panel__head">
        <h2>DGX Dashboard</h2>
        {units ? (
          <div className="up-actions">
            <button
              type="button"
              className="btn btn--sm"
              disabled={!online}
              onClick={() => toggle(!on)}
            >
              {on ? <PowerOffIcon className="h-3.5 w-3.5" /> : <PowerOnIcon className="h-3.5 w-3.5" />}
              {on ? "Disable" : "Enable"}
            </button>
          </div>
        ) : null}
      </div>
      {error ? (
        <Banner tone="error">{error}</Banner>
      ) : null}
      {units ? (
        <ul className="up-svc">
          {units.map((u) => (
            <li key={u.unit} className="up-svc__row">
              <span className="up-svc__unit mono">{u.unit}</span>
              <span className={`up-svc__cell${u.enabled === "enabled" ? " is-on" : " is-off"}`}>{u.enabled}</span>
              <span className={`up-svc__cell${u.active === "active" ? " is-on" : " is-off"}`}>{u.active}</span>
              <span className="up-svc__cell up-svc__ram">{u.memoryBytes == null ? "\u2014 RAM" : `${formatBytes(u.memoryBytes)} RAM`}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
