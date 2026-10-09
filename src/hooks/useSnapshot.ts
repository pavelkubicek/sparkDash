import { useEffect, useRef, useState, useCallback } from "react";
import type { SparkSnapshot, WsSnapshot } from "../api/types";
import type { ModelsSnapshot } from "../api/modelTypes";
import { ingestSnapshots } from "./metricsStore";
import { getVisibleSparkIds, subscribeSparkVisibility } from "./sparkVisibility";
import { initialActiveId } from "../constants";
import { fetchAuthStatus, getToken, onTokenChange, reportAuthRequired } from "../api/authToken";

const RECONNECT_DELAY = 2000;

/** Built per connect so a token saved from the dialog is used on the next socket. */
function wsUrl(): string {
  const token = getToken();
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`;
}

/**
 * useSnapshot — connects to the WebSocket and exposes live spark data.
 * Returns { sparks, models, activeId, setActiveId, activeSpark, connected }.
 */
export function useSnapshot() {
  const [sparks, setSparks] = useState<SparkSnapshot[]>([]);
  const [models, setModels] = useState<ModelsSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [lastValidSnapshotAt, setLastValidSnapshotAt] = useState<number | null>(null);
  const [snapshotGeneratedAt, setSnapshotGeneratedAt] = useState<number | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [refreshInterval, setRefreshInterval] = useState<number | null>(null);
  const [activeId, setActiveId] = useState<string | null>(initialActiveId);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** When false, onclose must not schedule reconnect (unmount / intentional close). */
  const shouldReconnect = useRef(true);
  /** Serialized last models block — guards against re-render churn. */
  const modelsRef = useRef<string>("");

  /** Serialized last reported visibility ids — skips redundant WS sends. */
  const lastVisibleKey = useRef<string | null>(null);

  /**
   * Report which sparks' graphs are actually in view; the server pauses
   * polling for everything else (see hooks/sparkVisibility). Sent on every
   * change and again after each (re)connect.
   */
  const sendVisibility = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const ids = getVisibleSparkIds();
    const key = [...ids].sort().join("\0");
    if (key === lastVisibleKey.current) return;
    lastVisibleKey.current = key;
    try {
      ws.send(JSON.stringify({ type: "visibility", sparks: ids }));
    } catch {
      /* socket died mid-send — reconnect re-sends via onopen */
    }
  }, []);

  /** Token value whose rejection we already checked, so a refused socket asks once, not every retry. */
  const authCheckedFor = useRef<string | null>(null);

  // A browser cannot see why an upgrade was refused — it just gets a close.
  // When a socket dies before its first snapshot, ask the server whether the
  // token is the reason, and if so let the app prompt for one.
  const checkAuthAfterRefusal = useCallback(() => {
    const token = getToken();
    if (authCheckedFor.current === token) return;
    authCheckedFor.current = token;
    fetchAuthStatus(token)
      .then((status) => {
        if (!shouldReconnect.current || getToken() !== token) return;
        if (status.tokenRequired && !status.authenticated) reportAuthRequired();
      })
      .catch(() => {
        // Server unreachable (or restarting): check again on the next refusal.
        authCheckedFor.current = null;
      });
  }, []);

  // ─── Connect ─────────────────────────────────────────────
  const connect = useCallback(() => {
    if (!shouldReconnect.current) return;

    const state = wsRef.current?.readyState;
    // Avoid duplicate sockets while OPEN or still CONNECTING
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;

    const ws = new WebSocket(wsUrl());
    wsRef.current = ws;
    let receivedSnapshot = false;

    ws.onopen = () => {
      // A socket alone is not healthy; wait for one valid snapshot.
      setConnected(false);
      console.log("[ws] connected");
      // New socket resets server-side state to "watching everything";
      // force a fresh report of the real visible set.
      lastVisibleKey.current = null;
      sendVisibility();
    };

    ws.onmessage = (ev) => {
      try {
        const msg: WsSnapshot = JSON.parse(ev.data);
        if (msg.type === "snapshot" && Array.isArray(msg.sparks)) {
          const receivedAt = Date.now();
          // Feed the central history store (8b) before notifying React state.
          ingestSnapshots(msg.sparks, msg.generatedAt ?? receivedAt);
          setSparks(msg.sparks);
          // Keep a stable reference while the launcher block is unchanged: the
          // spark half of the payload changes every tick and would otherwise
          // re-render the model cards (and their countdown) on every snapshot.
          const nextModels = msg.models ?? null;
          const serialized = nextModels ? JSON.stringify(nextModels) : "";
          if (serialized !== modelsRef.current) {
            modelsRef.current = serialized;
            setModels(nextModels);
          }
          setConnected(true);
          receivedSnapshot = true;
          authCheckedFor.current = null;
          setLastValidSnapshotAt(receivedAt);
          setSnapshotGeneratedAt(
            Number.isFinite(msg.generatedAt) ? Number(msg.generatedAt) : null
          );
          setRefreshInterval(
            Number.isFinite(msg.refreshInterval) ? Number(msg.refreshInterval) : null
          );
          setSnapshotError(null);
        } else {
          setSnapshotError("The server sent an invalid telemetry payload.");
        }
      } catch {
        setSnapshotError("The server sent malformed telemetry data.");
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      if (!shouldReconnect.current) return;
      if (!receivedSnapshot) checkAuthAfterRefusal();
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [checkAuthAfterRefusal]);

  /** Drop the current socket without scheduling the usual delayed reconnect. */
  const disposeSocket = useCallback(() => {
    clearTimeout(reconnectTimer.current);
    const ws = wsRef.current;
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
    }
    wsRef.current = null;
  }, []);

  // ─── Lifecycle ───────────────────────────────────────────
  useEffect(() => {
    shouldReconnect.current = true;
    connect();
    return () => {
      shouldReconnect.current = false;
      disposeSocket();
    };
  }, [connect, disposeSocket]);

  // A new (or cleared) token takes effect immediately: reconnect with it.
  useEffect(
    () =>
      onTokenChange(() => {
        disposeSocket();
        connect();
      }),
    [connect, disposeSocket]
  );

  // Keep the server's poll set in sync with what is on screen. The reporter
  // no-ops while the socket is down; onopen re-sends after (re)connect.
  useEffect(() => subscribeSparkVisibility(sendVisibility), [sendVisibility]);

  // ─── Derived state ──────────────────────────────────────
  const activeSpark = sparks.find((s) => s.id === activeId) || null;

  return {
    sparks,
    models,
    connected,
    activeId,
    setActiveId,
    activeSpark,
    lastValidSnapshotAt,
    snapshotGeneratedAt,
    snapshotError,
    refreshInterval,
  };
}
