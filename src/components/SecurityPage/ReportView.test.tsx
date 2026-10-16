import { act } from "react";
import { describe, expect, it } from "vitest";
import type { VulnHuntReportBundle } from "../../api/types";
import { render } from "../../testing/render";
import { ReportView } from "./ReportView";

const XSS = "<img src=x onerror=alert(1)>";

function bundle(over: Partial<VulnHuntReportBundle> = {}): VulnHuntReportBundle {
  return {
    dir: "/home/u/.cache/sparkdash/vulnhunt/abc/results",
    report: `# Audit\n\n${XSS}\n\n<script>alert(2)</script>\n`,
    findings: [
      { id: "F-1", title: "Verbose logging", cwe: "CWE-532", severity: "Low", runtime: null, exploitTest: null, measuredImpact: null, status: "confirmed" },
      { id: "F-2", title: `SQL injection ${XSS}`, cwe: "CWE-89", severity: "High+", runtime: "node 22", exploitTest: "pass", measuredImpact: "full read", status: "confirmed" },
      { id: "F-3", title: "Weak hash", cwe: "CWE-328", severity: "Medium", runtime: null, exploitTest: null, measuredImpact: null, status: null },
      { id: "F-4", title: "Odd one", cwe: null, severity: null, runtime: null, exploitTest: null, measuredImpact: null, status: null },
    ],
    artifacts: ["exploits/f2.js", "evidence/trace.txt"],
    header: {
      runId: "run-1",
      repository: "github.com/org/repo",
      auditDate: "2026-10-01",
      branch: "main",
      model: "some-model",
      findingsSummary: "4 findings",
    },
    manifest: { scanId: "scan-9", agentExitCode: 0, costUsd: 1.5 },
    ...over,
  };
}

describe("ReportView", () => {
  it("shows header facts, severity counters, findings (most serious first) and artifacts", () => {
    const { container } = render(<ReportView report={bundle()} />);
    const text = container.textContent ?? "";
    expect(text).toContain("github.com/org/repo");
    expect(text).toContain("2026-10-01");
    expect(text).toContain("$1.50");
    expect(text).toContain("exploits/f2.js");

    const rows = Array.from(container.querySelectorAll("tbody tr"));
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.querySelector("td:nth-child(2)")?.textContent)).toEqual(["F-2", "F-3", "F-1", "F-4"]);

    const counters = Array.from(container.querySelectorAll(".sec-count")).map((c) => c.textContent);
    expect(counters).toEqual(["1High+", "0High", "1Medium", "1Low", "0Informational", "1Unrated"]);
  });

  it("reverses the order from the Severity header", () => {
    const { container } = render(<ReportView report={bundle()} />);
    act(() => container.querySelector<HTMLButtonElement>(".sec-sort")!.click());
    const ids = Array.from(container.querySelectorAll("tbody tr")).map((r) => r.querySelector("td:nth-child(2)")?.textContent);
    expect(ids).toEqual(["F-4", "F-1", "F-3", "F-2"]);
  });

  it("renders report and finding text as literal text, never as HTML", () => {
    const { container } = render(<ReportView report={bundle()} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();

    const raw = container.querySelector(".sec-raw__text")!;
    expect(raw.tagName).toBe("PRE");
    expect(raw.textContent).toContain(XSS);
    expect(raw.textContent).toContain("<script>alert(2)</script>");
    expect(raw.children).toHaveLength(0);
    // The same string inside a finding title is text as well.
    expect(container.querySelector(".sec-table__title")?.textContent).toContain(XSS);
  });

  it("keeps the raw markdown inside a collapsible", () => {
    const { container } = render(<ReportView report={bundle()} />);
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("pre")).not.toBeNull();
  });

  it("handles a report with no findings", () => {
    const { container } = render(<ReportView report={bundle({ findings: [], artifacts: [], manifest: null, report: "" })} />);
    expect(container.textContent).toContain("no confirmed findings");
    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector(".sec-raw__text")?.textContent).toContain("empty");
  });
});
