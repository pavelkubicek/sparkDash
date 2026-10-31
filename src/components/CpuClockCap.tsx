import { useCallback, useEffect, useRef, useState } from "react";
import { fetchCpuClock, fetchSparks, resetFleetCpuClock, setFleetCpuClock } from "../api/client";
import type { CpuClockCoreMode, CpuClockStatus, FleetCpuClockResult } from "../api/types";

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

/** The cap an installed boot hook keeps, or null with no hook, false when broken. */
type Hook = { maxMHz: number | null; mode: CpuClockCoreMode | "custom" | null } | null | false;

/** What the Sparks report right now: one shared state, a mix, or nothing readable. */
type FleetNow =
  | {
      kind: "same";
      capMHz: number | null;
      mode: CpuClockCoreMode | null;
      units: number;
      unreadable: number;
      het: boolean;
      perfMax: number | null;
      allMax: number | null;
      perfCores: string | null;
      hooks: Hook[];
    }
  | {
      kind: "mixed";
      caps: (number | null)[];
      unreadable: number;
      het: boolean;
      perfMax: number | null;
      allMax: number | null;
    }
  | { kind: "unknown" };

type ReadyStatus = Extract<CpuClockStatus, { supported: true }>;

function hookOf(status: ReadyStatus): Hook {
  if (!status.service.installed && !status.cron.installed) return null;
  if (status.service.installed && status.cron.installed) return false;
  return status.service.installed
    ? { maxMHz: status.service.maxMHz, mode: status.service.mode }
    : { maxMHz: status.cron.maxMHz, mode: status.cron.mode };
}

/** The mode the unit is actually in: the recorded cap wins, then the boot hook. */
function modeOf(status: ReadyStatus): CpuClockCoreMode | null {
  if (status.capMode === "perf" || status.capMode === "all") return status.capMode;
  const hook = hookOf(status);
  return hook && (hook.mode === "perf" || hook.mode === "all") ? hook.mode : null;
}

/**
 * Fleet-wide CPU maximum-frequency cap in Settings. On a heterogeneous unit
 * (GB10: Cortex-X925 + Cortex-A725) the default is to cap only the performance
 * cores, the high-ceiling group; a toggle caps every core instead. Save applies
 * the picked state to each unit. Same transport and narrow-sudo rule as the GPU
 * cap.
 */
export function CpuClockCap({ apiRef, onPendingChange, readTimeoutMs = READ_TIMEOUT_MS }: CpuClockCapProps) {
  const [now, setNow] = useState<FleetNow | null>(null);
  /** The state the user picked. `undefined` = nothing picked. */
  const [picked, setPicked] = useState<number | null | undefined>(undefined);
  /** The last Save did not take everywhere; keep the pick pending for a retry. */
  const [unsettled, setUnsettled] = useState(false);
  const [capInput, setCapInput] = useState(String(DEFAULT_CAP_MHZ));
  const [persist, setPersist] = useState(false);
  /** Cap the performance cores only (the default on a heterogeneous CPU). */
  const [perfOnly, setPerfOnly] = useState(true);
  /** null while nothing could be read: unknown is not the same as refused. */
  const [canPersist, setCanPersist] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean; detail?: string } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const persistTouched = useRef(false);
  const perfTouched = useRef(false);
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
      const modes = ready.map(modeOf);
      const unreadable = statuses.filter((status) => !status).length;
      const het = ready.some((status) => status.heterogeneous);
      const perfMax = ready.map((status) => status.perfMaxMHz).find((v): v is number => typeof v === "number") ?? null;
      const allMax = ready.map((status) => status.allMaxMHz).find((v): v is number => typeof v === "number") ?? null;
      const persistOk = ready.length > 0 && ready.every((status) => status.persistKind !== "none");
      setCanPersist(ready.length === 0 ? null : persistOk);
      if (!persistTouched.current || !persistOk) setPersist(persistOk);
      if (!perfTouched.current) setPerfOnly(!modes.includes("all"));
      if (caps.length === 0) {
        setNow({ kind: "unknown" });
        return;
      }
      const first = caps[0];
      setNow(
        caps.every((cap) => cap === first) && modes.every((mode) => mode === modes[0])
          ? {
              kind: "same",
              capMHz: first,
              mode: modes[0],
              units: caps.length,
              unreadable,
              het,
              perfMax,
              allMax,
              perfCores: ready.find((status) => status.perfCores)?.perfCores ?? null,
              hooks: ready.map(hookOf),
            }
          : { kind: "mixed", caps, unreadable, het, perfMax, allMax },
      );
    } catch {
      if (mine !== latest.current) return;
      setNow({ kind: "unknown" });
    }
  }, [readUnit, readTimeoutMs]);

  useEffect(() => {
    void read();
  }, [read]);

  const wantMode: CpuClockCoreMode = perfOnly ? "perf" : "all";
  const shared = now?.kind === "same" ? now.capMHz : undefined;
  const wantHook = picked !== undefined && picked !== null && persist ? { maxMHz: picked, mode: wantMode } : null;
  const hookDiffers = (hook: Hook) => {
    if (hook === false) return true;
    if (wantHook === null) return hook !== null;
    return !hook || hook.maxMHz !== wantHook.maxMHz || hook.mode !== wantHook.mode;
  };
  const modeDiffers = picked !== null && now?.kind === "same" && now.mode !== null && now.mode !== wantMode;
  const pending =
    picked !== undefined &&
    (unsettled || now?.kind !== "same" || now.unreadable > 0 || picked !== shared || modeDiffers ||
      (now?.kind === "same" && now.hooks.some(hookDiffers)));

  useEffect(() => {
    onPendingChange?.(pending);
  }, [onPendingChange, pending]);

  const apply = useCallback(async () => {
    if (picked === undefined) return true;
    const maxMHz = picked;
    setBusy(true);
    setMsg(null);
    try {
      const res = maxMHz === null ? await resetFleetCpuClock() : await setFleetCpuClock(maxMHz, persist, perfOnly);
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
      const cores = perfOnly ? "performance cores" : "all cores";
      setMsg({
        ok: failed.length === 0 && !nothingChanged,
        text: nothingChanged
          ? failed.length
            ? `No unit completed the requested change — some changes may have applied${skipped.length ? `, ${skipped.length} skipped` : ""}`
            : `Nothing changed — 0 of ${res.results.length} units ${maxMHz === null ? "unlocked" : "capped"}`
          : maxMHz === null
            ? `Full CPU frequency — ${capped} of ${res.results.length} units`
            : `CPU capped at ${maxMHz} MHz on ${cores} — ${capped} of ${res.results.length} units${
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
  }, [picked, persist, perfOnly, read]);

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
  const limit = now?.kind === "same" ? (perfOnly ? now.perfMax : now.allMax) : null;
  const validCap =
    capInput.trim() !== "" &&
    Number.isInteger(capMHz) &&
    capMHz >= MIN_CAP_MHZ &&
    capMHz <= MAX_CAP_MHZ &&
    (limit === null || capMHz <= limit);
  const canChooseCores = now?.kind === "same" || now?.kind === "mixed" ? now.het : false;
  const modeText = (mode: CpuClockCoreMode | null) =>
    mode === "perf" ? " on performance cores" : mode === "all" ? " on all cores" : "";

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
          `Now: CPU capped at ${now.capMHz} MHz${modeText(now.mode)} on ${now.units} unit${
            now.units === 1 ? "" : "s"
          }${now.unreadable ? `, ${now.unreadable} unreadable` : ""}`
        )}
      </p>
      {canChooseCores ? (
        <label className="gpu-clock__check">
          <input
            type="checkbox"
            aria-label="Performance cores only"
            checked={perfOnly}
            onChange={(e) => {
              perfTouched.current = true;
              setPerfOnly(e.target.checked);
              // Re-target the cap that is already applied, so the toggle is
              // actionable through Save like a frequency pick.
              if (picked === undefined && typeof shared === "number") setPicked(shared);
            }}
            disabled={busy}
          />
          Performance cores only
          {now?.kind === "same" && now.perfMax !== null
            ? ` — caps the ${now.perfMax} MHz cores${now.perfCores ? ` (${now.perfCores})` : ""} and leaves the efficiency cores at their own limit`
            : " — caps the high-frequency cores and leaves the efficiency cores at their own limit"}
        </label>
      ) : null}
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
          max={limit ?? MAX_CAP_MHZ}
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
