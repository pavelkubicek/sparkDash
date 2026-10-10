import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SparkSnapshot } from "../../api/types";
import { fetchFleetEnergy } from "../../api/client";
import { TrendLine } from "../ui/TrendLine";
import { computeFleetTotals, pushRolling } from "./fleetStats";

interface Trends {
  decode: number[];
  power: number[];
  mem: number[];
}

// Survives leaving and re-entering the Overview within one browser session.
let persisted: Trends = { decode: [], power: [], mem: [] };

/** Test helper: forget the samples kept across mounts. */
export function _resetFleetKpiTrends(): void {
  persisted = { decode: [], power: [], mem: [] };
}

function Kpi({
  label,
  value,
  unit,
  right,
  trend,
  color,
  foot,
}: {
  label: string;
  value: string;
  unit: string;
  right?: ReactNode;
  trend?: readonly number[];
  color: string;
  foot?: ReactNode;
}) {
  return (
    <div className="panel ov-kpi">
      <div className="ov-kpi__row">
        <span className="eyebrow">{label}</span>
        {right}
      </div>
      <div className="big-num">
        {value}
        <small>{unit}</small>
      </div>
      {trend ? <TrendLine data={trend} height={34} color={color} min={0} /> : <div className="ov-kpi__foot">{foot}</div>}
    </div>
  );
}

/** Three fleet-wide KPI tiles computed from live snapshots. */
export function FleetKpis({
  sparks,
  snapshotKey = sparks,
}: {
  sparks: SparkSnapshot[];
  /**
   * Identity of the snapshot the sparks came from. A trend sample is added when this changes
   * (a snapshot arrived), not when `sparks` is merely re-filtered by the search box.
   */
  snapshotKey?: unknown;
}) {
  const totals = useMemo(() => computeFleetTotals(sparks), [sparks]);
  const totalsRef = useRef(totals);
  totalsRef.current = totals;
  const [trends, setTrends] = useState<Trends>(persisted);
  // 24 h average draw from the persisted energy minute buckets. Distinct from
  // the Fleet energy card, which headlines the 24 h kWh total and the current
  // 30 s window; this tile headlines the average and keeps "now" as a chip.
  const [avgW24h, setAvgW24h] = useState<number | null>(null);

  useEffect(() => {
    const t = totalsRef.current;
    setTrends((prev) => {
      const next = {
        decode: pushRolling(prev.decode, t.decodeTps),
        power: pushRolling(prev.power, t.powerW),
        mem: pushRolling(prev.mem, t.memUsedMb / 1024),
      };
      persisted = next;
      return next;
    });
  }, [snapshotKey]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchFleetEnergy()
        .then((res) => {
          if (cancelled) return;
          const hours = (res.hourlyWatts24h ?? []).filter((w): w is number => w != null);
          setAvgW24h(hours.length > 0 ? Math.round(hours.reduce((a, b) => a + b, 0) / hours.length) : null);
        })
        .catch(() => {
          if (!cancelled) setAvgW24h(null);
        });
    void load();
    const t = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  const memGb = totals.memUsedMb / 1024;
  const memPct = totals.memTotalMb > 0 ? Math.round((totals.memUsedMb / totals.memTotalMb) * 100) : null;

  return (
    <div className="ov-kpis">
      <Kpi
        label="Fleet decode"
        value={totals.decodeTps.toFixed(1)}
        unit="tok/s"
                trend={trends.decode}
        color="var(--color-accent)"
      />
      <Kpi
        label="Fleet power"
        value={totals.powerW.toFixed(0)}
        unit="W"
        right={
          avgW24h != null ? (
            <span className="ov-delta mono" title="Average draw over the last 24 hours (persisted energy minute buckets)">
              24h {avgW24h} W
            </span>
          ) : undefined
        }
        trend={trends.power}
        color="var(--color-violet)"
      />
      <Kpi
        label="Memory in use"
        value={memGb.toFixed(0)}
        unit="GB"
        right={memPct != null ? <span className="ov-delta mono">{memPct}%</span> : undefined}
        trend={trends.mem}
        color="var(--color-info)"
      />
      <Kpi
        label="Online"
        value={String(totals.online)}
        unit={`/ ${totals.total} units`}
        foot={totals.online === totals.total ? "all units reachable" : `${totals.total - totals.online} offline`}
        color="var(--color-success)"
      />
    </div>
  );
}
