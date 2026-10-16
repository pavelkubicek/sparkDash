import fs from "fs";
import path from "path";
import zlib from "zlib";
import { atomicWrite, quarantineCorrupt } from "../util/atomicWrite.js";

const MAX_RUNS = 100;
const RUN_ID_RE = /^rea-[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/;
const UPLOAD_ID_RE = /^up-[0-9]{8}-[0-9]{6}-[a-z0-9]{6}$/;
const VIEW_HASH_RE = /^[a-f0-9]{16,64}$/;
const DEFAULT_MAX_VIEW_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_VIEWS = 200;

export function isValidRunId(id) {
  return typeof id === "string" && RUN_ID_RE.test(id);
}

export function isValidUploadId(id) {
  return typeof id === "string" && UPLOAD_ID_RE.test(id);
}

const stamp = (now) => {
  const d = new Date(now).toISOString();
  return `${d.slice(0, 10).replace(/-/g, "")}-${d.slice(11, 19).replace(/:/g, "")}`;
};

/** New run id: sortable by time, short random suffix (also the unit-side directory name). */
export function newRunId(now = Date.now(), rand = Math.random) {
  const suffix = Math.floor(rand() * 36 ** 4).toString(36).padStart(4, "0").slice(-4);
  return `rea-${stamp(now)}-${suffix}`;
}

/** New upload id (allocated by the server, never taken from a client). */
export function newUploadId(now = Date.now(), rand = Math.random) {
  const suffix = Math.floor(rand() * 36 ** 6).toString(36).padStart(6, "0").slice(-6);
  return `up-${stamp(now)}-${suffix}`;
}

/**
 * Index of REA runs started from the dashboard (newest first), a local gzip cache of each finished
 * run's result bundle, and a small LRU cache of paged views. The index carries headline numbers
 * only; result bodies live in the bundles, views in `<resultsDir>/views/<runId>/<hash>.json.gz`.
 * Everything on disk is private (0600).
 */
export class ReaStore {
  constructor({ file, resultsDir, maxViewBytes = DEFAULT_MAX_VIEW_BYTES, maxViews = DEFAULT_MAX_VIEWS }) {
    this.file = file;
    this.resultsDir = resultsDir;
    this.maxViewBytes = Number.isFinite(maxViewBytes) && maxViewBytes > 0 ? maxViewBytes : DEFAULT_MAX_VIEW_BYTES;
    this.maxViews = Number.isInteger(maxViews) && maxViews > 0 ? maxViews : DEFAULT_MAX_VIEWS;
    /** @type {object[]} */
    this.runs = [];
    this._load();
  }

  _load() {
    let text;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch {
      this.runs = [];
      return;
    }
    try {
      const parsed = JSON.parse(text);
      this.runs = parsed && Array.isArray(parsed.runs) ? parsed.runs.filter((r) => r && isValidRunId(r.id)).slice(0, MAX_RUNS) : [];
    } catch (err) {
      this.runs = [];
      quarantineCorrupt(this.file, "rea-store", err);
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

  /** @returns {object[]} the runs evicted to stay within MAX_RUNS (their cached files are removed) */
  add(run) {
    if (!run || !isValidRunId(run.id)) throw new Error("invalid run id");
    this.runs = this.runs.filter((r) => r.id !== run.id);
    this.runs.unshift({ ...run });
    let evicted = [];
    if (this.runs.length > MAX_RUNS) {
      evicted = this.runs.splice(MAX_RUNS);
      for (const old of evicted) this._dropFiles(old.id);
    }
    this._save();
    return evicted;
  }

  update(id, patch) {
    const i = this.runs.findIndex((r) => r.id === id);
    if (i < 0) return null;
    this.runs[i] = { ...this.runs[i], ...patch, id };
    this._save();
    return { ...this.runs[i] };
  }

  remove(id) {
    const before = this.runs.length;
    this.runs = this.runs.filter((r) => r.id !== id);
    this._dropFiles(id);
    if (this.runs.length !== before) this._save();
    return this.runs.length !== before;
  }

  removeSpark(sparkId) {
    const gone = this.runs.filter((r) => r.sparkId === sparkId);
    if (!gone.length) return;
    this.runs = this.runs.filter((r) => r.sparkId !== sparkId);
    for (const r of gone) this._dropFiles(r.id);
    this._save();
  }

  // ── bundles ────────────────────────────────────────────────────────────────

  _bundlePath(id) {
    return path.join(this.resultsDir, `${id}.json.gz`);
  }

  _viewDir(runId) {
    return path.join(this.resultsDir, "views", runId);
  }

  _dropFiles(id) {
    if (!isValidRunId(id)) return;
    try {
      fs.unlinkSync(this._bundlePath(id));
    } catch {
      /* not cached */
    }
    try {
      fs.rmSync(this._viewDir(id), { recursive: true, force: true });
    } catch {
      /* none */
    }
  }

  /** `bundle` is any JSON-serializable object (see ReaManager: size, sha256, summary, result text). */
  saveBundle(id, bundle) {
    if (!isValidRunId(id) || !this.runs.some((r) => r.id === id)) return false;
    fs.mkdirSync(this.resultsDir, { recursive: true, mode: 0o700 });
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

  // ── views (LRU by mtime, bounded by count and bytes) ───────────────────────

  _viewPath(runId, hash) {
    return path.join(this._viewDir(runId), `${hash}.json.gz`);
  }

  /** `json`: the view as text or as a value. Returns false when it was not stored. */
  saveView(runId, viewHash, json) {
    if (!isValidRunId(runId) || !VIEW_HASH_RE.test(String(viewHash)) || !this.runs.some((r) => r.id === runId)) return false;
    let text;
    try {
      text = typeof json === "string" ? json : JSON.stringify(json);
    } catch {
      return false;
    }
    if (typeof text !== "string") return false;
    const gz = zlib.gzipSync(Buffer.from(text, "utf8"));
    if (gz.length > this.maxViewBytes) return false;
    const file = this._viewPath(runId, viewHash);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    atomicWrite(file, gz, 0o600);
    this._touch(file);
    this._evictViews(file);
    return true;
  }

  /** Strictly increasing mtimes keep the LRU order exact even within one millisecond. */
  _touch(file) {
    this._tick = Math.max(Date.now(), (this._tick ?? 0) + 1);
    const t = new Date(this._tick);
    try {
      fs.utimesSync(file, t, t);
    } catch {
      /* order only */
    }
  }

  /** The parsed view, or null. A hit refreshes its place in the LRU order. */
  loadView(runId, viewHash) {
    if (!isValidRunId(runId) || !VIEW_HASH_RE.test(String(viewHash))) return null;
    const file = this._viewPath(runId, viewHash);
    try {
      const value = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString("utf8"));
      this._touch(file);
      return value;
    } catch {
      return null;
    }
  }

  _allViews() {
    const out = [];
    const root = path.join(this.resultsDir, "views");
    let runs = [];
    try {
      runs = fs.readdirSync(root);
    } catch {
      return out;
    }
    for (const r of runs) {
      let files = [];
      try {
        files = fs.readdirSync(path.join(root, r));
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".json.gz")) continue;
        const p = path.join(root, r, f);
        try {
          const st = fs.statSync(p);
          out.push({ path: p, mtime: st.mtimeMs, size: st.size });
        } catch {
          /* raced */
        }
      }
    }
    return out;
  }

  _evictViews(keep) {
    const all = this._allViews().sort((a, b) => a.mtime - b.mtime || (a.path === keep ? 1 : 0) - (b.path === keep ? 1 : 0));
    let bytes = all.reduce((n, v) => n + v.size, 0);
    let count = all.length;
    for (const v of all) {
      if (count <= this.maxViews && bytes <= this.maxViewBytes) break;
      if (v.path === keep) continue;
      try {
        fs.unlinkSync(v.path);
      } catch {
        /* gone */
      }
      count -= 1;
      bytes -= v.size;
    }
  }
}
