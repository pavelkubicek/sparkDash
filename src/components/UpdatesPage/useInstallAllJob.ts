import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchInstallAllJob, installAllUpdates, refreshAllUpdates } from "../../api/client";
import type { InstallAllJob } from "../../api/types";

/** How often a running fleet job is read again (the first time sooner: short runs end within a second). */
const FLEET_POLL_MS = 1000;
const FLEET_FIRST_POLL_MS = 400;

export interface InstallAll {
  /** The run this page follows: started here, or found still running when the page opened. */
  job: InstallAllJob | null;
  /** Start a run and follow it; no `sudoPassword` means every unit runs on the password the dashboard remembers. Rejects when the dashboard refuses it. */
  start: (sudoPassword?: string, remember?: boolean) => Promise<void>;
  /** Start a refresh-only run (apt index, never installs) and follow it; `remember` stores a typed password for the daily refresh. */
  startRefresh: (sudoPassword?: string, remember?: boolean) => Promise<void>;
}

/**
 * The fleet install-all job: the server runs the units one after another and the page only follows it,
 * so a reload or a closed tab does not stop it. Opening the page finds a run that is still going and
 * follows that too.
 */
export function useInstallAllJob(): InstallAll {
  const [job, setJob] = useState<InstallAllJob | null>(null);
  const following = useRef(false);
  const timer = useRef<number | null>(null);
  const mounted = useRef(true);

  const stop = useCallback(() => {
    following.current = false;
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const follow = useCallback(() => {
    stop();
    following.current = true;
    const tick = async () => {
      timer.current = null;
      if (!following.current) return;
      try {
        const res = await fetchInstallAllJob();
        if (!following.current) return;
        setJob(res.job);
        if (res.job == null || res.job.state !== "running") {
          // Done (its summary stays on screen) or gone (a restart): nothing left to follow.
          following.current = false;
          return;
        }
      } catch (err) {
        if (!following.current) return;
        // Not known any more (the dashboard restarted): nothing left to follow.
        if (err instanceof ApiError && err.status === 404) {
          following.current = false;
          setJob(null);
          return;
        }
        // Anything else (a dropped connection): keep trying; the run goes on on the server.
      }
      timer.current = window.setTimeout(() => void tick(), FLEET_POLL_MS);
    };
    timer.current = window.setTimeout(() => void tick(), FLEET_FIRST_POLL_MS);
  }, [stop]);

  useEffect(() => {
    mounted.current = true;
    let live = true;
    void (async () => {
      try {
        // A run started from another tab (or before a close) is still the server's; pick it up.
        const res = await fetchInstallAllJob();
        if (live && res.job?.state === "running" && !following.current) {
          setJob(res.job);
          follow();
        }
      } catch {
        // Nothing to follow is not an error the page needs to show.
      }
    })();
    return () => {
      live = false;
      mounted.current = false;
      stop();
    };
  }, [follow, stop]);

  const start = useCallback(
    async (sudoPassword?: string, remember?: boolean) => {
      // Throws when the dashboard refuses the run (already-running, a bad password); the dialog shows it.
      const res = await installAllUpdates({ sudoPassword, remember });
      if (!mounted.current) return;
      setJob({ id: res.jobId, mode: "install", state: "running", startedAt: Date.now(), finishedAt: null, units: [] });
      follow();
    },
    [follow]
  );

  const startRefresh = useCallback(
    async (sudoPassword?: string, remember?: boolean) => {
      // Same shared fleet job, refresh mode; the same refusals (already-running, a bad password).
      const res = await refreshAllUpdates({ sudoPassword, remember });
      if (!mounted.current) return;
      setJob({ id: res.jobId, mode: "refresh", state: "running", startedAt: Date.now(), finishedAt: null, units: [] });
      follow();
    },
    [follow]
  );

  return { job, start, startRefresh };
}
