import type { RamMetrics } from "../../api/types";
import { TrendLine } from "../ui/TrendLine";
import { Panel } from "../ui/Panel";
import { MemoryIcon } from "../ui/icons";
import { MetricBar } from "../ui/MetricBar";
import { useMetricsHistoryTail } from "../../hooks/metricsStore";
import { formatMb } from "../../shared/formatBytes";

interface RamPanelProps {
  ram: RamMetrics | null;
  sparkId: string;
  className?: string;
}

/**
 * System RAM panel — shown for non-Spark GPU hosts, where RAM (system memory)
 * and VRAM (discrete GPU memory) are separate things. CPU stats live in the
 * dedicated CPU panel.
 */
export function RamPanel({ ram, sparkId, className }: RamPanelProps) {
  const history = useMetricsHistoryTail(sparkId, "ram.percentage");
  const used = ram?.used ?? 0;
  const total = ram?.total ?? 0;
  const percentage = ram?.percentage ?? 0;
  const ramBarColor = percentage > 95 ? "bg-danger" : percentage > 75 ? "bg-warning" : "bg-bar-ram";

  return (
    <Panel
      title="RAM"
      icon={<MemoryIcon />}
      className={`panel-ram ${className ?? ""}`}
      bodyClassName="sp-stack"
    >
      {total > 0 ? (
        <>
          <MetricBar
            label="RAM"
            value={used}
            max={total}
            color={ramBarColor}
            caption={
              total > 0
                ? `${formatMb(used).replace(/ (GB|MB)$/, "")} / ${formatMb(total)}`
                : "—"
            }
          />
          {history.length > 0 && (
            <div className="sp-metric">
              <span className="eyebrow">Usage</span>
              <div className="big-num sp-big-md">
                {percentage}
                <small>%</small>
              </div>
              <TrendLine data={history} height={36} color="var(--color-info)" min={0} max={100} />
            </div>
          )}
        </>
      ) : (
        <div className="sp-row">
          <span className="text-muted">RAM</span>
          <span className="mono text-text">—</span>
        </div>
      )}
    </Panel>
  );
}
