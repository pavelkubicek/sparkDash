import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commitReaUpload,
  compareReaRuns,
  deleteReaRun,
  exportReaUrl,
  fetchReaView,
  putReaUploadFile,
  readReaInstallStream,
  stopReaRun,
} from "./client";
import { ReaApiError } from "./types";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("REA client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("builds the view query and the export url", async () => {
    const f = vi.fn().mockResolvedValue(json({ view: {} }));
    vi.stubGlobal("fetch", f);
    await fetchReaView("s 1", "rea-1", { collection: "modules", offset: 50, limit: 25 });
    expect(f.mock.calls[0][0]).toBe("/api/sparks/s%201/rea/runs/rea-1/view?collection=modules&offset=50&limit=25");
    expect(exportReaUrl("s1", "rea-1")).toBe("/api/sparks/s1/rea/runs/rea-1/export");
  });

  it("keeps status, busy job and canForce in ReaApiError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "still running", canForce: true, active: { id: "j" } }, 409)));
    const e = await deleteReaRun("s1", "rea-1").catch((x) => x);
    expect(e).toBeInstanceOf(ReaApiError);
    expect(e).toMatchObject({ status: 409, canForce: true, message: "still running", active: { id: "j" } });
  });

  it("uses force=1 only when forced and POSTs compare with both ids", async () => {
    const f = vi.fn().mockImplementation(async () => json({ success: true, result: {} }));
    vi.stubGlobal("fetch", f);
    await deleteReaRun("s1", "rea-1", true);
    expect(f.mock.calls[0][0]).toBe("/api/sparks/s1/rea/runs/rea-1?force=1");
    await compareReaRuns("s1", "a", "b");
    expect(f.mock.calls[1][1]).toMatchObject({ method: "POST", body: JSON.stringify({ leftRunId: "a", rightRunId: "b" }) });
  });

  it("stop rejects on success:false; install stream is null on 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ success: false, output: "not running" })));
    await expect(stopReaRun("s1", "rea-1")).rejects.toThrow(/not running/);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ error: "none" }, 404)));
    await expect(readReaInstallStream("s1")).resolves.toBeNull();
  });

  it("commit POSTs to the upload's commit route", async () => {
    const f = vi.fn().mockResolvedValue(json({ uploadId: "up", root: "/r", files: 1, bytes: 1, extracted: false }));
    vi.stubGlobal("fetch", f);
    await commitReaUpload("s1", "up-1");
    expect(f.mock.calls[0][0]).toBe("/api/sparks/s1/rea/uploads/up-1/commit");
    expect(f.mock.calls[0][1]).toMatchObject({ method: "POST" });
  });
});

class FakeXhr {
  static last: FakeXhr;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: unknown = null;
  status = 0;
  statusText = "";
  responseText = "";
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  aborted = false;
  constructor() {
    FakeXhr.last = this;
  }
  open(m: string, u: string) {
    this.method = m;
    this.url = u;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(b: unknown) {
    this.body = b;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
}

describe("putReaUploadFile", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the raw file body with path and archive flag, reports progress and resolves", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const file = new File(["abc"], "pack.zip");
    const progress = vi.fn();
    const p = putReaUploadFile("s1", "up-1", "dir/pack.zip", file, { archive: true, onProgress: progress });
    const x = FakeXhr.last;
    expect(x.method).toBe("PUT");
    expect(x.url).toBe("/api/sparks/s1/rea/uploads/up-1/files?path=dir%2Fpack.zip&archive=1");
    expect(x.body).toBe(file);
    expect(x.body).not.toBeInstanceOf(FormData);
    x.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 3 });
    expect(progress).toHaveBeenCalledWith(1, 3);
    x.status = 200;
    x.responseText = JSON.stringify({ path: "dir/pack.zip", bytes: 3, sha256: "x" });
    x.onload?.();
    await expect(p).resolves.toMatchObject({ bytes: 3 });
  });

  it("omits the archive flag for plain files and surfaces the server's error", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const p = putReaUploadFile("s1", "up-1", "a.bin", new File(["x"], "a.bin"));
    expect(FakeXhr.last.url).not.toContain("archive");
    FakeXhr.last.status = 413;
    FakeXhr.last.responseText = JSON.stringify({ error: "too big" });
    FakeXhr.last.onload?.();
    await expect(p).rejects.toMatchObject({ name: "ReaApiError", status: 413, message: "too big" });
  });

  it("aborts through the signal", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
    const ctl = new AbortController();
    const p = putReaUploadFile("s1", "up-1", "a.bin", new File(["x"], "a.bin"), { signal: ctl.signal });
    ctl.abort();
    expect(FakeXhr.last.aborted).toBe(true);
    await expect(p).rejects.toMatchObject({ status: 0 });
  });
});
