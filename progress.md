# Progress log

## 2026-11-07 — AiProxyPanel: stale queue rows + queued/running duplicates (fix)

**Symptom.** When only the AI proxy queue endpoint failed (e.g. proxy observer
queue route down), the Overview "AI Proxy" panel kept rendering the last good
queue snapshot as if live: waiters that had since been admitted still showed as
"Queued (N)" rows among the running requests. Reloading the page (remount)
cleared it. A second face of the same bug: even with both snapshots live, a
request id present in `queue.waiters` and in `streams`/`active-requests`
rendered twice — once queued, once running.

**Root cause.** `src/components/OverviewPage/AiProxyPanel.tsx` polls
streams / active-requests / stats / queue via `Promise.all`, each
`.catch(() => null)`; a `null` result left that source's state untouched
("each endpoint degrades independently"), and `setError(saw ? null : …)` marked
the panel online whenever ANY endpoint succeeded. So a queue-only failure meant
the `queue` state was never updated nor marked — indistinguishable from live.
The render also had no id dedup between `queueWaiters` and `allRunning`, and
the proxy request id is stable across the queued→running transition.

**Fix** (frontend only; `server/index.js` bridge untouched):
- Running-wins dedup: build `runningIds` from `allRunning` (streams +
  requests); `queueWaiters` filters to waiters whose id is not running, and
  `queuedCount` counts the filtered list when `queue.waiters` exists (scalar
  `queue.waiting ?? 0` fallback when `waiters` is absent, unchanged).
- Per-source staleness: `lastOk: Record<PollSource, number>` state updated each
  poll with `Date.now()` for every endpoint that succeeded. When the panel is
  online and the queue snapshot is older than a full poll cycle
  (`Date.now() - lastOk.queue >= POLL_MS`, i.e. the queue endpoint failed the
  latest cycle), the "Queued (N)" header appends an amber ` · stale` span
  (`text-warning`) whose `title` explains the proxy queue endpoint is
  unreachable and rows may no longer be current. Hold-last-frame design kept —
  rows are not hidden. Tracking is keyed by source name so stats/streams can
  reuse it later; no UI added for the other sources now.
- Untouched: kill flow, AutoPower `idleRef` publication, stats footers, kiosk,
  `combinedWaiting` scalar logic.

**Tests.** New `src/components/OverviewPage/AiProxyPanel.test.tsx` (vitest +
jsdom, `vi.mock("../../api/client")`, fake timers for the poll loop): (a) same
id in queue.waiters and streams → rendered once, under Running, header shows
"Queued (1)"; (b) queue endpoint rejects while others resolve → queued rows
persist AND header carries the `· stale` marker with the explanatory title;
(c) healthy polls → no stale marker.
- Post-review follow-up: added two more cases — all-waiters-running hides the
  Queued section entirely (header, rows, stale marker), and the stale marker
  clears after the queue endpoint recovers (fail cycle → marker, next healthy
  cycle → gone).

**Verification** (repo root, all pass): `npm run typecheck` · `npm run build` ·
`npm test` → Test Files 134 passed (134), Tests 1035 passed (1035); all 5 new
cases pass (`npx vitest run src/components/OverviewPage/AiProxyPanel.test.tsx`).

## 2026-11-10 — Kiosk Kraken: Auditor tile read the pre-shared-pool `analyzing` (fix)

Commit `063a25d` on `merge/v2.0.0`, pushed to `fork/merge/v2.0.0`. Files:
`src/components/KioskKrakenPage/KioskKrakenPage.tsx`,
`…/KioskKrakenPage.test.tsx`, `CHANGELOG.md`, `README.md`.

**Symptom.** The `/kiosk-kraken` Auditor tile showed 0 running jobs while the
auditor really was running jobs — two Tier-C hunts held both pool slots. Live
proof at the time: `:10010/api/status` → `analyzing:0, slots_used:2`, and
`/api/tier-c/scans?status=running` → 2 rows.

**Root cause.** The daemons moved to one shared AI slot pool (upstream
spark.ai.developer `2397566`), so the auditor's honest occupancy is its own
`slots_used` = analyzing + checking + Tier-C hunts (`vuln_scan`
running/stopping) + proof runs (`src/auditor/api.py:832-846,859`). `analyzing`
counts only review rows in status `analyzing`, so a fleet busy with hunts
rendered 0.

**Fix** (frontend only; the bridge is a verbatim pass-through at
`server/index.js:844-856`, so no server change and no new route):
- `KioskKrakenPage.tsx:200-202`: one `usePolled(fetchAuditorStatus)` now feeds
  both the value and the `/N` suffix (the tile polled the same endpoint twice
  before); `auditorRunning = auditorStatus?.slots_used ??
  auditorStatus?.analyzing` — `??`, never `||`, so a genuine 0 stays 0, and
  nullish stays nullish so the tile keeps rendering "—" and a dead bridge
  never fabricates a 0.
- Slide label / `aria-label` → "Auditor running jobs"; the value now also
  covers tip checks, Tier-C hunts and proof runs.
- Left alone deliberately: the Overview panel was already migrated
  (`AiDeveloperPanel.tsx:684`), and the orchestrator tile still reads
  `fetchOrchestratorRunningTasks().length` — live `/api/running-tasks` is `[]`
  and the orchestrator's own `slots_used` is 0, so that 0 is honest.

**Tests.** `src/components/KioskKrakenPage/KioskKrakenPage.test.tsx`: the
`fetchAuditorStatus` mock payload is now a mutable live-shaped object
(`analyzing:0, checking:0, reviews_queued:0, slots_used:2, slots_total:2`),
reset in `beforeEach`, so the default assertions expect "2" and NO
`.kk-waiting` suffix. That FAILS against the old derivation
(`expected '0' to be '2'`) — the regression catcher. One new case pins the
pre-shared-pool degradation: a payload without `slots_used` renders "4" with
"/2". The unreachable-bridge case still asserts the slides hold "—", never
zeros.

**Verification** (repo root, all pass): `npx vitest run
src/components/KioskKrakenPage/` → 4 passed · `npm run typecheck` clean ·
`npm run test:server` → 1641 pass / 17 skip / 0 fail · `npm run test:frontend`
→ Test Files 134 passed (134), Tests 1036 passed (1036) · `npm run build` →
`dist/assets/index-C1tyjJAu.js`.
- Deployed live through the bind-mounted `dist` (no container restart needed,
  server code unchanged); the served asset's sha256 matched host `dist/`
  byte-for-byte.
- Browser checks: an isolated instance with a stub daemon (`analyzing:0,
  slots_used:3, reviews_queued:1`) rendered 3 with a `/1` suffix and aria-label
  "Auditor running jobs"; a pre-overhaul payload rendered 4 with `/2`; killing
  the stub left the tile holding 3/1 (no fabricated 0); one
  `/api/auditor/status` request per 5 s cycle. The production page matched the
  live bridge values. Screenshots under `/tmp/kraken-verify/shots/`.

**Broken / known.**
- `GET :5555/api/health` still reports `version 2.75.0` while `package.json`
  says 2.75.5: `/app/package.json` is image-baked, not bind-mounted, and the
  container process is 2 days old. Consequence: any future SERVER-side change
  needs `docker compose restart`, or the version will keep lying; frontend
  changes do not.
- The auditor's Tier-C daily budget is exhausted (`tier_c.park_reason:
  "tier_c_budget_exhausted"`, 2918 agent-min), so the kraken auditor tile
  legitimately reads 0 until the nightly window — not this bug returning.
- `server/autopower/probe.js:28-90` has no auditor source at all: `busyReasons`
  counts only proxy streams/requests and the orchestrator's
  `slots_used`/`tickets_active`/plans. An auditor-only-busy fleet (exactly the
  Tier-C case above) reads idle to AutoPower unless the proxy happens to have
  an in-flight request. Not fixed here — out of scope for the kiosk ticket.

**Next.**
- Re-check the kraken auditor tile once Tier-C resumes, to confirm a non-zero
  reading from real traffic.
- Decide whether AutoPower should treat the auditor's `slots_used` as busy
  (probe + `busyReasons` + `AutoPowerManager.test.js` fixtures), now that the
  two daemons share one pool.
- Optional: the auditor ignores an unknown `status` filter on
  `/api/tier-c/scans` (running/done/failed all come back) — worth pinning
  upstream if sparkDash ever filters there.

---

## 2026-11-12 — Merged origin/main v2.90.0 into merge/v2.0.0 (31 conflicts)

**Merge commit `eefe390`** (parents `063a25d` + `24daeb5`), built in the worktree
`/home/pavelkubicek/docker/sparkDash-merge-290` (detached; `merge/v2.0.0` is checked
out in the main tree). Nothing pushed — `fork/merge/v2.0.0` still `063a25d`.

**Verification (all run in that worktree after `npm install`, 256 packages).**
`npm run typecheck` clean · `npm run build` clean · `npm run i18n:check` passed ·
`npm run test:i18n-check` 11/11 · `npm run test:server` **2364 tests, 2339 pass,
0 fail, 25 skipped** · `npm run test:frontend` **200 files, 1522 tests, all pass** ·
no conflict markers anywhere.

**Version convention** (matches `c7e2faf` / `7d5bb53`): package.json keeps
upstream's version → **2.90.0**; the `test:server` glob is the UNION (fork-only
`models`, `autopower`, `vulnhunt` suites plus upstream's `powermeter`, `apiKeys`,
`apikeys-bridge`, `storage` all run).

**Conflict decisions (31 files).** Union everywhere; notable ones:
- `server/index.js` (10 hunks): shutdown imports deduped (`checkLocalShutdown` +
  fork's `initiateSparkShutdown`/`shutdownErrorStatus`); config import unioned
  (`AUTOPOWER_FEATURE` + `STORAGE_*`); AutoPower/REA/VulnHunt + API-Keys routes all
  registered; `createFleetEnergyRuntime` gets fork's `isKeepAwake` AND upstream's
  `wallReadings`; `registerFleetEnergyRoute` keeps fork's 3-arg call plus
  `powerMeters.register(app)`; `registerGpuClockRoutes` gets fork's `getSchedule`
  AND upstream's `allowPlainPassword`; CPU-clock block and Storage-Manager block
  both kept. Shutdown-all = upstream's `checkLocalShutdown()` local guard +
  fork's `message` + `grantActionGrace(…, SHUTDOWN_GRACE_MS)` on both paths.
  Fork's ai-proxy/auditor/orchestrator bridges (index.js ~840-963) untouched.
- `server/collectors/SystemCollector.js`: kept the fork's build/parse refactor and
  folded upstream in — nvidia query now also asks `fan.speed,pcie.link.gen.*,
  pcie.link.width.*` (upstream's `_parseGpuLines` reads them), `_getRemoteGpu`,
  `_getRemoteRam`, `_getRemoteUnifiedMemory` use the injected `this._sshExec`
  (same fix as `c7e2faf`), and upstream's `availableSource: "linux-memavailable"`
  was re-added to `_parseRemoteUnifiedMemory` (it lived in the deleted inline body).
- `server/energy/FleetEnergyTracker.js`: upstream's `estimateNodeParts()`
  extraction kept with the fork's sensor-first model inside it (system rail +
  GPU-util augmentation, board-draw, and CPU-only `gpuMonitoring:false` branches;
  `gpuWatts` is the measured GPU-side figure of the branch taken).
- `server/energy/FleetEnergyRuntime.js`: fork's CPU-only freshness restructure
  kept; upstream's three `metricAvailability` guards re-placed in their branches
  (`cpu.usageAvailable` in the CPU leg, the two GPU guards in the GPU leg) —
  taking upstream's block verbatim would have read `gpu` before its declaration.
- `server/sparks/SparkMonitor.js`: kept fork's bundle/local-domain placement;
  upstream's `runtimes` poll + collector-capability guard added.
- `server/gpuclock/*`: `passwordAllowed`/power methods (upstream) and
  `getSchedule`/`applySchedule`/`removeSchedule` (fork) coexist; test helper takes
  both `getSchedule` and `plain`, both suites kept.
- Frontend: `client.ts`/`types.ts` unioned (CPU-clock + GPU-power + Storage
  endpoints, VulnHunt/REA types + Storage types, `FleetEnergy` carries both
  `alwaysSampling` and `wall`/`FleetWallEnergy`); `constants` union
  (`KIOSK_KRAKEN_ID` + `API_KEYS_ID`); sidebar/tab-bar keep the fork's Tools group
  and upstream's Storage/API-Keys entries; icons union (brand logos + Key/Trash/
  Folder/File/Lock/Link/Box/Copy); `BENCH_TYPES` → `NAV_BENCH_TYPES` in nav and
  palette (still includes the fork's vulnhunt).
- Docs: CHANGELOG and README keep both sides' entries/sections.

**Judgement calls (review these).**
1. `MobileTabBar` section heading: the fork splits the group into **Tools** +
   **Benchmarks**, upstream renamed the single heading to "Benchs & Tools"
   (`nav.benchsTools`). Kept the fork's split with upstream's i18n
   (`t("nav.benchmarks")`), matching what the auto-merged `AppSidebar` body already
   does. `shell.test.tsx`'s upstream heading assertion was adapted
   (`toContain("Tools")` + `toContain("Benchmarks")`); every behavioural upstream
   assertion (Storage listed there and opening `__storage__`) is kept.
2. `SparkCard`: kept the fork's `{gpu ? …}` guard and the loaded-model fold, took
   upstream's i18n (`memory.vram`, `card.loaded`, `card.loadedModelTitle`,
   `gpuUsageGap`); the fork's `"Usage - CPU"` bar stays a literal — no locale key
   exists for it (`i18n:check` still passes).
3. `apiFetch` now throws upstream's `ApiError` (it carries `status`, so the fork's
   `LogConsole` 404-vs-retry check still works).
4. Upstream's new `EnergyPage.wall.test.tsx` fixture needed the fork's required
   `alwaysSampling` field.
5. `App.tsx` command palette: upstream indexed `benchLabels[b.id]` directly, which
   crashes on the fork's `vulnhunt` bench (the hook only knows upstream's five).
   Now `benchLabels[b.id]?.label ?? b.label`, as the sidebar/tab bar already do.

**Two upstream tests were red before this merge** (verified identical on pristine
`24daeb5` in a scratch worktree; they are only run now because the fork's
`test:server` glob covers `server/models` and `server/storage`):
- `server/models/__tests__/discovery.test.js` "every discovery command is
  read-only" — its own builder emits `find … -name start.sh`, and the reader regex
  required a trailing token after `ollama list`. Fixed the assertion (only the two
  `-name start|stop.sh` literals are exempt; every other verb/redirect/substitution
  still trips) rather than weakening the check.
- `server/storage/__tests__/deleteV2.test.js` "without renameat2, mv -n --no-copy -T…"
  — this host's `/usr/bin/mv` (`mv 0.8.0`, not GNU coreutils) **exits 0 while
  refusing to overwrite**, so `staging.sh`'s own self-test rejects it and the delete
  correctly falls back to in-place removal. Added a capability probe mirroring
  staging.sh's self-test and skipped the test with that reason, matching the file's
  existing "mount lane skipped" convention.

**Still broken / next.**
- Nothing known-broken in the merged tree; the two items above are environment or
  upstream-test issues, both handled, and worth an upstream PR.
- Flag for upstream review: with neither `renameat2` nor a compliant `mv`,
  `delete.sh` reports `RESULT=ok`/`STAGED=none` and no `RENAME` value — an
  in-place delete that never staged. Correct per its fallback design, but the
  response says nothing about why staging was skipped.
- Worktree `/home/pavelkubicek/docker/sparkDash-merge-290` left in place (cleanup
  later). Suggested next step: fast-forward `merge/v2.0.0` to `eefe390`, run the
  stack once in Docker (GPU fan/PCIe tiles, Storage Manager, API Keys page,
  power-meter wall series, kiosk kraken), then push to `fork`.

## 2026-11-12 — Deploy v2.90.0 + e2e

**Deployed:** `merge/v2.0.0` @ `eefe390` ("Merge origin/main (v2.90.0) into merge/v2.0.0") to the
production compose stack (`sparkdash` project, container `sparkDash`, host network, :5555).

- `npm install`: "up to date" (node_modules already matched the merged lockfile).
- `npm run build`: Vite OK in 1.0 s → `dist/assets/index-CRhClZXB.js` (2,006.86 kB; >500 kB chunk warning only).
- Mounts confirmed live via `docker inspect`: `./server→/app/server`, `./dist→/app/dist:ro`,
  `./config→/app/config`, `./src/shared→/app/src/shared:ro` (override keeps the dist mount).
- `docker compose restart`: health 200 within 5 s; `StartedAt=2026-11-12T09:51:28Z` (was 2026-11-08),
  RestartCount 0 — fresh process proven.
- `GET /api/health`: `{"ok":true,"authMode":"open-remote","version":"2.75.0",
  "warnings":["SSH identity is not mounted"]}` — version is the **image-baked** package.json value
  (documented container behavior; no image rebuild per plan).
- Serve-asset parity: host `dist/assets/index-CRhClZXB.js` sha256
  `5039524da50059a2be10da0bed1d2fc0657baef44cfe5895d26e4ee4b340a530` == served via :5555 == in-container copy.
- `config/settings.json` shows as modified in `git status` (server rewrites it; content diff vs HEAD is
  empty at check time) — left untouched per policy.

**E2E (headless Chromium, 1440×900, shots in `/tmp/deploy-290/shots/`, page texts in `/tmp/deploy-290/`,
full results `/tmp/deploy-290/results.json`):** all 8 checks PASS; **zero uncaught errors, zero console
errors, zero warnings** across every page.

1. `/overview` (01-overview.png): 5/5 spark cards live (spark1 95% GPU/64°C, spark3 96%/69°C …);
   AI Proxy panel "RUNNING REQUESTS (6)" + stats (93.03% cache); Recent activity rows present.
   Queued section: proxy queue empty at check time ("0 wait") → header correctly hidden (renders only
   when `queuedCount>0`, AiProxyPanel.tsx:490); fork dedup (running-wins filter :427) and `· stale`
   marker (:499) code-verified, not observable with healthy endpoints.
2. `/` (02-root.png): default Overview render; sidebar = fork's TOOLS group (REA) + BENCHMARKS incl.
   VulnHunter + upstream's **Storage** entry. **API Keys entry absent by design**: `settings.apiKeysEnabled
   = false` (verified via `GET /api/settings`), upstream opt-in; sidebar + route gated on it.
3. `/storage` (03-storage.png): Storage Manager renders — 4 units, disk breakdown, Files-and-folders/
   Docker lanes, analyse flow, permissions notice.
4. `/api-keys` (13-api-keys-redirect.png): route renders Overview — App.tsx:503 redirects when
   `apiKeysEnabled=false`. Working-as-designed opt-in gate, NOT a merge regression; enabling requires
   Settings (config edit — out of scope). Localized labels confirmed in source + i18n pass.
5. `/kiosk-kraken` (05-kiosk-kraken.png): auditor tile shows **2**; daemon `GET :10010/api/status`
   reports `slots_used:2, analyzing:0` → fork `slots_used ?? analyzing` (KioskKrakenPage.tsx:201)
   proven live (pre-fix would show 0). "—" only when both nullish.
6. `/bench` — bare `/bench` is not a route (catalog lives in the sidebar; renders Overview fallback).
   Pages checked instead: `/bench/decode` (10, v2 temp/thinking controls), `/bench/quality` (11, Compare +
   GSM8K-Platinum/MMLU-Pro/MMLU), `/bench/vulnhunt` (12, fork page, opt-in-off clean state, nothing started).
7. `/energy` (07-energy.png): renders with power-telemetry estimate ("Estimated … Not wall-metered");
   no wall series because power meters are not configured — clean state, no error.
8. Mobile 420×900 (08-mobile-overview.png): `/overview` renders fully, `scrollWidth 412 ≤ clientWidth 420`
   — no overflow/crash; resized back afterwards.

Extra evidence: `/spark/spark1-lan` GPU panel (09-spark1-gpu.png) shows the new rows — Card NVIDIA GB10,
**Fan —**, **PCIe link —** (GB10 reports N/A; rows render with em-dash per design), Throttle reasons
"Clock locked ≤ 2200 MHz".

**Broken:** nothing found. **Next:** optionally enable API Keys (Settings → API Keys + bridge env) to see
the page for real; push `merge/v2.0.0` to `fork`; image rebuild would restore the correct version string
in `/api/health` (cosmetic).
