import { useEffect, useRef, useState } from "react";
import {
  fetchAuditorReviews,
  fetchAuditorSlotsConfig,
  fetchAuditorStats,
  fetchAuditorStatus,
  fetchAuditorWebuiUrl,
  fetchOrchestratorPlans,
  fetchOrchestratorRunningTasks,
  fetchOrchestratorSlotsConfig,
  fetchOrchestratorStatus,
  fetchOrchestratorTickets,
  fetchOrchestratorWebuiUrl,
} from "../../api/client";
import type { OrchestratorLive } from "../../shared/idleCounts";
import type {
  AuditorReview,
  AuditorReviewStatus,
  AuditorSlotsConfig,
  AuditorStats,
  AuditorStatus,
  OrchestratorPlan,
  OrchestratorRunningTask,
  OrchestratorSlotsConfig,
  OrchestratorStatus,
  OrchestratorTicket,
} from "../../api/types";
import { Panel } from "../ui/Panel";
import { BotIcon, ExternalLinkIcon, GearIcon, MicroscopeIcon } from "../ui/icons";
import { SlotSettingsDialog } from "./SlotSettingsDialog";

const POLL_MS = 5000;

/** How many rows each auditor list section fetches (page through the bridge). */
const LIST_LIMIT = 8;

/** Max pending-PR rows on the card; the rest collapses into a "…" row. */
const PENDING_PR_LIMIT = 12;

/** Ticket statuses that count as "active" for the panel. */
const ACTIVE_STATUSES: Record<string, true> = {
  in_progress: true,
  review: true,
  queued: true,
  failed: true,
};

/** Plan statuses that count as "active". The orchestrator already excludes completed
 *  plans from /api/plans; this keeps the section honest if a terminal status
 *  ever shows up. */
const ACTIVE_PLAN_STATUSES: Record<string, true> = {
  queued: true,
  processing: true,
  creating_ticket: true,
  failed: true,
};

/** Task status colors matching the orchestrator web UI (web-ui ActiveTaskItem/StatusBadge). */
const TASK_STATUS_COLOR: Record<string, string> = {
  pending: "#6b7280", // gray-500
  queued: "#6b7280",
  running: "#f59e0b", // amber-500
  fixing: "#8b5cf6", // violet-500
  in_progress: "#f59e0b",
  validating: "#d97706", // amber-600
  validation_fixing: "#ea580c", // orange-600
  reviewing: "#9333ea", // purple-600
  review: "#9333ea",
  done: "#16a34a", // green-600
  completed: "#16a34a",
  skipped: "#0d9488", // teal-600
  failed: "#dc2626", // red-600
  processing: "#0891b2", // cyan-600
  creating_ticket: "#4f46e5", // indigo-600
  cancelled: "#6b7280",
};

/** Human labels matching the orchestrator web UI (StatusBadge LABEL map). */
const TASK_STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  queued: "Queued",
  running: "Running",
  fixing: "Fixing",
  in_progress: "In Progress",
  validating: "Validating",
  validation_fixing: "Val. Fixing",
  reviewing: "Reviewing",
  review: "Review",
  done: "Completed",
  completed: "Completed",
  skipped: "Skipped",
  failed: "Failed",
  processing: "Processing",
  creating_ticket: "Creating Ticket",
  cancelled: "Cancelled",
};

/** Ticket status colors matching the orchestrator web UI (StatusBadge / Sidebar chips). */
const TICKET_STATUS_COLOR: Record<string, string> = {
  queued: "#6b7280", // gray-500
  in_progress: "#f59e0b", // amber-500
  review: "#9333ea", // purple-600
  completed: "#16a34a", // green-600
  failed: "#dc2626", // red-600
};

/** Ticket status labels matching the orchestrator web UI. */
const TICKET_STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  in_progress: "In Progress",
  review: "Review",
  completed: "Completed",
  failed: "Failed",
};

/** Plan status colors matching the orchestrator web UI (plan status badges). */
const PLAN_STATUS_COLOR: Record<string, string> = {
  queued: "#6b7280", // gray-500
  processing: "#0891b2", // cyan-600
  creating_ticket: "#4f46e5", // indigo-600
  completed: "#059669", // emerald-600
  failed: "#dc2626", // red-600
};

/** Plan status labels matching the orchestrator web UI. */
const PLAN_STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  processing: "Processing",
  creating_ticket: "Creating Ticket",
  completed: "Completed",
  failed: "Failed",
};

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

/** Resolve the display tone for a ticket's PR badge. */
function prBadge(prUrl: string | null, prState: string): { text: string; cls: string } | null {
  if (!prUrl) return null;
  const state = prState || "unknown";
  if (state === "open") {
    return { text: "PR open", cls: "bg-success/15 text-success border-success/40" };
  }
  if (state === "merged") {
    return { text: "PR merged", cls: "bg-accent/15 text-accent border-accent/40" };
  }
  if (state === "closed") {
    return { text: "PR closed", cls: "bg-border/60 text-muted border-border" };
  }
  return { text: "PR", cls: "bg-accent/15 text-accent border-accent/40" };
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

function TicketRow({ ticket, onOpen }: { ticket: OrchestratorTicket; onOpen: () => void }) {
  const badge = prBadge(ticket.pr_url, ticket.pr_state);
  const total = ticket.tasks_total;
  const done = ticket.tasks_done;
  const running = ticket.tasks_running;
  const fixing = ticket.tasks_fixing;
  const validating = ticket.tasks_validating;
  const valFixing = ticket.tasks_validation_fixing;
  const reviewing = ticket.tasks_reviewing;
  const failed = ticket.tasks_failed;
  const skipped = ticket.tasks_skipped ?? 0;
  const inFlight = running + fixing + validating + valFixing + reviewing;
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  const ticketColor = TICKET_STATUS_COLOR[ticket.status] ?? "var(--color-text)";
  const ticketLabel = TICKET_STATUS_LABEL[ticket.status] ?? ticket.status;

  return (
    <div className="flex items-center gap-2">
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{
          backgroundColor: ticketColor,
          boxShadow: `0 0 6px ${ticketColor}`,
        }}
        title={`${ticketLabel}${inFlight > 0 ? ` · ${inFlight} task(s) in flight` : ""}`}
      />
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 text-left transition-colors hover:text-accent"
        title={`Open ${ticket.name} in the orchestrator`}
      >
        <span className="flex min-w-0 items-baseline gap-1">
          <span className="block truncate text-xs text-text">{ticket.name}</span>
          <span className="shrink-0 font-tabular text-[10px] text-muted">
            #{ticket.ticket_id}
          </span>
        </span>
        {/* Multi-label status row — mirrors the orchestrator's ticket card header */}
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted">
          <span className="font-tabular">{done}/{total} tasks</span>
          {running > 0 && <span className="text-[#fbbf24]">{running} running</span>}
          {fixing > 0 && <span className="text-[#a78bfa]">{fixing} fixing</span>}
          {reviewing > 0 && <span className="text-[#c084fc]">{reviewing} reviewing</span>}
          {validating > 0 && <span className="text-[#fbbf24]">{validating} validating</span>}
          {valFixing > 0 && <span className="text-[#ea580c]">{valFixing} val-fixing</span>}
          {failed > 0 && <span className="text-[#dc2626]">{failed} failed</span>}
          {skipped > 0 && <span className="text-[#14b8a6]">{skipped} skipped</span>}
          <span className="font-tabular">{ageLabel(ticket.created_at)}</span>
        </span>
        {/* Multi-color segmented progress bar — mirrors the orchestrator web UI:
            green = done, amber (pulse) = running, amber = validating,
            violet = fixing, orange = val-fixing, purple (pulse) = reviewing,
            red = failed, teal = skipped, track = remaining. */}
        <span className="mt-1 flex h-1 w-full overflow-hidden rounded-full bg-border">
          {done > 0 && (
            <span className="h-full bg-[#22c55e]" style={{ width: `${pct(done)}%` }} />
          )}
          {running > 0 && (
            <span className="h-full animate-pulse bg-[#f59e0b]" style={{ width: `${pct(running)}%` }} />
          )}
          {fixing > 0 && (
            <span className="h-full animate-pulse bg-[#8b5cf6]" style={{ width: `${pct(fixing)}%` }} />
          )}
          {validating > 0 && (
            <span className="h-full animate-pulse bg-[#f59e0b]" style={{ width: `${pct(validating)}%` }} />
          )}
          {valFixing > 0 && (
            <span className="h-full animate-pulse bg-[#f97316]" style={{ width: `${pct(valFixing)}%` }} />
          )}
          {reviewing > 0 && (
            <span className="h-full animate-pulse bg-[#a855f7]" style={{ width: `${pct(reviewing)}%` }} />
          )}
          {failed > 0 && (
            <span className="h-full bg-[#ef4444]" style={{ width: `${pct(failed)}%` }} />
          )}
          {skipped > 0 && (
            <span className="h-full bg-[#14b8a6]" style={{ width: `${pct(skipped)}%` }} />
          )}
        </span>
      </button>
      {badge && (
        <a
          href={ticket.pr_url ?? undefined}
          target="_blank"
          rel="noreferrer"
          title={`Open PR ${ticket.pr_url}`}
          className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors hover:opacity-80 ${badge.cls}`}
        >
          {badge.text}
        </a>
      )}
    </div>
  );
}

/**
 * One active plan row. Plans have no task counters, so the row shows the plan
 * status, the ticket it refines/creates (when known), plan length and age.
 */
function PlanRow({ plan, onOpen }: { plan: OrchestratorPlan; onOpen: () => void }) {
  const color = PLAN_STATUS_COLOR[plan.status] ?? "var(--color-text)";
  const label = PLAN_STATUS_LABEL[plan.status] ?? plan.status;
  const target = plan.target_ticket_id ?? plan.base_id;
  const busy = plan.status === "processing" || plan.status === "creating_ticket";
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 text-left transition-colors hover:text-accent"
      title={`Open plan ${plan.name} in the orchestrator${plan.error_message ? ` — ${plan.error_message}` : ""}`}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${busy ? "animate-pulse" : ""}`}
        style={{ backgroundColor: color, boxShadow: `0 0 6px ${color}` }}
        title={label}
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1">
          <span className="block truncate text-xs text-text">{plan.name}</span>
          {target && (
            <span className="shrink-0 font-tabular text-[10px] text-muted">#{target}</span>
          )}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted">
          <span style={{ color }}>{label}</span>
          {plan.iteration > 0 && <span className="font-tabular">iter {plan.iteration}</span>}
          {plan.content_length > 0 && (
            <span className="font-tabular">{(plan.content_length / 1000).toFixed(1)}k chars</span>
          )}
          <span className="font-tabular">{ageLabel(plan.created_at)}</span>
        </span>
      </span>
    </button>
  );
}

function RunningTaskRow({ task, onOpen }: { task: OrchestratorRunningTask; onOpen: () => void }) {
  const color = TASK_STATUS_COLOR[task.status] ?? "var(--color-text)";
  const label = TASK_STATUS_LABEL[task.status] ?? task.status;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 text-left transition-colors hover:text-accent"
      title={`${task.name} · ${label}`}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: color, boxShadow: `0 0 6px ${color}` }}
        title={label}
      />
      <span className="min-w-0 flex-1 truncate text-xs text-text" title={task.name}>
        {task.name}
      </span>
      <span className="shrink-0 font-tabular text-[10px] text-muted">
        {label} · {task.attempt}/{task.max_attempts}
      </span>
      <span className="shrink-0 font-tabular text-[10px] text-muted">
        {ageLabel(task.started_at)}
      </span>
    </button>
  );
}

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

type Tab = "active" | "orchestrator" | "auditor";

const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "active", label: "Active" },
  { id: "orchestrator", label: "Orchestrator" },
  { id: "auditor", label: "Auditor" },
];

const CHIP_CLS =
  "inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:border-accent hover:text-accent";

/**
 * The merged "AI developer" card: the Orchestrator scheduler and the Auditor
 * reviewer in one Panel with three tabs — Active (both services' running
 * work), Orchestrator (running tasks, plans, tickets, pending PRs) and Auditor
 * (analyzing, ready reports, pipeline). The two services now SHARE one slot
 * pool, so a single footer shows the combined usage. Same chrome as before:
 * one slots settings dialog managing the shared pool, both "open web UI" jump links, one 5 s bridge
 * poll with independent per-endpoint degradation, and a graceful offline state
 * per service. Colors match the orchestrator and auditor web UIs exactly.
 */
export function AiDeveloperPanel({
  onIdleCounts,
}: {
  /** Publish this poll's live idle counts so AutoPower can display them without re-querying. */
  onIdleCounts?: (counts: OrchestratorLive) => void;
} = {}) {
  // Orchestrator state (was OrchestratorPanel).
  const [status, setStatus] = useState<OrchestratorStatus | null>(null);
  const [tickets, setTickets] = useState<OrchestratorTicket[]>([]);
  const [plans, setPlans] = useState<OrchestratorPlan[]>([]);
  const [runningTasks, setRunningTasks] = useState<OrchestratorRunningTask[]>([]);
  const [slots, setSlots] = useState<OrchestratorSlotsConfig | null>(null);
  const [orchError, setOrchError] = useState<string | null>(null);
  const [orchUrl, setOrchUrl] = useState<string | null>(null);
  const [slotsOpen, setSlotsOpen] = useState(false);
  // Auditor state (was AuditorPanel).
  const [aStatus, setAStatus] = useState<AuditorStatus | null>(null);
  const [aStats, setAStats] = useState<AuditorStats | null>(null);
  const [analyzing, setAnalyzing] = useState<AuditorReview[]>([]);
  const [analyzingCount, setAnalyzingCount] = useState(0);
  const [finished, setFinished] = useState<AuditorReview[]>([]);
  // Count of ready reports WITH findings (has_findings filter, same query as
  // the list below). Null until the first successful fetch; the pipeline strip
  // then falls back to the raw engine counter.
  const [readyCount, setReadyCount] = useState<number | null>(null);
  const [aSlots, setASlots] = useState<AuditorSlotsConfig | null>(null);
  const [audError, setAudError] = useState<string | null>(null);
  const [auditorUrl, setAuditorUrl] = useState<string | null>(null);
  // No persistence: every reload starts on the Active overview tab.
  const [tab, setTab] = useState<Tab>("active");
  // Kept in a ref: the poll loop runs in a deps-less effect.
  const idleRef = useRef(onIdleCounts);
  idleRef.current = onIdleCounts;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      // Each endpoint degrades independently: a single upstream failure must
      // not clear the other sections' data, but total failure per service =
      // that service down.
      const [s, t, p, r, sc, aS, aSt, an, fin, aSc] = await Promise.all([
        fetchOrchestratorStatus().catch(() => null),
        fetchOrchestratorTickets().catch(() => null),
        fetchOrchestratorPlans().catch(() => null),
        fetchOrchestratorRunningTasks().catch(() => null),
        fetchOrchestratorSlotsConfig().catch(() => null),
        fetchAuditorStatus().catch(() => null),
        fetchAuditorStats().catch(() => null),
        fetchAuditorReviews({ status: "analyzing", limit: LIST_LIMIT })
          .then((res) => res)
          .catch(() => null),
        // The auditor's own UI pulls a WINDOW_LIMIT=1000 feed and renders
        // count == len(items) — the daemon's `count` is the filtered page
        // length, NOT the query total. Fetch the same window so the header
        // count matches auditor.lan; the list shows only the first page.
        fetchAuditorReviews({ status: "findings_ready", has_findings: true, limit: 1000 })
          .then((res) => res)
          .catch(() => null),
        fetchAuditorSlotsConfig().catch(() => null),
      ]);
      if (cancelled) return;
      let sawOrch = false;
      if (s) {
        sawOrch = true;
        setStatus(s);
      }
      if (t) {
        sawOrch = true;
        setTickets(t);
      }
      if (p) {
        sawOrch = true;
        setPlans(p);
      }
      if (r) {
        sawOrch = true;
        setRunningTasks(r);
      }
      if (sc) {
        sawOrch = true;
        setSlots(sc);
      }
      setOrchError(sawOrch ? null : "Orchestrator unreachable — no data");
      let sawAud = false;
      if (aS) {
        sawAud = true;
        setAStatus(aS);
      }
      if (aSt) {
        sawAud = true;
        setAStats(aSt);
      }
      if (an) {
        sawAud = true;
        setAnalyzing(an.reviews);
        setAnalyzingCount(an.count);
      }
      if (fin) {
        sawAud = true;
        setFinished(fin.reviews.slice(0, LIST_LIMIT));
        setReadyCount(fin.count);
      }
      if (aSc) {
        sawAud = true;
        setASlots(aSc);
      }
      setAudError(sawAud ? null : "Auditor unreachable — no data");
      // Publish for AutoPower. plansActive uses the DECISION definition
      // (queued/processing/creating_ticket) — a failed plan is terminal, so it
      // is listed in this panel but must not read as busy to AutoPower.
      idleRef.current?.({
        ok: s != null && p != null,
        slotsUsed: s?.slots_used ?? 0,
        ticketsActive: s?.tickets_active ?? 0,
        plansActive: (p ?? []).filter((pl) => pl.status === "queued" || pl.status === "processing" || pl.status === "creating_ticket").length,
        at: Date.now(),
      });
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    }

    void fetchOrchestratorWebuiUrl()
      .then((res) => {
        if (!cancelled) setOrchUrl(res.url);
      })
      .catch(() => {});
    void fetchAuditorWebuiUrl()
      .then((res) => {
        if (!cancelled) setAuditorUrl(res.url);
      })
      .catch(() => {});

    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const orchOnline = !orchError;
  const audOnline = !audError;
  const anyOnline = orchOnline || audOnline;

  const activeTickets = (tickets ?? []).filter((t) => !!ACTIVE_STATUSES[t.status]);
  const activePlans = (plans ?? []).filter((p) => !!ACTIVE_PLAN_STATUSES[p.status]);
  // Newest first: the card shows the last PENDING_PR_LIMIT open PRs and
  // collapses whatever is older into one "…" row (created_at is ISO).
  const withPendingPrs = (tickets ?? [])
    .filter((t) => t.pr_url && (t.pr_state === "open" || t.pr_state === "unknown"))
    .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  const shownPrs = withPendingPrs.slice(0, PENDING_PR_LIMIT);
  const morePrs = withPendingPrs.length - shownPrs.length;

  // The orchestrator and the auditor SHARE one slot pool, so the card shows a
  // single footer: used = sum of the reachable services' slots, total = the
  // orchestrator's view (falling back to the auditor's). Only one reachable →
  // that service alone; both unreachable → the "— / —" offline rendering.
  const orchUsed = status?.slots_used ?? slots?.effective_concurrency;
  const orchTotal = status?.slots_total ?? slots?.effective_concurrency;
  const audUsed = aStatus?.slots_used ?? aSlots?.effective_concurrency;
  const audTotal = aStatus?.slots_total ?? aSlots?.effective_concurrency;
  const slotsUsed = (orchOnline ? orchUsed ?? 0 : 0) + (audOnline ? audUsed ?? 0 : 0);
  const slotsTotal =
    (orchOnline ? orchTotal : undefined) ?? (audOnline ? audTotal : undefined) ?? 0;
  const slotPct = slotsTotal > 0 ? Math.round((slotsUsed / slotsTotal) * 100) : 0;
  const analyzingShown = analyzingCount || (aStatus?.analyzing ?? 0);
  const activeJobs = runningTasks.length + analyzingShown;

  const openReviews = (report: AuditorReview) => {
    if (auditorUrl) window.open(`${auditorUrl}/reports/${encodeURIComponent(report.id)}`, "_blank", "noreferrer");
  };

  return (
    <>
    <Panel
      title="AI developer"
      icon={
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            anyOnline ? "bg-success dot-glow-success" : "bg-danger dot-glow-danger"
          }`}
          title={`${orchOnline ? "Orchestrator online" : "Orchestrator unreachable"} · ${
            audOnline ? "Auditor online" : "Auditor unreachable"
          }`}
        />
      }
      accent
      className="ov-aidev flex min-h-[600px] flex-col"
      bodyClassName="flex flex-1 flex-col space-y-3"
      collapsible={{
        key: "ai-developer",
        summary: anyOnline ? (
          <>
            {activeJobs} active · {slotsUsed}/{slotsTotal} slots
          </>
        ) : (
          "unreachable"
        ),
      }}
      actions={
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setSlotsOpen(true)}
            title="Edit the shared orchestrator + auditor slot pool (day/night concurrency)"
            className={CHIP_CLS}
          >
            <GearIcon className="h-3 w-3" />
            Slots
          </button>
          <a
            href={orchUrl ?? undefined}
            target="_blank"
            rel="noreferrer"
            title="Open the Orchestrator web UI"
            className={CHIP_CLS}
          >
            <BotIcon className="h-3 w-3" />
          </a>
          <a
            href={auditorUrl ?? undefined}
            target="_blank"
            rel="noreferrer"
            title="Open the auditor web UI"
            className={CHIP_CLS}
          >
            <MicroscopeIcon className="h-3 w-3" />
          </a>
        </div>
      }
    >
      {/* Tab switcher — header-chip styling, active tab in accent colors. */}
      <div className="flex items-center gap-1.5">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`rounded border px-2 py-0.5 text-[11px] transition-colors ${
              tab === id
                ? "border-accent text-accent"
                : "border-border text-muted hover:border-accent hover:text-accent"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "active" && (
        <div className="flex min-h-0 flex-1 flex-col space-y-3">
          {!anyOnline ? (
            <div className="space-y-1">
              <p className="text-xs text-warning">Orchestrator and Auditor unreachable</p>
              <p className="break-all text-[11px] text-muted">
                {orchError} · {audError}
              </p>
            </div>
          ) : runningTasks.length === 0 && analyzing.length === 0 ? (
            <div className="space-y-1">
              <p className="text-xs text-muted">No active jobs.</p>
              {!orchOnline && (
                <p className="text-xs text-warning">Orchestrator unreachable — showing auditor only.</p>
              )}
              {!audOnline && (
                <p className="text-xs text-warning">Auditor unreachable — showing orchestrator only.</p>
              )}
            </div>
          ) : (
            <>
              {/* Orchestrator's running work (the old panel lists the live
                  running-tasks feed as-is — the bridge already filters it). */}
              <div className="min-h-[4.5rem] space-y-1">
                <p className="text-xs uppercase tracking-wide text-muted">
                  Orchestrator — running tasks ({runningTasks.length})
                </p>
                {runningTasks.length > 0 ? (
                  runningTasks.map((task) => (
                    <RunningTaskRow
                      key={`${task.ticket_id}-${task.task_id}-${task.iteration}`}
                      task={task}
                      onOpen={() => {
                        if (orchUrl) {
                          window.open(
                            `${orchUrl}/tickets/${task.ticket_id}?task=${encodeURIComponent(task.task_id)}&taskIteration=${task.iteration}`,
                            "_blank",
                            "noreferrer"
                          );
                        }
                      }}
                    />
                  ))
                ) : (
                  <p className="text-xs text-muted">
                    {orchOnline ? "No tasks currently running." : "Orchestrator unreachable."}
                  </p>
                )}
              </div>
              <div className="flex min-h-[4.5rem] flex-1 flex-col space-y-1">
                <p className="text-xs uppercase tracking-wide text-muted">
                  Auditor — analyzing ({analyzingShown})
                </p>
                {analyzing.length > 0 ? (
                  analyzing.map((review) => (
                    <AnalyzingRow key={review.id} review={review} onOpen={() => openReviews(review)} />
                  ))
                ) : (
                  <p className="text-xs text-muted">
                    {audOnline ? "Nothing is analyzing right now." : "Auditor unreachable."}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {tab === "orchestrator" && (
        <div className="flex min-h-0 flex-1 flex-col space-y-3">
          {orchError ? (
            <div className="space-y-1">
              <p className="text-xs text-warning">Orchestrator unreachable</p>
              <p className="break-all text-[11px] text-muted">{orchError}</p>
            </div>
          ) : (
            <>
              {/* Running tasks */}
              <div className="min-h-[6rem] space-y-1">
                <p className="text-xs uppercase tracking-wide text-muted">
                  Running tasks ({runningTasks.length})
                </p>
                {runningTasks.length > 0 ? (
                  runningTasks.map((task) => (
                    <RunningTaskRow
                      key={`${task.ticket_id}-${task.task_id}-${task.iteration}`}
                      task={task}
                      onOpen={() => {
                        if (orchUrl) {
                          window.open(
                            `${orchUrl}/tickets/${task.ticket_id}?task=${encodeURIComponent(task.task_id)}&taskIteration=${task.iteration}`,
                            "_blank",
                            "noreferrer"
                          );
                        }
                      }}
                    />
                  ))
                ) : (
                  <p className="text-xs text-muted">No tasks currently running.</p>
                )}
              </div>

              {/* Active plans */}
              <div className="space-y-1">
                <p className="text-xs uppercase tracking-wide text-muted">
                  Active plans ({activePlans.length})
                </p>
                {activePlans.length > 0 ? (
                  activePlans.map((plan) => (
                    <PlanRow
                      key={plan.plan_id}
                      plan={plan}
                      onOpen={() => {
                        if (orchUrl) {
                          window.open(
                            // The engine mirrors a plan under its PLAN- ticket id.
                            `${orchUrl}/tickets/${encodeURIComponent(plan.plan_id.startsWith("PLAN-") ? plan.plan_id : `PLAN-${plan.plan_id}`)}`,
                            "_blank",
                            "noreferrer"
                          );
                        }
                      }}
                    />
                  ))
                ) : (
                  <p className="text-xs text-muted">No active plans.</p>
                )}
              </div>

              {/* Active tickets */}
              <div className="space-y-1">
                <p className="text-xs uppercase tracking-wide text-muted">
                  Active tickets ({activeTickets.length})
                </p>
                {activeTickets.length > 0 ? (
                  activeTickets.map((ticket) => (
                    <TicketRow
                      key={ticket.ticket_id}
                      ticket={ticket}
                      onOpen={() => {
                        if (orchUrl) {
                          window.open(
                            `${orchUrl}/tickets/${ticket.ticket_id}`,
                            "_blank",
                            "noreferrer"
                          );
                        }
                      }}
                    />
                  ))
                ) : (
                  <p className="text-xs text-muted">No active tickets.</p>
                )}
              </div>

              {/* Pending PRs */}
              <div className="space-y-1">
                <p className="text-xs uppercase tracking-wide text-muted">
                  Pending PRs ({withPendingPrs.length})
                </p>
                {withPendingPrs.length > 0 ? (
                  <>
                    {shownPrs.map((ticket) => (
                      <div key={`pr-${ticket.ticket_id}`} className="flex items-center gap-2">
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
                        <span className="min-w-0 flex-1 truncate text-xs text-text">
                          {ticket.name}
                        </span>
                        <a
                          href={ticket.pr_url ?? undefined}
                          target="_blank"
                          rel="noreferrer"
                          className="shrink-0 inline-flex items-center gap-1 rounded border border-indigo-500/40 px-1.5 py-0.5 text-[10px] font-medium text-indigo-400 transition-colors hover:border-indigo-500"
                          title={ticket.pr_url ?? ""}
                        >
                          PR
                          <ExternalLinkIcon className="h-2.5 w-2.5" />
                        </a>
                      </div>
                    ))}
                    {morePrs > 0 ? (
                      <a
                        href={orchUrl ?? undefined}
                        target="_blank"
                        rel="noreferrer"
                        title={`${morePrs} older pending pull ${morePrs === 1 ? "request" : "requests"} — open the orchestrator`}
                        className="flex items-center gap-2 text-xs text-muted transition-colors hover:text-indigo-400"
                      >
                        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400/40" />
                        <span className="min-w-0 flex-1 truncate">… and {morePrs} more</span>
                        <ExternalLinkIcon className="h-2.5 w-2.5 shrink-0" />
                      </a>
                    ) : null}
                  </>
                ) : (
                  <p className="text-xs text-muted">No pending pull requests.</p>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {tab === "auditor" && (
        <div className="flex min-h-0 flex-1 flex-col space-y-3">
          {audError ? (
            <div className="space-y-1">
              <p className="text-xs text-warning">Auditor unreachable</p>
              <p className="break-all text-[11px] text-muted">{audError}</p>
            </div>
          ) : (
            <>
              {/* Analyzing now — the auditor's live slot consumers */}
              <div className="min-h-[4.5rem] space-y-1">
                <p className="text-xs uppercase tracking-wide text-muted">
                  Analyzing now ({analyzingShown})
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
                  This section is the tab's flex-grow region: when the card is
                  taller than the natural content, the list absorbs the spare
                  height and scrolls instead of leaving a dead gap above the
                  footer. */}
              <div className="flex min-h-[7rem] flex-1 flex-col space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs uppercase tracking-wide text-muted">Finished — Ready</p>
                  {auditorUrl && (
                    <a
                      href={`${auditorUrl}/reports`}
                      target="_blank"
                      rel="noreferrer"
                      title="Show all ready reports in the auditor"
                      className={CHIP_CLS}
                    >
                      <ExternalLinkIcon className="h-3 w-3" />
                      Show all {readyCount ?? 0} ready reports
                    </a>
                  )}
                </div>
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
                      // Ready carries the list's filter: an empty ready report is
                      // not a finding, so the strip counts the same set as the
                      // "Finished — Ready" section and the pill.
                      const n =
                        key === "findings_ready"
                          ? readyCount ?? aStats?.by_status?.[key]
                          : aStats?.by_status?.[key] ?? (key === "analyzing" ? aStatus?.analyzing : undefined);
                      if (n == null) return null;
                      return (
                        <span
                          key={key}
                          title={key === "findings_ready" ? "Ready reports with findings" : undefined}
                          className="inline-flex items-center gap-1"
                        >
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
        </div>
      )}

      {/* Combined slot usage footer — the orchestrator and the auditor share
          one pool, so the card shows the sum, not two separate bars. */}
      <div className="mt-auto flex items-center gap-3 border-t border-border pt-3">
        <div className="min-w-0 flex-1">
          <div className="h-1.5 overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full bg-bar"
              style={{ width: `${slotPct}%` }}
            />
          </div>
        </div>
        <span
          className="shrink-0 whitespace-nowrap text-center"
          title="Slots in use — the orchestrator and the auditor share one pool"
        >
          <span className="font-tabular text-[18px] font-bold leading-none text-text-strong">
            {anyOnline ? `${slotsUsed} / ${slotsTotal}` : "— / —"}
          </span>
          <span className="text-sm font-normal text-muted"> slots</span>
        </span>
      </div>
    </Panel>
      <SlotSettingsDialog
        open={slotsOpen}
        onClose={() => setSlotsOpen(false)}
        onSaved={(next) => {
          setSlots(next);
          // Re-poll so status totals reflect the new concurrency promptly.
          void fetchOrchestratorStatus().then((s) => setStatus(s)).catch(() => {});
        }}
      />
    </>
  );
}
