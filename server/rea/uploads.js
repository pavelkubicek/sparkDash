import { createRateLimiter } from "../validate.js";
import { ReaError } from "./ReaManager.js";
import { validateUploadId, validateUploadPath } from "./validate.js";
import { reaGuards } from "./routes.js";

/**
 * Upload routes for REA analysis targets (raw streaming PUT, no multipart, no new dependency).
 *
 *   POST   /api/sparks/:id/rea/uploads                                 -> 201 { uploadId, maxBytes, maxFiles }
 *   PUT    /api/sparks/:id/rea/uploads/:uploadId/files?path=<rel>[&archive=1]
 *                                                                      -> 200 { path, bytes, sha256 }
 *   POST   /api/sparks/:id/rea/uploads/:uploadId/commit                -> 200 { uploadId, root, files, bytes, extracted }
 *   DELETE /api/sparks/:id/rea/uploads/:uploadId                       -> 200 { success: true }
 *
 * WHERE TO MOUNT (server/index.js)
 *   `registerReaUploadRoutes` reads the request body itself (the PUT handler streams `req` into the
 *   unit), so it must run BEFORE `app.use(express.json())`: put it directly above that line (index.js
 *   currently has `app.use(express.json())` first in the Express section, then `/api/auth/status`,
 *   then `app.use(createAuthMiddleware())`). Because it sits ahead of the auth middleware, it applies
 *   authentication itself: pass `authMiddleware: createAuthMiddleware()` (required; registering
 *   without it throws, so a forgotten argument can never leave the routes open). That middleware
 *   also enforces the host guard.
 *
 *   `registerReaRoutes` (routes.js, everything else) goes after `createAuthMiddleware()`, next to
 *   `registerVulnHuntRoutes`.
 *
 * Rules: the feature must be turned on (403 otherwise); upload ids are allocated by the server and are
 * bound to the unit (another unit's id is a 404); paths are relative, conservative and never `.`/`..`;
 * `Content-Length` is required and checked against the cap before a byte is read; the body is
 * counted while streaming and aborted at the cap or when the browser disconnects (the `.part` is
 * removed); file contents are never logged or echoed.
 */

/** ReaError code -> HTTP status. */
const STATUS_BY_CODE = {
  "unknown-upload": 404,
  committed: 409,
  writing: 409,
  "too-big": 413,
  "too-many-files": 413,
  "invalid-path": 400,
  empty: 400,
  "archive-refused": 400,
  aborted: 499,
  timeout: 408,
  "unit-error": 502,
  "too-many-uploads": 429,
};

const clipText = (v, n = 300) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, n);

/** Send the response for a failed upload operation (nothing is sent twice or into a closed socket). */
function sendUploadError(res, err) {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  if (err instanceof ReaError) {
    const status = STATUS_BY_CODE[err.code] ?? 500;
    res.status(status).json({ error: clipText(err.message) || "The upload failed", code: err.code });
    return;
  }
  res.status(500).json({ error: "The upload failed" });
}

export function registerReaUploadRoutes(app, deps) {
  const { manager } = deps;
  if (typeof deps.authMiddleware !== "function") {
    throw new Error("registerReaUploadRoutes needs an authMiddleware: these routes run before the app-wide auth middleware");
  }
  const auth = deps.authMiddleware;
  const { gated, sparkOr404, limiter } = reaGuards(deps);
  const base = "/api/sparks/:id/rea/uploads";

  // Creating an upload is the scarce operation (it makes a directory on the unit): allowUpload,
  // 10/min per principal in index.js. Bytes have their own, generous limit; commit/delete share the
  // run limiter.
  const allowPut = deps.allowUploadPut ?? createRateLimiter(1200, 60_000);
  const limitedCreate = limiter((k) => deps.allowUpload(k), "Too many uploads; try again shortly");
  const limitedPut = limiter((k) => allowPut(k), "Too many file uploads; try again shortly");
  const limitedOther = limiter((k) => deps.allowRun(k));

  /** The unit and a well-formed upload id, or null after the answer was sent. */
  const target = (req, res) => {
    const spark = sparkOr404(req, res);
    if (!spark) return null;
    const id = validateUploadId(req.params.uploadId);
    if (!id.ok) {
      res.status(404).json({ error: "Upload not found" });
      return null;
    }
    return { spark, uploadId: id.value };
  };

  app.post(base, auth, async (req, res) => {
    const spark = sparkOr404(req, res);
    if (!spark) return;
    if (gated(res)) return;
    if (limitedCreate(req, res)) return;
    try {
      const up = await manager.createUpload(spark);
      res.status(201).json({ uploadId: up.uploadId, maxBytes: up.maxBytes, maxFiles: up.maxFiles });
    } catch (err) {
      sendUploadError(res, err);
    }
  });

  app.put(`${base}/:uploadId/files`, auth, async (req, res) => {
    const t = target(req, res);
    if (!t) return;
    if (gated(res)) return;
    if (limitedPut(req, res)) return;

    const path = validateUploadPath(req.query.path);
    if (!path.ok) return res.status(400).json({ error: path.error });
    const archiveParam = Array.isArray(req.query.archive) ? req.query.archive[0] : req.query.archive;
    const archive = archiveParam === "1" || archiveParam === "true";

    // Content-Length is required: the size is checked before any byte is read, and a chunked body
    // would have no size to check. (Content-Type is ignored: the body is always raw bytes.)
    const rawLength = req.headers["content-length"];
    if (typeof rawLength !== "string" || !/^[0-9]{1,15}$/.test(rawLength)) {
      res.set("Connection", "close");
      return res.status(411).json({ error: "A Content-Length header is required for uploads" });
    }
    const length = Number(rawLength);
    if (length > manager.uploadMaxBytes) {
      res.set("Connection", "close");
      return res.status(413).json({ error: `The file is larger than the upload limit (${manager.uploadMaxBytes} bytes)`, code: "too-big" });
    }

    try {
      const out = await manager.putUpload(t.spark, t.uploadId, path.value, req, {
        archive,
        ...(length > 0 ? { maxBytes: length } : {}),
      });
      if (res.headersSent || res.destroyed) return;
      res.json({ path: path.value, bytes: out.bytes, sha256: out.sha256 });
    } catch (err) {
      // On a disconnect the response has nowhere to go; the manager has already cleaned up.
      sendUploadError(res, err);
    }
  });

  app.post(`${base}/:uploadId/commit`, auth, async (req, res) => {
    const t = target(req, res);
    if (!t) return;
    if (gated(res)) return;
    if (limitedOther(req, res)) return;
    try {
      const done = await manager.commitUpload(t.spark, t.uploadId, {});
      res.json({ uploadId: t.uploadId, root: done.root, files: done.files, bytes: done.bytes, extracted: done.extracted === true });
    } catch (err) {
      sendUploadError(res, err);
    }
  });

  app.delete(`${base}/:uploadId`, auth, async (req, res) => {
    const t = target(req, res);
    if (!t) return;
    if (gated(res)) return;
    if (limitedOther(req, res)) return;
    try {
      const out = await manager.deleteUpload(t.spark, t.uploadId);
      res.json({ success: out.ok === true });
    } catch (err) {
      sendUploadError(res, err);
    }
  });
}
