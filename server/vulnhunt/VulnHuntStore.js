import fs from "fs";
import path from "path";
import zlib from "zlib";
import { atomicWrite } from "../util/atomicWrite.js";

const MAX_RUNS = 100;
const RUN_ID_RE = /^vh-[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/;

export function isValidRunId(id) {
  return typeof id === "string" && RUN_ID_RE.test(id);
}

/** New scan id: sortable by time, short random suffix (also the unit-side directory name). */
export function newRunId(now = Date.now(), rand = Math.random) {
  const d = new Date(now).toISOString();
  const date = d.slice(0, 10).replace(/-/g, "");
  const time = d.slice(11, 19).replace(/:/g, "");
  const suffix = Math.floor(rand() * 36 ** 4).toString(36).padStart(4, "0");
  return `vh-${date}-${time}-${suffix}`;
}

/**
 * Index of VulnHunter scans started from the dashboard (newest first) plus a local gzip cache
 * of each finished scan's report bundle, so history stays readable while the unit is off.
 * The index only carries headline numbers; the findings live in the cached bundle.
 */
export class VulnHuntStore {
  constructor({ file, resultsDir }) {
    this.file = file;
    this.resultsDir = resultsDir;
    /** @type {object[]} */
    this.runs = [];
    this._load();
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (parsed && Array.isArray(parsed.runs)) this.runs = parsed.runs.filter((r) => r && isValidRunId(r.id));
    } catch {
      this.runs = [];
    }
  }

  _save() {
    atomicWrite(this.file, JSON.stringify({ version: 1, runs: this.runs }, null, 1) + "\n", 0o600);
  }

  list({ sparkId } = {}) {
    return this.runs.filter((r) => !sparkId || r.sparkId === sparkId).map((r) => ({ ...r }));
  }

  get(id) {
    const r = this.runs.find((x) => x.id === id);
    return r ? { ...r } : null;
  }

  add(run) {
    this.runs.unshift({ ...run });
    let evicted = [];
    if (this.runs.length > MAX_RUNS) {
      evicted = this.runs.splice(MAX_RUNS);
      for (const old of evicted) this._dropBundle(old.id);
    }
    this._save();
    return evicted;
  }

  update(id, patch) {
    const i = this.runs.findIndex((r) => r.id === id);
    if (i < 0) return null;
    this.runs[i] = { ...this.runs[i], ...patch };
    this._save();
    return { ...this.runs[i] };
  }

  remove(id) {
    const before = this.runs.length;
    this.runs = this.runs.filter((r) => r.id !== id);
    this._dropBundle(id);
    if (this.runs.length !== before) this._save();
    return this.runs.length !== before;
  }

  removeSpark(sparkId) {
    const gone = this.runs.filter((r) => r.sparkId === sparkId);
    if (!gone.length) return;
    this.runs = this.runs.filter((r) => r.sparkId !== sparkId);
    for (const r of gone) this._dropBundle(r.id);
    this._save();
  }

  _bundlePath(id) {
    return path.join(this.resultsDir, `${id}.json.gz`);
  }

  _dropBundle(id) {
    try {
      fs.unlinkSync(this._bundlePath(id));
    } catch {
      /* not cached */
    }
  }

  /** `bundle`: { report: string, findings: object[], artifacts: string[], manifest: object|null }. */
  saveBundle(id, bundle) {
    if (!isValidRunId(id) || !this.runs.some((r) => r.id === id)) return false;
    fs.mkdirSync(this.resultsDir, { recursive: true });
    atomicWrite(this._bundlePath(id), zlib.gzipSync(Buffer.from(JSON.stringify(bundle), "utf8")), 0o600);
    return true;
  }

  loadBundle(id) {
    if (!isValidRunId(id)) return null;
    try {
      return JSON.parse(zlib.gunzipSync(fs.readFileSync(this._bundlePath(id))).toString("utf8"));
    } catch {
      return null;
    }
  }
}
