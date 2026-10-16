import { useCallback, useMemo, useState } from "react";
import type { SparkSnapshot } from "../../api/types";
import { isWorkerSpark } from "../../api/sparkRole";
import { TOOLS_SPARK_KEY } from "./toolsCatalog";

function readStored(): string | null {
  try {
    return localStorage.getItem(TOOLS_SPARK_KEY);
  } catch {
    return null;
  }
}

/** Which unit the tool pages act on: remembered per browser, else the first online non-worker. */
export function useToolsSpark(sparks: readonly SparkSnapshot[]) {
  const [stored, setStored] = useState<string | null>(readStored);
  const eligible = useMemo(
    () => [...sparks].sort((a, b) => Number(isWorkerSpark(a)) - Number(isWorkerSpark(b))),
    [sparks]
  );
  const spark = useMemo(() => {
    const pool = eligible.filter((s) => !isWorkerSpark(s));
    return (
      eligible.find((s) => s.id === stored) ??
      pool.find((s) => s.online) ??
      pool[0] ??
      eligible[0] ??
      null
    );
  }, [eligible, stored]);

  const select = useCallback((id: string) => {
    setStored(id);
    try {
      localStorage.setItem(TOOLS_SPARK_KEY, id);
    } catch {
      /* private mode */
    }
  }, []);

  return { spark, select, eligible };
}
