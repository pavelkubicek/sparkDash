import { useEffect, useMemo, useRef, useState } from "react";
import "../../styles/kiosk-kraken.css";
import {
  fetchAiProxyStats,
  fetchAuditorStatus,
  fetchOrchestratorPlans,
  fetchOrchestratorRunningTasks,
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
/** Carousel groups: two tiles per group, except the models list which takes the whole row. */
const SLIDE_GROUPS: ReadonlyArray<ReadonlyArray<"temp" | "tokens" | "orchestrator" | "auditor" | "models">> = [
  ["temp", "tokens"],
  ["orchestrator", "auditor"],
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
 * static (fleet tok/s, requests the serving engines run and wait on), the bottom row is a carousel that cycles
 * temperature, proxy tokens today, orchestrator running and auditor analyzing every 2 s
 * with a fade. Icon on the left, number on the right, nothing else; the sparkDash brand
 * sits above. Sized in vmin so it fills any square viewport. Like the big wall it holds
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

  const orchestratorRunning = usePolled(async () => (await fetchOrchestratorRunningTasks()).length, BRIDGE_REFRESH_MS);
  // Queued work: open tickets + plans still being generated (the Overview panel's active count).
  const orchestratorQueued = usePolled(async () => {
    const plans = await fetchOrchestratorPlans();
    return plans.filter((p) => p.status === "queued" || p.status === "processing" || p.status === "creating_ticket").length;
  }, BRIDGE_REFRESH_MS);
  const auditorRunning = usePolled(async () => (await fetchAuditorStatus()).analyzing, BRIDGE_REFRESH_MS);
  const auditorQueued = usePolled(async () => (await fetchAuditorStatus()).reviews_queued, BRIDGE_REFRESH_MS);
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
  // Groups show two at a time — (temp, tokens), (orchestrator, auditor) — and the models
  // list takes the whole row on its own.
  const slides: ReadonlyArray<{
    key: "temp" | "tokens" | "orchestrator" | "auditor" | "models";
    label: string;
    icon: React.ReactNode;
    value: string;
    /** Queued count shown as the small "/N" suffix beside the value. */
    queued: string | null;
  }> = [
    {
      key: "temp",
      label: "Hottest GPU temperature",
      icon: <ThermometerIcon className="kk-icon" />,
      value: stats.gpuTempMaxC == null ? "—" : tempText(stats.gpuTempMaxC, tempUnit),
      queued: null,
    },
    {
      key: "tokens",
      label: "Proxy tokens today",
      icon: <TokensIcon className="kk-icon" />,
      value: tokensToday == null ? "—" : formatTokensCompact(tokensToday),
      queued: null,
    },
    {
      key: "orchestrator",
      label: "Orchestrator running tasks",
      // Orchestrator mark — its repo favicon (green DGX-Spark network on the dark app tile).
      icon: (
        <svg className="kk-icon" viewBox="0 0 32 32" aria-hidden>
          <rect width="32" height="32" rx="6" fill="#0d1117" />
          <circle cx="16" cy="16" r="3" fill="#76b900" />
          <circle cx="10" cy="10" r="2" fill="#76b900" opacity="0.8" />
          <circle cx="22" cy="10" r="2" fill="#76b900" opacity="0.8" />
          <circle cx="10" cy="22" r="2" fill="#76b900" opacity="0.8" />
          <circle cx="22" cy="22" r="2" fill="#76b900" opacity="0.8" />
          <line x1="13.5" y1="13.5" x2="12" y2="12" stroke="#76b900" strokeWidth="1" opacity="0.6" />
          <line x1="18.5" y1="13.5" x2="20" y2="12" stroke="#76b900" strokeWidth="1" opacity="0.6" />
          <line x1="13.5" y1="18.5" x2="12" y2="20" stroke="#76b900" strokeWidth="1" opacity="0.6" />
          <line x1="18.5" y1="18.5" x2="20" y2="20" stroke="#76b900" strokeWidth="1" opacity="0.6" />
        </svg>
      ),
      value: orchestratorRunning == null ? "—" : String(orchestratorRunning),
      queued: orchestratorQueued ? String(orchestratorQueued) : null,
    },
    {
      key: "auditor",
      label: "Auditor analyzing",
      // Auditor mark — its repo favicon (orange scan hexagon on the dark app tile).
      icon: (
        <svg className="kk-icon" viewBox="0 0 32 32" aria-hidden>
          <rect width="32" height="32" rx="6" fill="#0d1117" />
          <path d="M16 4 L26 10 L26 22 L16 28 L6 22 L6 10 Z" fill="none" stroke="#f97316" strokeWidth="1.6" strokeLinejoin="round" />
          <path d="M16 10 L16 19" stroke="#f97316" strokeWidth="1.6" />
          <circle cx="16" cy="22.5" r="1.8" fill="#f97316" />
        </svg>
      ),
      value: auditorRunning == null ? "—" : String(auditorRunning),
      queued: auditorQueued ? String(auditorQueued) : null,
    },
    {
      key: "models",
      label: "Models the launcher is serving",
      icon: <ServerIcon className="kk-icon" />,
      // One or two long names: shrink to fit — the row is wide enough for the pair at half scale.
      value: activeModels == null ? "—" : activeModels.length ? activeModels.join(" · ") : "none",
      queued: null,
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
              {s.icon}
              <span className="kk-read">
                <span className="kk-value">
                  {s.value}
                  {s.queued ? <small className="kk-waiting">/{s.queued}</small> : null}
                </span>
              </span>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
