import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PrCompanionPull,
  PrCompanionPullsResponse,
  PrCompanionRun,
  PrCompanionRunsResponse,
  PrCompanionStatus,
} from "../../api/types";
import { cleanupRenders, flush, render } from "../../testing/render";
import { AiDeveloperPanel } from "./AiDeveloperPanel";

/** Mutable live-shaped payloads; each test pins the scenario before render. */
let orchestratorStatus: Record<string, unknown> = { slots_used: 2, slots_total: 8, tickets_active: 0 };
let auditorStatus: Record<string, unknown> = { slots_used: 0, slots_total: 2, analyzing: 0 };
/** Flipped per test to simulate the companion bridge being unreachable. */
let companionDown = false;

const companionStatus: PrCompanionStatus = {
  running: true,
  paused: false,
  enabled: true,
  analyzing: 1,
  queued: 1,
  slots_used: 1,
  slots_total: 8,
  orchestrator_slots_used: 2,
  orchestrator_slots_pending: 0,
  auditor_slots_used: 0,
  auditor_slots_pending: 0,
  companion_cap: 2,
  force_running: 0,
  in_auto_window: false,
  auto_next_at: null,
  model_online: true,
  served_models: ["DeepSeek-V4.1-Flash-1017", "glm-5.3-flash-coder-max-p2"],
  renderer_ok: true,
  github_ok: true,
  github_auth: "ok",
  repos_enabled: 1,
  open_prs: 2,
  analyzed_prs: 2,
  version: "0.1.0",
};

const runningRun: PrCompanionRun = {
  id: "run-1",
  pr_id: "platform#486",
  repo_id: "platform",
  repo_name: "platform",
  number: 486,
  title: "Add mailbox probe watchdog",
  status: "running",
  features: ["lens", "risk"],
  assessment_kind: "initial",
  phase: "lens",
  phase_detail: "lens: reading the diff",
  progress: 40,
  position: null,
  force: false,
  error: null,
  created_at: "2026-11-15T01:00:00Z",
  started_at: "2026-11-15T01:00:05Z",
  finished_at: null,
};

const queuedRun: PrCompanionRun = {
  ...runningRun,
  id: "run-2",
  pr_id: "platform#487",
  number: 487,
  title: "Fix flaky storage scan",
  status: "queued",
  phase: null,
  phase_detail: null,
  progress: 0,
  position: 1,
  started_at: null,
};

const openPulls: PrCompanionPull[] = [
  {
    id: "pr-1",
    repo_id: "platform",
    repo_name: "platform",
    repo_slug: "Weby24cz/platform",
    number: 486,
    title: "Add mailbox probe watchdog",
    author: "pavel",
    state: "open",
    draft: false,
    additions: 412,
    deletions: 87,
    changed_files: 14,
    html_url: "https://github.com/Weby24cz/platform/pull/486",
    created_at: "2026-11-14T20:00:00Z",
    updated_at: "2026-11-14T22:00:00Z",
    latest_risk_band: "high",
    latest_analysis_status: "current",
    checks_summary: { total: 3, passing: 3, failing: 0, pending: 0 },
    mergeable: true,
    mergeable_state: "clean",
  },
  {
    id: "pr-2",
    repo_id: "platform",
    repo_name: "platform",
    repo_slug: "Weby24cz/platform",
    number: 490,
    title: "Draft: cache history tiers",
    author: "pavel",
    state: "open",
    draft: true,
    additions: 10,
    deletions: 2,
    changed_files: 2,
    html_url: "https://github.com/Weby24cz/platform/pull/490",
    created_at: "2026-11-15T00:30:00Z",
    updated_at: "2026-11-15T00:40:00Z",
    latest_risk_band: null,
    latest_analysis_status: "queued",
    checks_summary: null,
    mergeable: null,
    mergeable_state: null,
  },
];

vi.mock("../../api/client", () => ({
  fetchOrchestratorStatus: () =>
    Promise.resolve(orchestratorStatus),
  fetchOrchestratorTickets: () => Promise.resolve([]),
  fetchOrchestratorPlans: () => Promise.resolve([]),
  fetchOrchestratorRunningTasks: () => Promise.resolve([]),
  fetchOrchestratorSlotsConfig: () => Promise.resolve(null),
  fetchAuditorStatus: () => Promise.resolve(auditorStatus),
  fetchAuditorStats: () => Promise.resolve({ by_status: {} }),
  fetchAuditorReviews: () => Promise.resolve({ reviews: [], count: 0, limit: 200, offset: 0 }),
  fetchAuditorFindings: () => Promise.resolve({ findings: [], count: 0, limit: 500, offset: 0 }),
  fetchAuditorTierCScans: () => Promise.resolve({ scans: [] }),
  fetchAuditorSlotsConfig: () => Promise.resolve(null),
  fetchOrchestratorWebuiUrl: () => Promise.resolve({ url: "http://127.0.0.1:10001" }),
  fetchAuditorWebuiUrl: () => Promise.resolve({ url: "http://127.0.0.1:443" }),
  fetchPrCompanionStatus: () =>
    companionDown ? Promise.reject(new Error("down")) : Promise.resolve(companionStatus),
  fetchPrCompanionPulls: (): Promise<PrCompanionPullsResponse> =>
    companionDown ? Promise.reject(new Error("down")) : Promise.resolve({ pulls: openPulls }),
  fetchPrCompanionRuns: (): Promise<PrCompanionRunsResponse> =>
    companionDown ? Promise.reject(new Error("down")) : Promise.resolve({ runs: [runningRun, queuedRun], total: 2 }),
  fetchPrCompanionWebuiUrl: () => Promise.resolve({ url: "http://127.0.0.1:10031" }),
}));

beforeEach(() => {
  companionDown = false;
  orchestratorStatus = { slots_used: 2, slots_total: 8, tickets_active: 0 };
  auditorStatus = { slots_used: 0, slots_total: 2, analyzing: 0 };
});

afterEach(() => {
  cleanupRenders();
});

describe("AiDeveloperPanel — PR Companion integration", () => {
  it("adds the PR Companion tab, jump link and a running section to the Active tab", async () => {
    const { container } = render(<AiDeveloperPanel />);
    await flush();
    await flush();

    // Fourth tab, counting the polled open-PR window.
    const tabs = Array.from(container.querySelectorAll("button")).map((b) => b.textContent ?? "");
    expect(tabs).toContain("PR Companion (2)");
    expect(tabs).toContain("Auditor (0)");

    // Third header jump link: the companion's brand mark.
    const jump = container.querySelector('a[title="Open the PR Companion web UI"]');
    expect(jump).not.toBeNull();
    expect(jump?.getAttribute("href")).toBe("http://127.0.0.1:10031");

    // Active tab (default) carries the companion's live work — the running
    // run with its phase detail, and the count into the active-jobs header.
    expect(container.textContent).toContain("PR Companion — running (1)");
    expect(container.textContent).toContain("Add mailbox probe watchdog");
    expect(container.textContent).toContain("lens: reading the diff");

    // The shared-pool footer sums all three services: 2 orch + 0 aud + 1 companion of 8.
    expect(container.textContent).toContain("3 / 8 slots");
    // The blue companion segment exists in the footer bar.
    const footerBar = container.querySelector(".mt-auto .h-full.bg-\\[\\#4493f8\\]");
    expect(footerBar).not.toBeNull();
  });

  it("renders the companion tab with the queue, open PRs and health strip", async () => {
    const { container } = render(<AiDeveloperPanel />);
    await flush();
    await flush();

    const tabButton = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").startsWith("PR Companion")
    );
    expect(tabButton).not.toBeNull();
    await flush();
    act(() => tabButton!.click());
    await flush();

    // Queue: running first, then queued (§13.2 dispatch order).
    expect(container.textContent).toContain("Queue (2)");
    expect(container.textContent).toContain("Add mailbox probe watchdog");
    expect(container.textContent).toContain("Fix flaky storage scan");
    // Auditor-row anatomy on the queued row: repo + live queue position + age meta line.
    expect(container.textContent).toContain("#1 in queue");

    // Open PRs with the companion's chips inline in the meta line:
    // high risk + analyzed on #486, plus the diff-size/age meta.
    expect(container.textContent).toContain("Open pull requests (2)");
    const chips = Array.from(container.querySelectorAll("span")).map((s) => s.textContent ?? "");
    expect(chips).toContain("high");
    expect(chips).toContain("analyzed");
    expect(chips).toContain("draft");
    expect(container.textContent).toContain("+412 −87");

    // Health strip: model online, GitHub auth ok, served-model count.
    expect(container.textContent).toContain("model online");
    expect(container.textContent).toContain("GitHub ok");
    expect(container.textContent).toContain("served models");
  });

  it("degrades gracefully when only the companion is unreachable", async () => {
    companionDown = true;
    const { container } = render(<AiDeveloperPanel />);
    await flush();
    await flush();

    // Nothing active anywhere → the honest empty state names the dead service.
    expect(container.textContent).toContain("No active jobs.");
    expect(container.textContent).toContain("PR Companion unreachable — showing others only.");
    // The other services' unreachable notes are absent — they answered.
    expect(container.textContent).not.toContain("Orchestrator unreachable");
    expect(container.textContent).not.toContain("Auditor unreachable");

    // The tab still renders with the unreachable count (no data).
    const tabs = Array.from(container.querySelectorAll("button")).map((b) => b.textContent ?? "");
    expect(tabs).toContain("PR Companion (0)");

    // Slot math: the companion contributes nothing; orch + aud remain.
    expect(container.textContent).toContain("2 / 8 slots");
    // The blue companion segment stays in the bar (same convention as the
    // other services) but at zero width.
    const footerBar = container.querySelector<HTMLDivElement>(".mt-auto .h-full.bg-\\[\\#4493f8\\]");
    expect(footerBar).not.toBeNull();
    expect(footerBar!.style.width).toBe("0%");
  });
});
