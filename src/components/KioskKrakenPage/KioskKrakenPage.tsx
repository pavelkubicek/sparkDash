import { useEffect, useMemo, useRef, useState } from "react";
import "../../styles/kiosk-kraken.css";
import {
  fetchAiProxyStats,
  fetchAuditorStatus,
  fetchOrchestratorStatus,
  fetchPrCompanionStatus,
  fetchSettings,
} from "../../api/client";
import { OVERVIEW_ID, idToPath } from "../../constants";
import { useSnapshot } from "../../hooks/useSnapshot";
import { formatTokensCompact } from "../../shared/tokenFormat";
import { activeTimeZone, setConfiguredTimeZone } from "../../shared/timeZone";
import { computeFleetTotals } from "../OverviewPage/fleetStats";
import { BoltIcon, ServerIcon, TokensIcon, ThermometerIcon } from "../ui/icons";
import { kioskFleetStats, parseKioskOptions } from "../KioskPage/kioskModel";

type TempUnit = "celsius" | "fahrenheit";

const SETTINGS_REFRESH_MS = 5 * 60_000;
/** Integration bridges: the Overview panels poll the same counters every 5 s. */
const BRIDGE_REFRESH_MS = 5_000;
/** Today's proxy token totals: a day-granular query, so a minute is plenty. */
const DAY_REFRESH_MS = 60_000;
/** How long one carousel group stays up before the next takes its place. */
const SLIDE_MS = 3_000;
/** Carousel groups: two tiles per group; the AI-slots bar and the models list each take the whole row. */
const SLIDE_GROUPS: ReadonlyArray<ReadonlyArray<"temp" | "tokens" | "slots" | "models">> = [
  ["temp", "tokens"],
  ["slots"],
  ["models"],
];

/** Today's date (YYYY-MM-DD) in the configured time zone — the day the proxy's own stats bucket by. */
function dateStrInTZ(now: Date): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: activeTimeZone() }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** A temperature for the round glass: whole degrees and just the degree mark, no unit letter. */
function tempText(c: number, unit: TempUnit): string {
  return unit === "fahrenheit" ? `${Math.round((c * 9) / 5 + 32)}°` : `${Math.round(c)}°`;
}

/**
 * Poll a bridge on an interval, keeping the last good reading when a poll fails —
 * the wall holds its frame rather than blanking. `undefined` until the first poll lands.
 * The loader is read through a ref so callers can pass fresh closures without re-arming the timer.
 */
function usePolled<T>(load: () => Promise<T>, ms: number): T | undefined {
  const loadRef = useRef(load);
  loadRef.current = load;
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const tick = () => {
      loadRef
        .current()
        .then((v) => {
          if (!cancelled) setValue(v);
        })
        .catch(() => {
          /* unreachable — keep the last reading */
        })
        .finally(() => {
          if (!cancelled) timer = window.setTimeout(tick, ms);
        });
    };
    void tick();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [ms]);
  return value;
}

/** Hide the cursor after a few seconds without movement; `true` while it is shown. */
function useCursorActive(): boolean {
  const [active, setActive] = useState(true);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    const poke = () => {
      setActive(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setActive(false), 3_000);
    };
    poke();
    window.addEventListener("mousemove", poke);
    window.addEventListener("touchstart", poke);
    return () => {
      window.removeEventListener("mousemove", poke);
      window.removeEventListener("touchstart", poke);
      window.clearTimeout(timer.current);
    };
  }, []);
  return active;
}

/** Keep the screen awake while the wall is visible; the lock is dropped whenever the tab is hidden. */
function useWakeLock() {
  useEffect(() => {
    const nav = navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } };
    if (!nav.wakeLock) return;
    let lock: { release(): Promise<void> } | null = null;
    let done = false;
    const take = () => {
      if (document.visibilityState !== "visible") return;
      nav.wakeLock!.request("screen").then(
        (l) => {
          if (done) void l.release();
          else lock = l;
        },
        () => {
          /* refused (battery saver, no user gesture): the wall still works */
        }
      );
    };
    take();
    document.addEventListener("visibilitychange", take);
    return () => {
      done = true;
      document.removeEventListener("visibilitychange", take);
      void lock?.release();
    };
  }, []);
}

/**
 * /kiosk-kraken: the wall for the round NZXT Kraken LCD. Four big tiles — the top row is
 * static (fleet tok/s, requests the serving engines run and wait on), the bottom row is a carousel that
 * cycles temperature + proxy tokens today, one full-width segmented bar of the AI slots acquired
 * across the shared orchestrator/auditor/PR-Companion pool, and the models list, every 3 s with a
 * fade. Tiles are icon + number; the slots slide is its "AI slots" caption, the big bar, and the "used / total" readout.
 * Sized in vmin so it fills any square viewport. Like the big wall it holds
 * its last frame when a poll fails, and Esc returns to the dashboard.
 */
export function KioskKrakenPage() {
  const options = useMemo(() => parseKioskOptions(window.location.search), []);
  const { sparks, models } = useSnapshot();
  const [tempUnit, setTempUnit] = useState<TempUnit>("celsius");
  const [slide, setSlide] = useState(0);
  const cursorActive = useCursorActive();
  useWakeLock();

  useEffect(() => {
    if (options.theme) document.documentElement.setAttribute("data-theme", options.theme);
  }, [options.theme]);

  useEffect(() => {
    document.title = "sparkDash · Kiosk Kraken";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") window.location.href = idToPath(OVERVIEW_ID);
    };
    const t = window.setInterval(() => setSlide((g) => (g + 1) % SLIDE_GROUPS.length), SLIDE_MS);
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchSettings()
        .then((s) => {
          if (cancelled) return;
          setConfiguredTimeZone(s.timeZone);
          setTempUnit(s.temperatureUnit === "fahrenheit" ? "fahrenheit" : "celsius");
        })
        .catch(() => {
          /* keep the last settings */
        });
    void load();
    const t = window.setInterval(load, SETTINGS_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);

  const totals = useMemo(() => computeFleetTotals(sparks), [sparks]);
  const stats = useMemo(() => kioskFleetStats(sparks), [sparks]);

  // The orchestrator, the auditor and the PR Companion SHARE one slot pool (the
  // orchestrator owns the config), so the carousel shows one bar instead of per-service
  // tiles — the AI developer card's footer math: acquired = each REACHABLE service's
  // slots_used (unreachable → 0, never a fabricated fill), total = the orchestrator's
  // slots_total, falling back to the auditor's, then the companion's. None reachable →
  // "— / —" and an empty track; each poll holds its last good frame meanwhile.
  const orchestratorStatus = usePolled(fetchOrchestratorStatus, BRIDGE_REFRESH_MS);
  const auditorStatus = usePolled(fetchAuditorStatus, BRIDGE_REFRESH_MS);
  const pcStatus = usePolled(fetchPrCompanionStatus, BRIDGE_REFRESH_MS);
  const anyReachable = orchestratorStatus != null || auditorStatus != null || pcStatus != null;
  const orchSlots = orchestratorStatus != null ? Math.max(0, orchestratorStatus.slots_used) : 0;
  const audSlots = auditorStatus != null ? Math.max(0, auditorStatus.slots_used) : 0;
  const pcSlots = pcStatus != null ? Math.max(0, pcStatus.slots_used) : 0;
  const slotsUsed = orchSlots + audSlots + pcSlots;
  const slotsTotal =
    (orchestratorStatus != null ? orchestratorStatus.slots_total : undefined) ??
    (auditorStatus != null ? auditorStatus.slots_total : undefined) ??
    (pcStatus != null ? pcStatus.slots_total : undefined) ??
    0;
  // Segment widths in paint order — green orchestrator, blue companion, orange auditor —
  // capped so the stacked trio can never overflow the track.
  const orchPct = slotsTotal > 0 ? Math.min(100, Math.round((orchSlots / slotsTotal) * 100)) : 0;
  const pcPct = slotsTotal > 0 ? Math.min(100 - orchPct, Math.round((pcSlots / slotsTotal) * 100)) : 0;
  const audPct =
    slotsTotal > 0 ? Math.min(100 - orchPct - pcPct, Math.round((audSlots / slotsTotal) * 100)) : 0;
  const tokensToday = usePolled(async () => {
    const today = dateStrInTZ(new Date());
    return (await fetchAiProxyStats(today, today)).totals.total_tokens;
  }, DAY_REFRESH_MS);
  // Models the launcher currently serves, by their short kiosk name — the WS snapshot's
  // models block, the same one the Model Launcher cards render their status from.
  const activeModels = useMemo(
    () => (models?.models ?? []).filter((m) => m.status.running).map((m) => m.kioskName || m.name),
    [models]
  );

  // The carousel slides, in cycle order; all stay mounted so the fade is a class flip.
  // The first group shows two tiles — (temp, tokens) — while the AI-slots bar and the
  // models list each take the whole row on their own.
  const slides: ReadonlyArray<{
    key: "temp" | "tokens" | "slots" | "models";
    label: string;
    icon: React.ReactNode;
    value: string;
  }> = [
    {
      key: "temp",
      label: "Hottest GPU temperature",
      icon: <ThermometerIcon className="kk-icon" />,
      value: stats.gpuTempMaxC == null ? "—" : tempText(stats.gpuTempMaxC, tempUnit),
    },
    {
      key: "tokens",
      label: "Proxy tokens today",
      icon: <TokensIcon className="kk-icon" />,
      value: tokensToday == null ? "—" : formatTokensCompact(tokensToday),
    },
    {
      key: "slots",
      label: "AI slots in use across the shared pool",
      // No icon — the captioned full-width bar below is the visual, with the readout under it.
      icon: null,
      value: anyReachable ? `${slotsUsed} / ${slotsTotal}` : "— / —",
    },
    {
      key: "models",
      label: "Models the launcher is serving",
      icon: <ServerIcon className="kk-icon" />,
      // One or two long names: shrink to fit — the row is wide enough for the pair at half scale.
      value: activeModels == null ? "—" : activeModels.length ? activeModels.join(" · ") : "none",
    },
  ];

  return (
    <div className={`kiosk-kraken${cursorActive ? "" : " is-idle"}`}>
      <main className="kk-face">
        <div className="kk-row">
          <section className="kk-tile kk-tile--tps" aria-label="Fleet decode tokens per second">
            <BoltIcon className="kk-icon" />
            <span className="kk-read">
              <span className="kk-value">{totals.decodeTps == null ? "—" : Math.round(totals.decodeTps).toLocaleString("en-US")}</span>
            </span>
          </section>
          <section className="kk-tile" aria-label="Requests the serving engines run, and waiting">
            {/* AI proxy mark — its repo favicon (blue target on the dark app tile). */}
            <svg className="kk-icon" viewBox="0 0 32 32" aria-hidden>
              <rect width="32" height="32" rx="6" fill="#0d1117" />
              <circle cx="16" cy="16" r="8" fill="none" stroke="#58a6ff" strokeWidth="2" />
              <circle cx="16" cy="16" r="3" fill="#58a6ff" />
              <path d="M16 8 L16 11 M16 21 L16 24 M8 16 L11 16 M21 16 L24 16" stroke="#58a6ff" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            <span className="kk-read">
              <span className="kk-value">
                {stats.running ?? "—"}
                {stats.running != null && stats.queued != null ? <small className="kk-waiting">/{stats.queued}</small> : null}
              </span>
            </span>
          </section>
        </div>
        <div className="kk-carousel">
          {slides.map((s) => (
            <section
              key={s.key}
              className={`kk-slide kk-slide--${s.key}${SLIDE_GROUPS[slide].includes(s.key) ? " is-active" : ""}`}
              aria-label={s.label}
              aria-hidden={!SLIDE_GROUPS[slide].includes(s.key)}
            >
              {s.key === "slots" ? (
                <>
                  {/* The slide's caption, above the bar; the section's aria-label already
                      names the slide, so the heading stays decorative. */}
                  <span className="kk-slots-heading" aria-hidden>AI slots</span>
                  {/* The centrepiece bar: fills sized inline as pool percentages; no fill at
                      all when no bridge is reachable — the track never fabricates a reading. */}
                  <span className="kk-slotbar" aria-hidden>
                    {orchPct > 0 && <span className="kk-slotbar-segment kk-slotbar-segment--orchestrator" style={{ width: `${orchPct}%` }} />}
                    {pcPct > 0 && <span className="kk-slotbar-segment kk-slotbar-segment--companion" style={{ width: `${pcPct}%` }} />}
                    {audPct > 0 && <span className="kk-slotbar-segment kk-slotbar-segment--auditor" style={{ width: `${audPct}%` }} />}
                  </span>
                  <span className="kk-read">
                    <span className="kk-value">{s.value}</span>
                  </span>
                </>
              ) : (
                <>
                  {s.icon}
                  <span className="kk-read">
                    <span className="kk-value">
                      {s.value}
                    </span>
                  </span>
                </>
              )}
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
