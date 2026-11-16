import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchSparkUpdates, fetchSparkUpdatesJob } from "../../api/client";
import type { SparkUpdateDetail, UpdateInstallJob } from "../../api/types";

/** Install-job follow cadence, same as the fleet job's (short runs end within a second). */
const JOB_POLL_MS = 1000;
const JOB_FIRST_POLL_MS = 400;

export interface SparkUpdates {
  /** Everything the server knows about the unit; null before the first read answers. */
  detail: SparkUpdateDetail | null;
  /** The first read of the unit's state is still on its way. */
  loading: boolean;
  /** Could not read the state (not a failed check: that is `detail.lastError`). */
  loadError: string | null;
  /** The unit's install job while one runs (null otherwise). */
  job: UpdateInstallJob | null;
  /** Read the state again (after an action). */
  refresh: () => Promise<void>;
  /** Take a detail the server just answered with (check / refresh return the new state directly). */
  applyDetail: (detail: SparkUpdateDetail) => void;
  /** Start following the unit's install job (after a POST install answered with a jobId). */
  followJob: () => void;
}

/**
 * The update state of the selected unit: reads it on select, drops answers of a unit that has been
 * replaced in the meantime (the generation counter, as the storage scan does), and follows the unit's
 * server-owned install job — which keeps running when this page closes.
 */
export function useSparkUpdates(sparkId: string | null): SparkUpdates {
  const [detail, setDetail] = useState<SparkUpdateDetail | null>(null);
  const [loading, setLoading] = useState(Boolean(sparkId));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [job, setJob] = useState<UpdateInstallJob | null>(null);
  /** A newer unit or request wins: answers for an older one are dropped. */
  const generation = useRef(0);
  const following = useRef(false);
  const timer = useRef<number | null>(null);

  const stopJob = useCallback(() => {
    following.current = false;
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const pull = useCallback(async () => {
    if (!sparkId) return;
    const mine = generation.current;
    try {
      const res = await fetchSparkUpdates(sparkId);
      if (mine !== generation.current) return;
      setDetail(res);
      setLoadError(null);
    } catch (err) {
      if (mine !== generation.current) return;
      setLoadError(err instanceof Error ? err.message : "Could not read the update state");
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [sparkId]);

  const followJob = useCallback(() => {
    if (!sparkId) return;
    stopJob();
    following.current = true;
    const mine = generation.current;
    const tick = async () => {
      timer.current = null;
      if (!following.current || mine !== generation.current) return;
      try {
        const res = await fetchSparkUpdatesJob(sparkId);
        if (!following.current || mine !== generation.current) return;
        setJob(res.job);
        if (res.job && res.job.state !== "running") {
          following.current = false;
          // The install changed what is upgradable; read the unit again.
          void pull();
          return;
        }
      } catch (err) {
        if (!following.current || mine !== generation.current) return;
        if (err instanceof ApiError && err.status === 404) {
          following.current = false;
          setJob(null);
          return;
        }
        // A dropped read only pauses the follow; the job goes on on the server.
      }
      timer.current = window.setTimeout(() => void tick(), JOB_POLL_MS);
    };
    timer.current = window.setTimeout(() => void tick(), JOB_FIRST_POLL_MS);
  }, [sparkId, stopJob, pull]);

  useEffect(() => {
    generation.current += 1;
    const mine = generation.current;
    stopJob();
    setDetail(null);
    setJob(null);
    setLoadError(null);
    setLoading(Boolean(sparkId));
    void pull();
    void (async () => {
      // A job started from another tab (or before a close): pick it up and follow it.
      if (!sparkId) return;
      try {
        const res = await fetchSparkUpdatesJob(sparkId);
        // A unit replaced while this read was in flight wins: its job is never rendered here.
        if (mine !== generation.current) return;
        if (res.job?.state === "running" && !following.current) {
          setJob(res.job);
          followJob();
        }
      } catch {
        // Nothing to follow.
      }
    })();
    return () => {
      generation.current += 1;
      stopJob();
    };
  }, [sparkId, pull, followJob, stopJob]);

  const applyDetail = useCallback((next: SparkUpdateDetail) => {
    setDetail(next);
    setLoadError(null);
    setLoading(false);
  }, []);

  return { detail, loading, loadError, job, refresh: pull, applyDetail, followJob };
}
