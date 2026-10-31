import { useCallback, useEffect, useRef, useState } from "react";
import { fetchCpuClock, fetchSparks, resetFleetCpuClock, setFleetCpuClock } from "../api/client";
import type { CpuClockStatus, FleetCpuClockResult } from "../api/types";

const DEFAULT_CAP_MHZ = 2808;
const MIN_CAP_MHZ = 300;
const MAX_CAP_MHZ = 10000;
const READ_TIMEOUT_MS = 6000;

/** Resolves null after `ms`, so a stalled read can be raced and counted. */
const afterNull = (ms: number) => new Promise<null>((resolve) => window.setTimeout(() => resolve(null), ms));

/** What the row hands the dialog: Save owns when a pick is applied. */
export interface CpuClockApi {
  /** True while a pick waits for Save or the last Save did not take. */
  pending(): boolean;
  /** Apply the picked state. Resolves false unless every unit took it and at least one did. */
  apply(): Promise<boolean>;
}

interface CpuClockCapProps {
  apiRef?: { current: CpuClockApi | null };
  onPendingChange?: (pending: boolean) => void;
  readTimeoutMs?: number;
}

/** The cap a unit's installed boot hook keeps: null with no hook, false when broken. */
type BootHook = number | null | false;

/** What the Sparks report right now: one shared cap, a mix, or nothing readable. */
type FleetNow =
  | { kind: "same"; capMHz: number | null; units: number; unreadable: number; boots: BootHook[] }
  | { kind: "mixed"; caps: (number | null)[]; unreadable: number }
  | { kind: "unknown" };

type ReadyStatus = Extract<CpuClockStatus, { supported: true }>;

function bootHook({ service, cron }: ReadyStatus): BootHook {
  if (!service.installed && !cron.installed) return null;
  if (service.installed && cron.installed) return false;
  const maxMHz = service.installed
    ? service.enabled === "enabled" ? service.maxMHz : null
    : cron.failed ? null : cron.maxMHz;
  return maxMHz;
}

/**
 * Fleet-wide CPU maximum-frequency cap in Settings. Two states — Full capacity
 * or a MHz value — with the one every Spark is on marked; Save applies it to
 * each unit. Same transport and narrow-sudo rule as the GPU cap.
 */
export function CpuClockCap({ apiRef, onPendingChange, readTimeoutMs = READ_TIMEOUT_MS }: CpuClockCapProps) {
  const [now, setNow] = useState<FleetNow | null>(null);
  /** The state the user picked. `undefined` = nothing picked. */
  const [picked, setPicked] = useState<number | null | undefined>(undefined);
  /** The last Save did not take everywhere; keep the pick pending for a retry. */
  const [unsettled, setUnsettled] = useState(false);
  const [capInput, setCapInput] = useState(String(DEFAULT_CAP_MHZ));
  const [persist, setPersist] = useState(false);
  /** null while nothing could be read: unknown is not the same as refused. */
  const [canPersist, setCanPersist] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean; detail?: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const persistTouched = useRef(false);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const readUnit = useCallback(
    async (id: string) => {
      try {
        return await Promise.race([fetchCpuClock(id).catch(() => null), afterNull(readTimeoutMs)]);
      } catch {
        return null;
      }
    },
    [readTimeoutMs],
  );

  const latest = useRef(0);
  useEffect(
    () => () => {
      latest.current += 1;
    },
    [],
  );

  const read = useCallback(async () => {
    const mine = ++latest.current;
    try {
      const res = await Promise.race([fetchSparks(), afterNull(readTimeoutMs)]);
      if (mine !== latest.current) return;
      if (!res) {
        setNow({ kind: "unknown" });
        return;
      }
      const ids = res.sparks
        .filter((spark) => spark.kind !== "host" && spark.platform !== "darwin" && spark.platform !== "windows")
        .map((spark) => spark.id);
      const statuses = await Promise.all(ids.map(readUnit));
      const retried = await Promise.all(ids.map((id, i) => (statuses[i] === null ? readUnit(id) : null)));
      retried.forEach((status, i) => {
        if (status) statuses[i] = status;
      });
      if (mine !== latest.current) return;

      const ready = statuses.filter((status): status is ReadyStatus => Boolean(status?.supported));
      const caps = ready.map((status) => status.capMHz);
      const unreadable = statuses.filter((status) => !status).length;
      const persistOk = ready.length > 0 && ready.every((status) => status.persistKind !== "none");
      setCanPersist(ready.length === 0 ? null : persistOk);
      if (!persistTouched.current || !persistOk) setPersist(persistOk);
      if (caps.length === 0) {
        setNow({ kind: "unknown" });
        return;
      }
      const first = caps[0];
      setNow(
        caps.every((cap) => cap === first)
          ? { kind: "same", capMHz: first, units: caps.length, unreadable, boots: ready.map(bootHook) }
          : { kind: "mixed", caps, unreadable },
      );
    } catch {
      if (mine !== latest.current) return;
      setNow({ kind: "unknown" });
    }
  }, [readUnit, readTimeoutMs]);

  useEffect(() => {
    void read();
  }, [read]);

  const shared = now?.kind === "same" ? now.capMHz : undefined;
  const wantHook = picked !== undefined && picked !== null && persist ? picked : null;
  const pending =
    picked !== undefined &&
    (unsettled || now?.kind !== "same" || now.unreadable > 0 || picked !== shared ||
      now.boots.some((hook) => hook !== wantHook));

  useEffect(() => {
    onPendingChange?.(pending);
  }, [onPendingChange, pending]);

  const apply = useCallback(async () => {
    if (picked === undefined) return true;
    const maxMHz = picked;
    setBusy(true);
    setMsg(null);
    try {
      const res = maxMHz === null ? await resetFleetCpuClock() : await setFleetCpuClock(maxMHz, persist);
      const capped = res.results.filter((r) => r.ok && !("supported" in r)).length;
      const skipped = res.results.filter(
        (r): r is Extract<FleetCpuClockResult, { supported: false }> => "supported" in r && r.supported === false,
      );
      const failed = res.results.filter((r): r is Extract<FleetCpuClockResult, { ok: false }> => !r.ok);
      const detail = [
        ...failed.map((r) => `${r.id}: ${r.error}`),
        ...skipped.map((r) => `${r.id}: skipped — ${r.reason}`),
      ].join("; ");
      const nothingChanged = capped === 0;
      setMsg({
        ok: failed.length === 0 && !nothingChanged,
        text: nothingChanged
          ? failed.length
            ? `No unit completed the requested change — some changes may have applied${skipped.length ? `, ${skipped.length} skipped` : ""}`
            : `Nothing changed — 0 of ${res.results.length} units ${maxMHz === null ? "unlocked" : "capped"}`
          : `${maxMHz === null ? "Full CPU frequency" : `CPU capped at ${maxMHz} MHz`} — ${capped} of ${res.results.length} units${
              skipped.length ? `, ${skipped.length} skipped` : ""
            }`,
        detail: detail || undefined,
      });
      const took = failed.length === 0 && !nothingChanged;
      if (took) {
        setPicked(undefined);
        setUnsettled(false);
      } else {
        setUnsettled(true);
      }
      void read();
      return took;
    } catch (err: unknown) {
      setMsg({
        ok: false,
        text: err instanceof Error ? err.message : "CPU clock request failed",
      });
      setUnsettled(true);
      return false;
    } finally {
      setBusy(false);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setMsg(null), 12_000);
    }
  }, [picked, persist, read]);

  const pick = (state: number | null) => {
    if (state !== picked) setUnsettled(false);
    setPicked(state);
  };

  useEffect(() => {
    if (!apiRef) return;
    apiRef.current = { pending: () => pending, apply };
    return () => {
      apiRef.current = null;
    };
  }, [apiRef, pending, apply]);

  const capMHz = Number(capInput);
  const validCap = capInput.trim() !== "" && Number.isInteger(capMHz) && capMHz >= MIN_CAP_MHZ && capMHz <= MAX_CAP_MHZ;

  return (
    <div className="set-fleetcap">
      <p className="gpu-clock__now" data-testid="cpu-fleet-now">
        {now === null ? (
          "Reading the fleet…"
        ) : now.kind === "unknown" ? (
          "No unit reports its CPU limit right now — reopen Settings to try again."
        ) : now.kind === "mixed" ? (
          `Now: mixed — ${now.caps.map((cap) => (cap === null ? "full frequency" : `${cap} MHz`)).join(", ")}${
            now.unreadable ? `, ${now.unreadable} unreadable` : ""
          }`
        ) : now.capMHz === null ? (
          `Now: full CPU frequency on ${now.units} unit${now.units === 1 ? "" : "s"}${
            now.unreadable ? `, ${now.unreadable} unreadable` : ""
          }`
        ) : (
          `Now: CPU capped at ${now.capMHz} MHz on ${now.units} unit${now.units === 1 ? "" : "s"}${
            now.unreadable ? `, ${now.unreadable} unreadable` : ""
          }`
        )}
      </p>
      <div className="set-fleetcap__presets" role="group" aria-label="CPU clock cap states">
        <button
          type="button"
          className={`btn btn--sm${shared === null ? " is-current" : ""}${picked === null ? " is-picked" : ""}`}
          onClick={() => pick(null)}
          disabled={busy}
        >
          Full capacity
        </button>
        <button
          type="button"
          className={`btn btn--sm${shared === capMHz ? " is-current" : ""}${picked === capMHz ? " is-picked" : ""}`}
          onClick={() => pick(capMHz)}
          disabled={busy || !validCap}
        >
          Cap at {validCap ? capMHz : "…"} MHz
        </button>
      </div>
      <label className="gpu-clock__row">
        <span>Cap</span>
        <input
          type="number"
          min={MIN_CAP_MHZ}
          max={MAX_CAP_MHZ}
          inputMode="numeric"
          aria-label="CPU cap MHz"
          value={capInput}
          onChange={(e) => setCapInput(e.target.value)}
          disabled={busy}
        />
        <span className="gpu-clock__unit">MHz</span>
      </label>
      <label className="gpu-clock__check">
        <input
          type="checkbox"
          checked={persist}
          onChange={(e) => {
            persistTouched.current = true;
            setPersist(e.target.checked);
            if (picked === undefined && typeof shared === "number") setPicked(shared);
          }}
          disabled={busy || (canPersist === false && !persist)}
        />
        Keep after reboot — the state you pick also installs a boot hook on each unit
      </label>
      {canPersist === false ? (
        <p className="set-fleetcap__hint">
          Not offered here: these units have no boot hook the cap can use — neither a root shell for the boot service nor
          a running cron service for an @reboot job. The cap applies until the next reboot.
        </p>
      ) : null}
      {pending ? (
        <p className="set-fleetcap__hint">Not applied yet — press Save to change every unit.</p>
      ) : null}
      {busy ? <p className="set-fleetcap__hint">Applying…</p> : null}
      {msg ? (
        <p className={`set-fleetcap__msg${msg.ok ? "" : " is-err"}`} role="status" aria-live="polite">
          {msg.text}
          {msg.detail ? <span className="set-fleetcap__detail">{msg.detail}</span> : null}
        </p>
      ) : null}
    </div>
  );
}
