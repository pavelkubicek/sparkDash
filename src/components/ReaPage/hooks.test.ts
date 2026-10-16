import { describe, expect, it, vi } from "vitest";
import { ReaApiError } from "../../api/types";
import { isRetryableUploadError, withUploadRetry } from "./hooks";

describe("withUploadRetry", () => {
  it("retries a 429 and a network failure with backoff, then succeeds", async () => {
    const ctl = new AbortController();
    const fn = vi
      .fn<(n: number) => Promise<string>>()
      .mockRejectedValueOnce(new ReaApiError("slow down", 429))
      .mockRejectedValueOnce(new ReaApiError("no network", 0))
      .mockResolvedValue("ok");
    await expect(withUploadRetry(fn, ctl.signal, [1, 1, 1])).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("gives up after the retries and rethrows the last error", async () => {
    const fn = vi.fn<(n: number) => Promise<string>>().mockRejectedValue(new ReaApiError("slow down", 429));
    await expect(withUploadRetry(fn, new AbortController().signal, [1, 1, 1])).rejects.toThrow("slow down");
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("does not retry other errors or a cancelled upload", async () => {
    const bad = vi.fn<(n: number) => Promise<string>>().mockRejectedValue(new ReaApiError("too big", 413));
    await expect(withUploadRetry(bad, new AbortController().signal, [1, 1, 1])).rejects.toThrow("too big");
    expect(bad).toHaveBeenCalledTimes(1);
    const ctl = new AbortController();
    ctl.abort();
    expect(isRetryableUploadError(new ReaApiError("Upload cancelled", 0), ctl.signal)).toBe(false);
    expect(isRetryableUploadError(new ReaApiError("x", 500))).toBe(false);
  });
});
