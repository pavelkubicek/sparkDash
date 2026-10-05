import { useEffect, useState } from "react";
import {
  fetchAuditorReviews,
  fetchAuditorSlotsConfig,
  fetchAuditorStats,
  fetchAuditorStatus,
  fetchAuditorWebuiUrl,
} from "../../api/client";
import type {
  AuditorReview,
  AuditorReviewStatus,
  AuditorSlotsConfig,
  AuditorStats,
  AuditorStatus,
} from "../../api/types";
import { Panel } from "../ui/Panel";
import { ExternalLinkIcon, GearIcon } from "../ui/icons";
import { AuditorSlotsDialog } from "./AuditorSlotsDialog";

const POLL_MS = 5000;

/** How many rows each list section fetches (page through the bridge). */
const LIST_LIMIT = 8;

/**
 * Badge tones copied verbatim from the Auditor web UI
 * (auditor-ui/src/components/StatusBadge.tsx AUDITOR_TONES) so the dashboard
 * reads exactly like auditor.lan for the same state.
 */
const STATUS_BADGE: Record<AuditorReviewStatus, string> = {
  queued: "bg-[#374151] text-[#e5e7eb]", // gray-700 / gray-200
  analyzing: "bg-[#f59e0b] text-[#111827] animate-pulse", // amber-500 / gray-900
  findings_ready: "bg-[#0891b2] text-white", // cyan-600
  duplicate: "bg-[#0d9488] text-white", // teal-600
  failed: "bg-[#dc2626] text-white", // red-600
  cancelled: "bg-[#4b5563] text-[#9ca3af]", // gray-600 / gray-400
};

const STATUS_LABEL: Record<AuditorReviewStatus, string> = {
  queued: "Queued",
  analyzing: "Analyzing",
  findings_ready: "Ready",
  duplicate: "Duplicate",
  failed: "Failed",
  cancelled: "Cancelled",
};

/** Tier chip — same treatment as the auditor ReportCard. */
function TierChip({ tier, reason }: { tier: string | null; reason: string | null }) {
  if (!tier) return null;
  return (
    <span
      className="rounded bg-[#1f2937] px-1.5 py-0.5 text-[10px] text-[#d1d5db]"
      title={reason ?? "Tier"}
    >
      tier {tier.toUpperCase()}
    </span>
  );
}

/** Partial chip — auditor PartialChip, only the "partial" state (whole is not shown in lists). */
function PartialChip() {
  return (
    <span
      title="The branch was still moving: only its newest delta was reviewed."
      className="inline-flex items-center rounded bg-[rgba(251,191,36,0.15)] px-1.5 py-0.5 text-[10px] font-medium text-[#fde68a] ring-1 ring-[rgba(251,191,36,0.3)]"
    >
      partial
    </span>
  );
}

function ageLabel(iso: string | null): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** One "analyzing now" row: pulsing amber dot + title + branch/tier/age. */
function AnalyzingRow({ review, onOpen }: { review: AuditorReview; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 text-left transition-colors hover:text-accent"
      title={`Open report ${review.title ?? review.id} in the auditor`}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[#f59e0b]"
        style={{ boxShadow: "0 0 6px #f59e0b" }}
        title={STATUS_LABEL.analyzing}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-text">
          {review.title ?? review.scope_key}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted">
          <span className="truncate">{review.branch}</span>
          <TierChip tier={review.tier} reason={review.tier_reason} />
          {review.partial && <PartialChip />}
          <span className="font-tabular">{ageLabel(review.started_at)}</span>
        </span>
      </span>
    </button>
  );
}

/** One finished ("Ready") row: cyan status dot (orchestrator-row style) + findings count, severity + seen state.
 *  Clean reports (0 findings) are not listed — only rows with actual findings. */
function FinishedRow({ review, onOpen }: { review: AuditorReview; onOpen: () => void }) {
  const sev = review.findings_by_severity ?? {};
  const critical = sev.critical ?? 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 text-left transition-colors hover:text-accent"
      title={`Open report ${review.title ?? review.id} in the auditor`}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: "#0891b2", boxShadow: "0 0 6px #0891b2" }}
        title={STATUS_LABEL.findings_ready}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs text-text">
          {review.title ?? review.scope_key}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted">
          <span className="truncate">{review.branch}</span>
          <TierChip tier={review.tier} reason={review.tier_reason} />
          <span className="font-tabular">
            {review.finding_count} finding{review.finding_count === 1 ? "" : "s"}
          </span>
          {critical > 0 && <span className="text-[#f87171]">{critical} critical</span>}
          {!review.seen_at && <span className="text-[#fbbf24]">not seen</span>}
          <span className="font-tabular">{ageLabel(review.finished_at ?? review.started_at)}</span>
        </span>
      </span>
    </button>
  );
}

/**
 * Compact "Auditor" panel next to the Orchestrator panel. Shows analysis slot
 * usage, the reviews analyzing right now, and the most recent finished
 * (findings-ready) reports. Same feature set and chrome as OrchestratorPanel:
 * slots settings dialog, "open auditor" jump link, 5 s bridge polling, and a
 * graceful offline state. Colors match the auditor web UI exactly.
 */
export function AuditorPanel() {
  const [status, setStatus] = useState<AuditorStatus | null>(null);
  const [stats, setStats] = useState<AuditorStats | null>(null);
  const [analyzing, setAnalyzing] = useState<AuditorReview[]>([]);
  const [analyzingCount, setAnalyzingCount] = useState(0);
  const [finished, setFinished] = useState<AuditorReview[]>([]);
  const [readyCount, setReadyCount] = useState(0);
  const [slots, setSlots] = useState<AuditorSlotsConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [webuiUrl, setWebuiUrl] = useState<string | null>(null);
  const [slotsOpen, setSlotsOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      // Each endpoint degrades independently: a single upstream failure must
      // not clear the other sections' data, but total failure = daemon down.
      const [s, st, an, fin, sc] = await Promise.all([
        fetchAuditorStatus().catch(() => null),
        fetchAuditorStats().catch(() => null),
        fetchAuditorReviews({ status: "analyzing", limit: LIST_LIMIT })
          .then((r) => r)
          .catch(() => null),
        // The auditor's own UI pulls a WINDOW_LIMIT=1000 feed and renders
        // count == len(items) — the daemon's `count` is the filtered page
        // length, NOT the query total. Fetch the same window so the header
        // count matches auditor.lan; the list shows only the first page.
        fetchAuditorReviews({ status: "findings_ready", has_findings: true, limit: 1000 })
          .then((r) => r)
          .catch(() => null),
        fetchAuditorSlotsConfig().catch(() => null),
      ]);
      if (cancelled) return;
      let saw = false;
      if (s) {
        saw = true;
        setStatus(s);
      }
      if (st) {
        saw = true;
        setStats(st);
      }
      if (an) {
        saw = true;
        setAnalyzing(an.reviews);
        setAnalyzingCount(an.count);
      }
      if (fin) {
        saw = true;
        setFinished(fin.reviews.slice(0, LIST_LIMIT));
        setReadyCount(fin.count);
      }
      if (sc) {
        saw = true;
        setSlots(sc);
      }
      setError(saw ? null : "Auditor unreachable — no data");
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    }

    void fetchAuditorWebuiUrl()
      .then((r) => {
        if (!cancelled) setWebuiUrl(r.url);
      })
      .catch(() => {});

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const online = !error;
  const slotsUsed = status?.slots_used ?? slots?.effective_concurrency ?? 0;
  const slotsTotal = status?.slots_total ?? slots?.effective_concurrency ?? 0;
  const slotPct = slotsTotal > 0 ? Math.round((slotsUsed / slotsTotal) * 100) : 0;
  const openReviews = (report: AuditorReview) => {
    if (webuiUrl) window.open(`${webuiUrl}/reports/${encodeURIComponent(report.id)}`, "_blank", "noreferrer");
  };

  return (
    <Panel
      title="Auditor"
      icon={
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            online ? "bg-success dot-glow-success" : "bg-danger dot-glow-danger"
          }`}
          title={online ? "Auditor online" : "Auditor unreachable"}
        />
      }
      accent
      className="flex flex-col"
      bodyClassName="flex flex-1 flex-col space-y-3"
      actions={
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setSlotsOpen(true)}
            title="Edit slot settings (day/night concurrency)"
            className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:border-accent hover:text-accent"
          >
            <GearIcon className="h-3 w-3" />
            Slots
          </button>
          <a
            href={webuiUrl ?? undefined}
            target="_blank"
            rel="noreferrer"
            title="Open the auditor web UI"
            className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:border-accent hover:text-accent"
          >
            <ExternalLinkIcon className="h-3 w-3" />
            Open auditor
          </a>
        </div>
      }
    >
      {error ? (
        <div className="space-y-1">
          <p className="text-xs text-warning">Auditor unreachable</p>
          <p className="break-all text-[11px] text-muted">{error}</p>
        </div>
      ) : (
        <>
          {/* Analyzing now — the auditor's live slot consumers */}
          <div className="min-h-[4.5rem] space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted">
              Analyzing now ({analyzingCount || (status?.analyzing ?? 0)})
            </p>
            {analyzing.length > 0 ? (
              analyzing.map((review) => (
                <AnalyzingRow key={review.id} review={review} onOpen={() => openReviews(review)} />
              ))
            ) : (
              <p className="text-xs text-muted">Nothing is analyzing right now.</p>
            )}
          </div>

          {/* Finished — most recent findings-ready reports with actual findings.
              This section is the panel's flex-grow region: when the grid row is
              taller than the natural content (e.g. the Model Launcher beside it
              is capped at 600px), the list absorbs the spare height and scrolls
              instead of leaving a dead gap above the footer. */}
          <div className="flex min-h-[7rem] flex-1 flex-col space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted">
              Finished — Ready ({readyCount})
            </p>
            {finished.length > 0 ? (
              <div className="nice-scroll -mx-1 flex-1 space-y-1 overflow-y-auto px-1">
                {finished.map((review) => (
                  <FinishedRow key={review.id} review={review} onOpen={() => openReviews(review)} />
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted">No ready reports with findings.</p>
            )}
          </div>

          {/* Pipeline counters strip */}
          <div className="space-y-1">
            <p className="text-xs uppercase tracking-wide text-muted">Pipeline</p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted">
              {(["queued", "analyzing", "findings_ready", "duplicate", "failed", "cancelled"] as const).map(
                (key) => {
                  const n = stats?.by_status?.[key] ?? (key === "analyzing" ? status?.analyzing : undefined);
                  if (n == null) return null;
                  return (
                    <span key={key} className="inline-flex items-center gap-1">
                      <span
                        className={`inline-block h-1.5 w-1.5 rounded-full ${
                          key === "analyzing" ? "animate-pulse" : ""
                        } ${STATUS_BADGE[key].split(" ")[0]}`}
                      />
                      <span className="font-tabular text-text">{n}</span>
                      {STATUS_LABEL[key].toLowerCase()}
                    </span>
                  );
                }
              )}
            </div>
          </div>
        </>
      )}

      {/* Slot usage footer */}
      <div className="mt-auto flex items-center gap-3 border-t border-border pt-3">
        <div className="min-w-0 flex-1">
          <div className="h-1.5 overflow-hidden rounded-full bg-border">
            <div className="h-full rounded-full bg-bar" style={{ width: `${slotPct}%` }} />
          </div>
        </div>
        <span className="shrink-0 whitespace-nowrap text-center" title="Slots in use">
          <span className="font-tabular text-[18px] font-bold leading-none text-text-strong">
            {online ? `${slotsUsed} / ${slotsTotal}` : "— / —"}
          </span>
          <span className="text-sm font-normal text-muted"> slots</span>
        </span>
      </div>
      <AuditorSlotsDialog
        open={slotsOpen}
        onClose={() => setSlotsOpen(false)}
        onSaved={(next) => {
          setSlots(next);
          // Re-poll so status totals reflect the new concurrency promptly.
          void fetchAuditorStatus()
            .then((s) => setStatus(s))
            .catch(() => {});
        }}
      />
    </Panel>
  );
}
