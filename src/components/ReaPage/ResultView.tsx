import { useEffect, useId, useState } from "react";
import { downloadReaExport, fetchReaView } from "../../api/client";
import { ReaApiError, type ReaResultSummary, type ReaRun, type ReaWorkflowSpec } from "../../api/types";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import type { ResultState } from "./hooks";
import { Notice } from "./parts";
import { boundedJson, findRows, findTotal, plain, rowColumns, runTitle, viewSources, type ViewSource } from "./reaLogic";

const PAGE_SIZES = [10, 25, 50, 100];

interface PagedViewProps {
  sparkId: string;
  runId: string;
  sources: ViewSource[];
  declared: Record<string, readonly string[]>;
}

/** One page of a collection or facet at a time. Never asks for more than the chosen page size (max 100, server cap 200). */
function PagedView({ sparkId, runId, sources, declared }: PagedViewProps) {
  const uid = useId();
  const [sourceId, setSourceId] = useState(sources[0]?.id ?? "");
  const [limit, setLimit] = useState(25);
  const [offset, setOffset] = useState(0);
  const [state, setState] = useState<{ loading: boolean; error: string | null; view: unknown; notViewable: boolean }>({
    loading: false,
    error: null,
    view: null,
    notViewable: false,
  });
  const source = sources.find((s) => s.id === sourceId) ?? sources[0];

  useEffect(() => {
    if (!source) return;
    let off = false;
    setState({ loading: true, error: null, view: null, notViewable: false });
    fetchReaView(sparkId, runId, { [source.param]: source.id, offset, limit })
      .then((r) => !off && setState({ loading: false, error: null, view: r.view, notViewable: false }))
      .catch((e) => {
        if (off) return;
        const notViewable = e instanceof ReaApiError && e.status === 400;
        setState({ loading: false, error: e instanceof Error ? e.message : String(e), view: null, notViewable });
      });
    return () => {
      off = true;
    };
  }, [sparkId, runId, source?.id, source?.param, offset, limit]);

  if (!source) return null;
  const rows = state.view != null ? findRows(state.view) : null;
  const total = state.view != null ? findTotal(state.view) : null;
  const cols = rows ? rowColumns(rows, declared[source.id]) : [];
  const hasNext = total != null ? offset + limit < total : (rows?.length ?? 0) >= limit;

  return (
    <div className="rea-stack">
      <div className="rea-row">
        <div className="rea-field">
          <label className="rea-label" htmlFor={`${uid}-src`}>
            Show
          </label>
          <select
            id={`${uid}-src`}
            value={source.id}
            onChange={(e) => {
              setSourceId(e.target.value);
              setOffset(0);
            }}
          >
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="rea-field rea-field--narrow">
          <label className="rea-label" htmlFor={`${uid}-size`}>
            Rows per page
          </label>
          <select
            id={`${uid}-size`}
            value={limit}
            onChange={(e) => {
              setLimit(Number(e.target.value));
              setOffset(0);
            }}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>
      {state.loading ? <p className="rea-muted">Loading…</p> : null}
      {state.error ? (
        <Notice tone={state.notViewable ? "info" : "bad"} title={state.notViewable ? "No paged view for this result" : "Could not load this page"}>
          {state.error}
        </Notice>
      ) : null}
      {rows ? (
        <div className="rea-table-wrap">
          <table className="rea-table">
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${offset}-${i}`}>
                  {cols.map((c) => (
                    <td key={c}>{plain(r[c], 160)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : state.view != null ? (
        <pre className="rea-json">{boundedJson(state.view)}</pre>
      ) : null}
      {state.view != null ? (
        <div className="rea-actions">
          <button type="button" className="btn btn--sm" disabled={offset === 0 || state.loading} onClick={() => setOffset(Math.max(0, offset - limit))}>
            Previous
          </button>
          <span className="rea-faint" aria-live="polite">
            {rows ? `${offset + 1}–${offset + rows.length}` : ""}
            {total != null ? ` of ${total.toLocaleString()}` : ""}
          </span>
          <button type="button" className="btn btn--sm" disabled={!hasNext || state.loading} onClick={() => setOffset(offset + limit)}>
            Next
          </button>
        </div>
      ) : null}
    </div>
  );
}

function List({ title, items, tone }: { title: string; items: string[]; tone?: "warn" }) {
  if (!items.length) return null;
  return (
    <section>
      <h4 className="rea-subtitle">{title}</h4>
      <ul className={`rea-list${tone ? ` is-${tone}` : ""}`}>
        {items.map((s, i) => (
          <li key={`${i}-${s.slice(0, 20)}`}>{plain(s, 400)}</li>
        ))}
      </ul>
    </section>
  );
}

function Facts({ title, data }: { title: string; data: Record<string, unknown> }) {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!entries.length) return null;
  return (
    <section>
      <h4 className="rea-subtitle">{title}</h4>
      <dl className="rea-facts">
        {entries.map(([k, v]) => (
          <div key={k} className="rea-fact">
            <dt>{k}</dt>
            <dd>{plain(v, 300)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

interface ResultPanelProps {
  sparkId: string;
  state: ResultState;
  run: ReaRun | null;
  workflow: ReaWorkflowSpec | null;
  onClose: () => void;
}

/** A finished run's headline, identity, limitations, findings and (for viewable workflows) paged tables. */
export function ResultPanel({ sparkId, state, run, workflow, onClose }: ResultPanelProps) {
  const [exportError, setExportError] = useState<string | null>(null);
  const summary: ReaResultSummary | null = state.summary ?? run?.summary ?? null;
  const title = run ? runTitle(run) : "Result";
  const sources = workflow?.viewable && run ? viewSources(workflow.resultShape, summary?.tables) : [];
  const declared: Record<string, readonly string[]> = {};
  for (const t of summary?.tables ?? []) declared[t.id] = t.columns;

  const doExport = async () => {
    if (!run) return;
    setExportError(null);
    try {
      await downloadReaExport(sparkId, run.id);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Panel
      title={`Result: ${title}`}
      actions={
        <>
          {run && run.status === "completed" ? (
            <button type="button" className="btn btn--sm" onClick={() => void doExport()}>
              Export JSON
            </button>
          ) : null}
          <button type="button" className="btn btn--sm btn--ghost" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div className="rea-stack">
        {state.loading ? <p className="rea-muted">Loading the result…</p> : null}
        {state.error ? <Notice tone="bad" title="Could not read the result">{state.error}</Notice> : null}
        {exportError ? <Notice tone="bad" title="Export failed">{exportError}</Notice> : null}
        {summary?.truncated ? (
          <Notice tone="warn" title="The result was too large to keep in full">
            Only part of this result was cached, so the figures and tables below may be incomplete.
          </Notice>
        ) : null}
        {summary ? (
          <>
            <p className="rea-muted">
              <Tag>{summary.kind}</Tag>
              {run?.workflowLabel ? ` ${run.workflowLabel}` : ""}
            </p>
            <Facts title="Headline" data={summary.headline} />
            <Facts title="Identity" data={summary.identity} />
            {summary.findings.length ? (
              <section>
                <h4 className="rea-subtitle">Findings ({summary.findings.length})</h4>
                <ul className="rea-findings">
                  {summary.findings.map((f, i) => (
                    <li key={`${i}-${f.title.slice(0, 20)}`} className="rea-finding">
                      <span className="rea-finding__head">
                        {f.severity ? <Tag tone={/high|critical/i.test(f.severity) ? "bad" : /med/i.test(f.severity) ? "warn" : "info"}>{plain(f.severity, 30)}</Tag> : null}
                        <b>{plain(f.title, 200)}</b>
                      </span>
                      {f.detail ? <span className="rea-muted">{plain(f.detail, 600)}</span> : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <List title="Limitations" items={summary.limitations} tone="warn" />
            <List title="Unknowns" items={summary.unknowns} />
            {sources.length && run ? (
              <section>
                <h4 className="rea-subtitle">Tables</h4>
                <PagedView key={run.id} sparkId={sparkId} runId={run.id} sources={sources} declared={declared} />
              </section>
            ) : (
              <>
                <p className="rea-hint">This workflow has no paged view; the headline and facts above are the whole summary.</p>
                <details className="rea-more">
                  <summary>Raw summary</summary>
                  <pre className="rea-json">{boundedJson(summary)}</pre>
                </details>
              </>
            )}
          </>
        ) : !state.loading && !state.error ? (
          <p className="rea-muted">No result is stored for this run.</p>
        ) : null}
      </div>
    </Panel>
  );
}
