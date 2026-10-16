import { useMemo, useState } from "react";
import type { VulnHuntReportBundle, VulnHuntRun, VulnHuntSeverity } from "../../api/types";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import { ShieldIcon } from "../ui/icons";
import type { ReportState } from "./hooks";
import { CopyButton, Notice, fmtWhen } from "./parts";
import { SEVERITY_ORDER, countFindings, runTitle, severityLabel, severityTone, sortFindings } from "./securityLogic";

const COUNT_TONE: Record<VulnHuntSeverity | "unrated", string> = {
  "High+": "sec-count--bad",
  High: "sec-count--bad",
  Medium: "sec-count--warn",
  Low: "sec-count--info",
  Informational: "",
  unrated: "",
};

/** Text, or an en dash. The values are agent-written strings; React renders them as text only. */
const val = (v: string | number | null | undefined) => (v == null || v === "" ? "–" : String(v));

interface ReportViewProps {
  report: VulnHuntReportBundle;
  run?: VulnHuntRun | null;
}

/**
 * One scan's parsed report. Everything in it comes from the scanning agent and is untrusted: every
 * string is rendered as a React text node and the markdown stays plain preformatted text. There is no
 * HTML or markdown rendering anywhere in this component.
 */
export function ReportView({ report, run = null }: ReportViewProps) {
  const [dir, setDir] = useState<"desc" | "asc">("desc");
  const findings = useMemo(() => sortFindings(report.findings, dir), [report.findings, dir]);
  const counts = useMemo(() => countFindings(report.findings), [report.findings]);
  const h = report.header;
  const m = report.manifest;

  const facts: Array<[string, string]> = [
    ["Repository", val(h.repository)],
    ["Branch", val(h.branch)],
    ["Audit date", val(h.auditDate)],
    ["Model", val(h.model)],
    ["Run id", val(h.runId)],
    ["Scan id", val(m?.scanId)],
    ["Agent exit code", val(m?.agentExitCode)],
    ["Agent cost", m?.costUsd != null ? `$${m.costUsd.toFixed(2)}` : "–"],
  ];
  if (run) facts.push(["Started", fmtWhen(run.startedAt)]);
  facts.push(["Results folder on the unit", val(report.dir)]);

  const cols: Array<[VulnHuntSeverity | "unrated", number]> = [
    ...SEVERITY_ORDER.map((s) => [s, counts[s]] as [VulnHuntSeverity, number]),
    ["unrated", counts.unrated],
  ];

  return (
    <div className="sec-stack sec-report">
      <dl className="sec-facts">
        {facts.map(([k, v]) => (
          <div key={k} className="sec-facts__item">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {h.findingsSummary ? <p className="sec-summary">{h.findingsSummary}</p> : null}

      <div className="sec-counts" role="group" aria-label="Findings by severity">
        {cols.map(([s, n]) => (
          <div key={s} className={`sec-count ${COUNT_TONE[s]}${n === 0 ? " is-zero" : ""}`}>
            <span className="sec-count__n">{n}</span>
            <span className="sec-count__label">{s === "unrated" ? "Unrated" : s}</span>
          </div>
        ))}
      </div>

      {findings.length === 0 ? (
        <p className="sec-muted">The report lists no confirmed findings.</p>
      ) : (
        <div className="sec-table-wrap">
          <table className="sec-table">
            <caption className="sr-only">Findings</caption>
            <thead>
              <tr>
                <th scope="col" aria-sort={dir === "desc" ? "descending" : "ascending"}>
                  <button type="button" className="sec-sort" onClick={() => setDir((d) => (d === "desc" ? "asc" : "desc"))}>
                    Severity <span aria-hidden>{dir === "desc" ? "↓" : "↑"}</span>
                    <span className="sr-only">{dir === "desc" ? ", most serious first. Activate to reverse." : ", least serious first. Activate to reverse."}</span>
                  </button>
                </th>
                <th scope="col">Id</th>
                <th scope="col">Finding</th>
                <th scope="col">CWE</th>
                <th scope="col">Runtime</th>
                <th scope="col">Exploit test</th>
                <th scope="col">Measured impact</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {findings.map((f, i) => (
                <tr key={`${f.id}-${i}`}>
                  <td>
                    <Tag tone={severityTone(f.severity)}>{severityLabel(f.severity)}</Tag>
                  </td>
                  <td className="sec-mono">{val(f.id)}</td>
                  <td className="sec-table__title">{val(f.title)}</td>
                  <td className="sec-mono">{val(f.cwe)}</td>
                  <td>{val(f.runtime)}</td>
                  <td>{val(f.exploitTest)}</td>
                  <td>{val(f.measuredImpact)}</td>
                  <td>{val(f.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {report.artifacts.length > 0 ? (
        <div>
          <div className="eyebrow sec-eyebrow">Artifacts on the unit ({report.artifacts.length})</div>
          <ul className="sec-artifacts">
            {report.artifacts.map((a) => (
              <li key={a} className="sec-mono">
                {a}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <details className="sec-raw">
        <summary>
          <span>Raw report (plain text)</span>
          <span className="sec-faint">written by the scanning agent</span>
        </summary>
        <div className="sec-raw__body">
          <div className="sec-raw__bar">
            <CopyButton text={report.report} label="Copy report" />
          </div>
          <pre className="sec-raw__text">{report.report || "The report file is empty."}</pre>
        </div>
      </details>
    </div>
  );
}

/** Loads and frames one scan's report: title, loading and error states. */
export function ReportPanel({ state, run, onClose }: { state: ReportState; run: VulnHuntRun | null; onClose: () => void }) {
  const title = run ? `Report: ${runTitle(run)}` : "Report";
  return (
    <Panel
      title={title}
      icon={<ShieldIcon className="h-4 w-4" />}
      actions={
        <button type="button" className="btn btn--sm btn--ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      {state.loading ? (
        <p className="sec-muted">Loading the report…</p>
      ) : state.error ? (
        <Notice tone="warn" title="No report to show">
          {state.error}
        </Notice>
      ) : state.report ? (
        <ReportView report={state.report} run={state.run ?? run} />
      ) : null}
    </Panel>
  );
}
