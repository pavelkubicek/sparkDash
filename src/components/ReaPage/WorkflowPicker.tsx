import { useId, useState } from "react";
import type { ReaSetup, ReaSpec, ReaStatus, ReaWorkflowSpec } from "../../api/types";
import { SearchIcon } from "../ui/icons";
import { Panel } from "../ui/Panel";
import { Tag } from "../ui/Tag";
import { EXEC_LABEL, execTone, groupWorkflows, targetKindHint, workflowAvailability } from "./reaLogic";

interface WorkflowPickerProps {
  spec: ReaSpec | null;
  specError: string | null;
  status: ReaStatus | null;
  setup?: ReaSetup | null;
  selectedId: string | null;
  onSelect: (w: ReaWorkflowSpec) => void;
}

/** The catalog, grouped and searchable. Rows the unit cannot run say what is missing and cannot be picked. */
export function WorkflowPicker({ spec, specError, status, setup, selectedId, onSelect }: WorkflowPickerProps) {
  const uid = useId();
  const [query, setQuery] = useState("");
  const groups = spec ? groupWorkflows(spec, query) : [];
  return (
    <Panel title="Workflow">
      <div className="rea-stack">
        <div className="rea-search">
          <SearchIcon className="rea-search__icon" />
          <label className="sr-only" htmlFor={`${uid}-q`}>
            Search workflows
          </label>
          <input
            id={`${uid}-q`}
            type="search"
            value={query}
            placeholder="Search workflows (e.g. apk, firmware, decompile)"
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {specError ? <p className="rea-muted" role="alert">{specError}</p> : null}
        {!spec && !specError ? <p className="rea-muted">Loading the workflow catalog…</p> : null}
        {spec && groups.length === 0 ? <p className="rea-muted">No workflow matches “{query}”.</p> : null}
        <div className="rea-groups">
          {groups.map((g) => (
            <section key={g.id} className="rea-group" aria-label={g.label}>
              <h4 className="rea-subtitle">{g.label}</h4>
              {g.help ? <p className="rea-hint">{g.help}</p> : null}
              <ul className="rea-workflows">
                {g.workflows.map((w) => {
                  const av = workflowAvailability(w, status, setup);
                  const on = selectedId === w.id;
                  return (
                    <li key={w.id}>
                      <button
                        type="button"
                        className={`rea-wf${on ? " is-on" : ""}${av.ok ? "" : " is-off"}`}
                        aria-pressed={on}
                        disabled={!av.ok}
                        onClick={() => onSelect(w)}
                      >
                        <span className="rea-wf__head">
                          <b>{w.label}</b>
                          <Tag tone={execTone(w.execClass)} title={w.execClass}>
                            {EXEC_LABEL[w.execClass]}
                          </Tag>
                          {w.effects.mutatesDevice ? <Tag tone="bad">changes device</Tag> : null}
                          {w.targets === 2 ? <Tag>2 targets</Tag> : w.targets === 0 ? <Tag>no target</Tag> : null}
                        </span>
                        <span className="rea-wf__blurb">{w.blurb}</span>
                        <small className="rea-faint">{av.reason ? `Unavailable: ${av.reason}` : targetKindHint(w)}</small>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </Panel>
  );
}
