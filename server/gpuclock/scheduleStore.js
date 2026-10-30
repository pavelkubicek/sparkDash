/**
 * The persisted fleet GPU clock schedule (config/gpu-clock-schedule.json).
 *
 * Its own file, like autopower.json: `PUT /api/settings` replaces the whole
 * settings object, so a schedule kept there would be reverted by any Settings
 * Save that started before the schedule changed. This store also survives a
 * hand-edited or damaged file: invalid windows fall back to the shipped default
 * instead of leaving the fleet with a half-parsed day.
 */
import fs from "fs";
import { GPU_CLOCK_SCHEDULE_PATH } from "../config.js";
import { atomicWrite } from "../util/atomicWrite.js";
import {
  defaultGpuClockSchedule,
  normalizeGpuClockSchedule,
  validateGpuClockSchedule,
} from "../../src/shared/gpuClockSchedule.js";

let _config = null;

function readFromDisk() {
  try {
    return JSON.parse(fs.readFileSync(GPU_CLOCK_SCHEDULE_PATH, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("[gpu-clock] failed to load the schedule:", err.message);
    }
    return defaultGpuClockSchedule();
  }
}

function persist() {
  try {
    atomicWrite(GPU_CLOCK_SCHEDULE_PATH, JSON.stringify(_config, null, 2) + "\n", 0o644);
  } catch (err) {
    console.error("[gpu-clock] failed to save the schedule:", err.message);
  }
}

/** Lazy: importing the server never fails when the file is absent. */
export function loadGpuClockSchedule() {
  _config = normalizeGpuClockSchedule(readFromDisk());
  persist();
  return getGpuClockSchedule();
}

export function getGpuClockSchedule() {
  if (_config == null) _config = normalizeGpuClockSchedule(readFromDisk());
  return { ..._config, windows: _config.windows.map((w) => ({ ...w })) };
}

/**
 * Validate and persist a schedule. Throws with `status: 400` on any invalid
 * field so the dialog shows every reason instead of a silently-clamped save.
 */
export function saveGpuClockSchedule(raw) {
  const check = validateGpuClockSchedule(raw);
  if (!check.ok) {
    const err = new Error(check.errors.join("; "));
    err.status = 400;
    throw err;
  }
  _config = check.config;
  persist();
  return getGpuClockSchedule();
}
