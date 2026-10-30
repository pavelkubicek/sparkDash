/**
 * gpuClockSchedule — pure config and time math for the fleet GPU clock presets.
 *
 * The fleet keeps one schedule: a list of daily windows that together cover the
 * whole day, each with the clock cap to hold while it is active. The same file
 * is used by the server (validation, status), the on-unit programs (spec text)
 * and the Settings dialog (preview), so a boundary is never computed twice.
 *
 * Window semantics are inherited from modelSchedules: half-open, wrap-aware,
 * `start === end` means the whole day. Validation additionally requires exact
 * coverage, because an uncovered minute would leave a GPU with no instructed cap.
 */
import {
  MINUTES_PER_DAY,
  findWindowOverlaps,
  nextBoundaryAt,
  normalizeWindow,
  windowCovers,
  zonedParts,
} from "./modelSchedules.js";

export const GPU_CLOCK_DEFAULT_TZ = "Europe/Prague";
export const GPU_CLOCK_MIN_MHZ = 300;
export const GPU_CLOCK_MAX_MHZ = 10000;
export const GPU_CLOCK_MAX_WINDOWS = 8;

/** The default schedule the proposal ships with: 2200 by day, 1900 by night. */
export function defaultGpuClockSchedule() {
  return {
    enabled: false,
    tz: GPU_CLOCK_DEFAULT_TZ,
    windows: [
      { start: "08:00", end: "20:00", maxMHz: 2200 },
      { start: "20:00", end: "08:00", maxMHz: 1900 },
    ],
  };
}

/** An IANA zone name; the same check the Settings time zone uses. */
export function isValidScheduleTimeZone(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value.trim() });
    return true;
  } catch {
    return false;
  }
}

/** Does every minute of the day belong to exactly one window? */
export function windowsCoverDay(windows) {
  const list = Array.isArray(windows) ? windows : [];
  if (!list.length) return false;
  for (let minute = 0; minute < MINUTES_PER_DAY; minute += 1) {
    let covered = 0;
    for (const w of list) if (windowCovers(w, minute)) covered += 1;
    if (covered !== 1) return false;
  }
  return true;
}

/**
 * Validate a raw schedule (request body or a hand-edited file).
 * @returns {{ ok: boolean, errors: string[], config: { enabled: boolean, tz: string, windows: { start: string, end: string, maxMHz: number }[] } }}
 */
export function validateGpuClockSchedule(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const errors = [];
  const tz = typeof src.tz === "string" ? src.tz.trim() : "";
  if (!isValidScheduleTimeZone(tz)) errors.push("tz must be an IANA time zone name such as Europe/Prague.");

  const list = Array.isArray(src.windows) ? src.windows : [];
  if (list.length === 0) errors.push("windows must list at least one time window.");
  if (list.length > GPU_CLOCK_MAX_WINDOWS) {
    errors.push(`windows may hold at most ${GPU_CLOCK_MAX_WINDOWS} entries.`);
  }
  const windows = [];
  const seen = new Set();
  list.forEach((entry, i) => {
    const w = normalizeWindow(entry);
    if (!w) {
      errors.push(`Window ${i + 1}: start and end must both be "HH:MM" (24-hour).`);
      return;
    }
    if (seen.has(w.key)) {
      errors.push(`Window ${i + 1}: duplicate ${w.label}.`);
      return;
    }
    seen.add(w.key);
    const maxMHz = entry?.maxMHz;
    if (!Number.isInteger(maxMHz) || maxMHz < GPU_CLOCK_MIN_MHZ || maxMHz > GPU_CLOCK_MAX_MHZ) {
      errors.push(
        `Window ${i + 1}: maxMHz must be a whole number from ${GPU_CLOCK_MIN_MHZ} to ${GPU_CLOCK_MAX_MHZ}.`,
      );
      return;
    }
    windows.push({ ...w, maxMHz });
  });

  for (const [a, b] of findWindowOverlaps(windows)) {
    errors.push(`Windows ${a.label} and ${b.label} overlap.`);
  }
  if (windows.length && !windowsCoverDay(windows)) {
    errors.push("windows must cover every minute of the day without gaps.");
  }

  return {
    ok: errors.length === 0,
    errors,
    config: {
      enabled: src.enabled === true,
      tz: tz || GPU_CLOCK_DEFAULT_TZ,
      windows: windows.map(({ start, end, maxMHz }) => ({ start, end, maxMHz })),
    },
  };
}

/** Clamp a persisted config into the stored shape; never throws. */
export function normalizeGpuClockSchedule(raw) {
  const def = defaultGpuClockSchedule();
  const tzOk = isValidScheduleTimeZone(raw?.tz);
  const windowsCheck = validateGpuClockSchedule({ tz: def.tz, windows: raw?.windows });
  return {
    enabled: raw?.enabled === true,
    tz: tzOk ? String(raw.tz).trim() : def.tz,
    windows: windowsCheck.ok ? windowsCheck.config.windows : def.windows,
  };
}

/** Normalized windows (startMin/endMin/wrap/fullDay) with their cap, for math. */
export function resolveGpuClockWindows(config) {
  const list = Array.isArray(config?.windows) ? config.windows : [];
  const out = [];
  for (const entry of list) {
    const w = normalizeWindow(entry);
    const maxMHz = entry?.maxMHz;
    if (!w || !Number.isInteger(maxMHz)) continue;
    out.push({ ...w, maxMHz });
  }
  return out;
}

/**
 * The cap in force at `nowMs` and the next boundary, in the schedule's zone.
 * @returns {{ maxMHz: number|null, start: string|null, end: string|null,
 *   nextChangeAt: number|null, nextChangeMHz: number|null }|null}
 */
export function gpuClockCapAt(config, nowMs) {
  const windows = resolveGpuClockWindows(config);
  if (!windows.length) return null;
  const tz = isValidScheduleTimeZone(config?.tz) ? config.tz.trim() : GPU_CLOCK_DEFAULT_TZ;
  const parts = zonedParts(nowMs, tz);
  const active = windows.find((w) => windowCovers(w, parts.minute)) || null;
  const next = nextBoundaryAt(new Date(nowMs), tz, windows);
  return {
    maxMHz: active ? active.maxMHz : null,
    start: active?.start ?? null,
    end: active?.end ?? null,
    nextChangeAt: next ? next.epochMs : null,
    // Windows tile the day, so every boundary is also a window start.
    nextChangeMHz: next ? windows.find((w) => w.startMin === next.minute)?.maxMHz ?? null : null,
  };
}

/** The spec file read by the on-unit program: `TZ=<zone>` then `start end cap` minutes. */
export function formatGpuClockSpec(config) {
  const tz = isValidScheduleTimeZone(config?.tz) ? config.tz.trim() : GPU_CLOCK_DEFAULT_TZ;
  const lines = [`TZ=${tz}`];
  for (const w of resolveGpuClockWindows(config)) {
    lines.push(`${w.startMin} ${w.endMin} ${w.maxMHz}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Compact form the status program prints: `480:1200:2200,1200:480:1900`. */
export function formatGpuClockWindows(windows) {
  const list = Array.isArray(windows) ? windows : [];
  return list
    .filter((w) => Number.isInteger(w?.startMin) && Number.isInteger(w?.endMin) && Number.isInteger(w?.maxMHz))
    .map((w) => `${w.startMin}:${w.endMin}:${w.maxMHz}`)
    .join(",");
}

/** Parse the compact status form back into stored windows. */
export function parseGpuClockWindows(text) {
  const out = [];
  for (const chunk of String(text ?? "").split(",")) {
    const m = /^(\d{1,4}):(\d{1,4}):(\d{1,6})$/.exec(chunk.trim());
    if (!m) continue;
    const startMin = Number(m[1]);
    const endMin = Number(m[2]);
    const maxMHz = Number(m[3]);
    if (startMin > MINUTES_PER_DAY - 1 || endMin > MINUTES_PER_DAY - 1) continue;
    if (maxMHz < GPU_CLOCK_MIN_MHZ || maxMHz > GPU_CLOCK_MAX_MHZ) continue;
    out.push({ start: fmt(startMin), end: fmt(endMin), maxMHz });
  }
  return out;
}

function fmt(minute) {
  const m = Math.min(MINUTES_PER_DAY - 1, Math.max(0, Math.trunc(Number(minute) || 0)));
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
