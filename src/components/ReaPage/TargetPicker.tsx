import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReaTarget } from "../../api/types";
import { collectDropped, candidatesFromInput } from "./dropped";
import { uploadTargetOf, useReaUpload, type UploadResult } from "./hooks";
import { Notice } from "./parts";
import { formatBytes, planUpload, targetLabel, unitPathProblem, uploadRelProblem, type UploadCandidate } from "./reaLogic";

export interface TargetPrefill {
  target: ReaTarget;
  nonce: number;
}

interface TargetPickerProps {
  sparkId: string;
  unitName: string;
  /** "Baseline assembly", "Target"... */
  label: string;
  limits: { maxBytes: number; maxFiles: number };
  allowPath: boolean;
  allowUpload: boolean;
  value: ReaTarget | null;
  onChange: (t: ReaTarget | null) => void;
  prefill?: TargetPrefill | null;
}

/** One target: a path on the unit, or files / a folder / an archive uploaded from this browser. */
export function TargetPicker({ sparkId, unitName, label, limits, allowPath, allowUpload, value, onChange, prefill }: TargetPickerProps) {
  const uid = useId();
  const [tab, setTab] = useState<"path" | "upload">(allowPath ? "path" : "upload");
  const [pathText, setPathText] = useState("");
  const [rel, setRel] = useState("");
  const [candidates, setCandidates] = useState<UploadCandidate[] | null>(null);
  const [walking, setWalking] = useState(false);
  const [dragging, setDragging] = useState(false);
  const up = useReaUpload(sparkId);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  const plan = useMemo(() => (candidates ? planUpload(candidates, limits) : null), [candidates, limits]);
  const pathProblem = unitPathProblem(pathText);
  const relProblem = uploadRelProblem(rel.trim());

  // The target for a tab, derived in one place. Handlers (not effects) call it, so a prefill can never be
  // overwritten by a tab effect firing in the same commit.
  const reusedRef = useRef<Extract<ReaTarget, { kind: "upload" }> | null>(null);
  const relRef = useRef(rel);
  relRef.current = rel;
  const targetFor = (which: "path" | "upload", text: string, relText: string, result: UploadResult | null): ReaTarget | null => {
    if (which === "path") {
      const v = text.trim();
      return !v || unitPathProblem(v) ? null : { kind: "path", value: v };
    }
    if (uploadRelProblem(relText.trim())) return null;
    if (result) return uploadTargetOf(result, relText);
    const reused = reusedRef.current;
    if (!reused) return null;
    const r = relText.trim();
    return r ? { kind: "upload", uploadId: reused.uploadId, relPath: r } : { kind: "upload", uploadId: reused.uploadId };
  };

  // Prefill from "Run again": the one place that sets tab, text and target together.
  useEffect(() => {
    if (!prefill) return;
    const t = prefill.target;
    if (t.kind === "path") {
      if (!allowPath) return;
      reusedRef.current = null;
      setTab("path");
      setPathText(t.value);
    } else {
      if (!allowUpload) return;
      reusedRef.current = t;
      setTab("upload");
      setRel(t.relPath ?? "");
    }
    changeRef.current(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  // A freshly committed upload becomes the target.
  useEffect(() => {
    if (up.result) {
      reusedRef.current = null;
      changeRef.current(uploadTargetOf(up.result as UploadResult, relRef.current));
    }
  }, [up.result]);

  const switchTab = (next: "path" | "upload") => {
    setTab(next);
    changeRef.current(targetFor(next, pathText, rel, up.result as UploadResult | null));
  };

  const take = (list: UploadCandidate[]) => {
    reusedRef.current = null;
    up.reset();
    changeRef.current(null);
    setCandidates(list);
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (up.phase === "uploading" || up.phase === "committing") return;
    setWalking(true);
    try {
      take(await collectDropped(e.dataTransfer, limits.maxFiles + 1));
    } catch {
      take([]);
    } finally {
      setWalking(false);
    }
  };

  const busy = up.phase === "uploading" || up.phase === "committing";
  const totalLoaded = up.files.reduce((n, f) => n + (f.status === "done" ? f.size : f.loaded), 0);
  const totalSize = up.files.reduce((n, f) => n + f.size, 0);
  const reused = value?.kind === "upload" && !up.result;

  return (
    <div className="rea-target" role="group" aria-label={label}>
      <div className="rea-target__head">
        <b>{label}</b>
        {allowPath && allowUpload ? (
          <div className="rea-tabs" role="tablist" aria-label={`${label} source`}>
            <button type="button" role="tab" aria-selected={tab === "path"} className={`rea-tab${tab === "path" ? " is-on" : ""}`} onClick={() => switchTab("path")}>
              Path on this unit
            </button>
            <button type="button" role="tab" aria-selected={tab === "upload"} className={`rea-tab${tab === "upload" ? " is-on" : ""}`} onClick={() => switchTab("upload")}>
              Upload
            </button>
          </div>
        ) : null}
      </div>

      {tab === "path" ? (
        <div className="rea-field">
          <label className="rea-label" htmlFor={`${uid}-path`}>
            Absolute path on {unitName}
          </label>
          <input
            id={`${uid}-path`}
            type="text"
            className="rea-mono"
            value={pathText}
            placeholder="~/samples/app.asar or /opt/tool/binary"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={pathProblem ? true : undefined}
            onChange={(e) => {
              setPathText(e.target.value);
              changeRef.current(targetFor("path", e.target.value, rel, null));
            }}
          />
          {pathProblem ? <p className="rea-hint is-warn">{pathProblem}</p> : <p className="rea-hint">A file or folder on the unit. Start with / or ~/.</p>}
        </div>
      ) : (
        <div className="rea-stack">
          <div
            className={`rea-drop${dragging ? " is-over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => void onDrop(e)}
          >
            <p>
              {walking ? "Reading the dropped folder…" : "Drop files or a folder here"}
              <span className="rea-faint"> — or choose them:</span>
            </p>
            <div className="rea-actions">
              <button type="button" className="btn btn--sm" disabled={busy} onClick={() => fileInput.current?.click()}>
                Choose files
              </button>
              <button type="button" className="btn btn--sm" disabled={busy} onClick={() => folderInput.current?.click()}>
                Choose folder
              </button>
            </div>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              aria-label={`${label}: choose files`}
              onChange={(e) => {
                take(candidatesFromInput(e.target.files));
                e.target.value = "";
              }}
            />
            <input
              ref={folderInput}
              type="file"
              multiple
              hidden
              aria-label={`${label}: choose a folder`}
              {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
              onChange={(e) => {
                take(candidatesFromInput(e.target.files));
                e.target.value = "";
              }}
            />
            <p className="rea-hint">
              Up to {limits.maxFiles.toLocaleString()} files and {formatBytes(limits.maxBytes)} per upload. .zip, .tar, .tar.gz and .tgz archives are
              extracted on the unit. Names are limited to letters, digits, . _ - (anything else becomes _).
            </p>
          </div>

          {plan && up.phase === "idle" ? (
            <div className="rea-stack">
              {plan.problems.length ? (
                <Notice tone="bad" title="This selection cannot be uploaded">
                  <ul className="rea-problems">
                    {plan.problems.slice(0, 5).map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </Notice>
              ) : (
                <>
                  <p className="rea-muted">
                    {plan.entries.length.toLocaleString()} file{plan.entries.length === 1 ? "" : "s"}, {formatBytes(plan.totalBytes)}
                    {plan.entries.some((e) => e.archive) ? " (archives are extracted on the unit)" : ""}
                    {plan.adjusted ? `. ${plan.adjusted} name${plan.adjusted === 1 ? "" : "s"} had characters replaced by _` : ""}.
                  </p>
                  <div className="rea-actions">
                    <button type="button" className="btn btn--primary" onClick={() => void up.start(plan.entries)}>
                      Upload {plan.entries.length === 1 ? plan.entries[0].relPath : `${plan.entries.length} files`}
                    </button>
                    <button type="button" className="btn btn--ghost" onClick={() => setCandidates(null)}>
                      Clear
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : null}

          {busy || up.phase === "error" ? (
            <div className="rea-stack" aria-live="polite">
              <label className="rea-label" htmlFor={`${uid}-total`}>
                Total {formatBytes(totalLoaded)} of {formatBytes(totalSize)}
                {up.phase === "committing" ? " — committing…" : ""}
              </label>
              <progress id={`${uid}-total`} className="rea-progress" value={totalLoaded} max={Math.max(totalSize, 1)} />
              <ul className="rea-files">
                {up.files.slice(0, 50).map((f) => (
                  <li key={f.relPath} className={`rea-file is-${f.status}`}>
                    <span className="rea-mono rea-file__name">{f.relPath}</span>
                    <progress className="rea-progress rea-progress--sm" value={f.status === "done" ? f.size : f.loaded} max={Math.max(f.size, 1)} aria-label={`Progress of ${f.relPath}`} />
                    <small className="rea-faint">{f.status === "error" ? (f.error ?? "failed") : f.status}</small>
                  </li>
                ))}
              </ul>
              {up.files.length > 50 ? <p className="rea-hint">…and {up.files.length - 50} more files.</p> : null}
              {up.phase === "error" && up.error ? (
                <Notice tone="bad" title="The upload failed">
                  {up.error}
                </Notice>
              ) : null}
              <div className="rea-actions">
                {busy ? (
                  <button type="button" className="btn btn--danger" onClick={up.cancel}>
                    Cancel upload
                  </button>
                ) : (
                  <button type="button" className="btn" onClick={() => { up.reset(); setCandidates(null); }}>
                    Start over
                  </button>
                )}
              </div>
            </div>
          ) : null}

          {up.result ? (
            <div className="rea-stack">
              <p className="rea-ok" role="status">
                Uploaded {up.result.files.toLocaleString()} file{up.result.files === 1 ? "" : "s"} ({formatBytes(up.result.bytes)})
                {up.result.extracted ? ", archive extracted" : ""}. Root on the unit: <code>{up.result.root}</code>
              </p>
              <div className="rea-field">
                <label className="rea-label" htmlFor={`${uid}-rel`}>
                  Inside the upload <span className="rea-faint">(optional, a file or folder path within it)</span>
                </label>
                <input id={`${uid}-rel`} type="text" className="rea-mono" value={rel} autoComplete="off" spellCheck={false} placeholder={up.result.relPath ?? "e.g. extracted/app.asar"} aria-invalid={relProblem ? true : undefined} onChange={(e) => {
                    setRel(e.target.value);
                    changeRef.current(targetFor("upload", pathText, e.target.value, up.result as UploadResult | null));
                  }} />
                {relProblem ? <p className="rea-hint is-warn">{relProblem}</p> : null}
              </div>
              <div className="rea-actions">
                <button type="button" className="btn btn--sm btn--ghost" onClick={() => { reusedRef.current = null; up.reset(); setCandidates(null); changeRef.current(null); }}>
                  Choose something else
                </button>
              </div>
            </div>
          ) : null}

          {reused && value ? (
            <p className="rea-muted" role="status">
              Using the earlier upload <code>{targetLabel(value)}</code>. It is still there only if it has not expired; the server will say if it is gone.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}
