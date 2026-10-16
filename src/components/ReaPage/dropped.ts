import type { UploadCandidate } from "./reaLogic";

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?: (ok: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (e: FsEntry[]) => void, err: (e: unknown) => void) => void };
}

/** Stop walking after this many files: the caller refuses anything over its limit anyway. */
export const WALK_CAP = 20_000;

const fileOf = (e: FsEntry) => new Promise<File>((ok, err) => e.file!(ok, err));
const batchOf = (r: { readEntries: (ok: (e: FsEntry[]) => void, err: (e: unknown) => void) => void }) =>
  new Promise<FsEntry[]>((ok, err) => r.readEntries(ok, err));

async function walk(entry: FsEntry, out: UploadCandidate[], cap: number): Promise<void> {
  if (out.length >= cap) return;
  if (entry.isFile && entry.file) {
    const f = await fileOf(entry);
    out.push({ path: entry.fullPath.replace(/^\/+/, "") || f.name, file: f });
    return;
  }
  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    // readEntries returns at most ~100 entries per call: read until it returns none.
    for (;;) {
      const batch = await batchOf(reader);
      if (!batch.length) break;
      for (const child of batch) {
        await walk(child, out, cap);
        if (out.length >= cap) return;
      }
    }
  }
}

/**
 * Files (and walked folders) of a drop event. Uses `webkitGetAsEntry` when the browser has it, so a dropped
 * folder is expanded with its relative paths; otherwise the plain file list is used.
 */
export async function collectDropped(dt: DataTransfer, cap = WALK_CAP): Promise<UploadCandidate[]> {
  const out: UploadCandidate[] = [];
  const items = Array.from(dt.items ?? []);
  // Entries must be taken synchronously, before the first await.
  const entries: FsEntry[] = [];
  for (const it of items) {
    if (it.kind !== "file") continue;
    const e = (it as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.();
    if (e) entries.push(e);
  }
  if (entries.length) {
    for (const e of entries) {
      await walk(e, out, cap);
      if (out.length >= cap) break;
    }
    return out;
  }
  for (const f of Array.from(dt.files ?? [])) out.push({ path: f.name, file: f });
  return out;
}

/** Files of an `<input type=file>`; a folder pick carries `webkitRelativePath`. */
export function candidatesFromInput(list: FileList | null): UploadCandidate[] {
  return Array.from(list ?? []).map((f) => ({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, file: f }));
}
