export const GPU_CLOCK_DEFAULT_TZ: string;
export const GPU_CLOCK_MIN_MHZ: number;
export const GPU_CLOCK_MAX_MHZ: number;
export const GPU_CLOCK_MAX_WINDOWS: number;

export interface GpuClockScheduleWindow {
  /** "HH:MM" 24-hour local time. */
  start: string;
  end: string;
  maxMHz: number;
}

export interface GpuClockSchedule {
  enabled: boolean;
  tz: string;
  windows: GpuClockScheduleWindow[];
}

export interface GpuClockScheduleValidation {
  ok: boolean;
  errors: string[];
  config: GpuClockSchedule;
}

export interface GpuClockCapAt {
  maxMHz: number | null;
  start: string | null;
  end: string | null;
  /** Epoch ms of the next window boundary, or null. */
  nextChangeAt: number | null;
  /** Cap that starts at that boundary. */
  nextChangeMHz: number | null;
}

export function defaultGpuClockSchedule(): GpuClockSchedule;
export function isValidScheduleTimeZone(value: unknown): value is string;
export function windowsCoverDay(windows: unknown[]): boolean;
export function validateGpuClockSchedule(raw: unknown): GpuClockScheduleValidation;
export function normalizeGpuClockSchedule(raw: unknown): GpuClockSchedule;
export function resolveGpuClockWindows(
  config: GpuClockSchedule
): Array<GpuClockScheduleWindow & { startMin: number; endMin: number; wrap: boolean; fullDay: boolean }>;
export function gpuClockCapAt(config: GpuClockSchedule, nowMs: number): GpuClockCapAt | null;
export function formatGpuClockSpec(config: GpuClockSchedule): string;
export function formatGpuClockWindows(
  windows: Array<{ startMin: number; endMin: number; maxMHz: number }>
): string;
export function parseGpuClockWindows(text: unknown): GpuClockScheduleWindow[];
