import { useTranslation } from "react-i18next";
import { typeLabel, type CategoryId, type Severity } from "./activityStats";

export function useActivityLabels() {
  const { t } = useTranslation("activity");
  const severityLabels: Record<Severity, string> = {
    error: t("severity.error"),
    warn: t("severity.warn"),
    success: t("severity.success"),
    info: t("severity.info"),
  };
  const categoryLabels: Record<CategoryId, string> = {
    status: t("category.status"),
    thermal: t("category.thermal"),
    health: t("category.health"),
    alerts: t("category.alerts"),
    hermes: t("category.hermes"),
    bench: t("category.bench"),
    power: t("category.power"),
    llm: t("category.llm"),
    fleet: t("category.fleet"),
    other: t("category.other"),
  };
  const known: Record<string, string> = {
    "spark.online": t("type.sparkOnline"),
    "spark.offline": t("type.sparkOffline"),
    "spark.added": t("type.sparkAdded"),
    "spark.removed": t("type.sparkRemoved"),
    "gpu.throttle.thermal": t("type.throttleThermal"),
    "gpu.throttle.cleared": t("type.throttleCleared"),
    "hermes.update.available": t("type.hermesAvailable"),
    "hermes.update.success": t("type.hermesUpdated"),
    "hermes.update.error": t("type.hermesFailed"),
    "health.xid": t("type.xid"),
    "health.oom": t("type.oom"),
    "health.thermal": t("type.runningHot"),
    "health.low-power": t("type.lowPower"),
    "health.memory": t("type.lowMemory"),
    "health.concurrency": t("type.concurrency"),
    "health.link-speed": t("type.linkSpeed"),
    "health.roce-link": t("type.roceLink"),
    "health.roce-loss": t("type.roceLoss"),
    "health.cleared": t("type.healthOk"),
    "alert.notify.sent": t("type.notifySent"),
    "alert.notify.failed": t("type.notifyFailed"),
    "power.shutdown": t("type.shutdown"),
    "power.wake": t("type.wake"),
    // Model Loader (server/models) — reported under the LLM models category.
    "model.job.recovered": t("type.modelRecovered"),
    "model.schedule.start": t("type.modelScheduleStart"),
    "model.schedule.stop": t("type.modelScheduleStop"),
    "model.schedule.blocked": t("type.modelScheduleBlocked"),
    "model.schedule.start.failed": t("type.modelScheduleStartFailed"),
    "model.schedule.stop.failed": t("type.modelScheduleStopFailed"),
  };
  const bench: Record<string, string> = {
    decode: t("type.benchDecode"),
    prefill: t("type.benchPrefill"),
    quality: t("type.benchQuality"),
  };
  const action: Record<string, string> = {
    start: t("type.llmStart"),
    stop: t("type.llmStop"),
    attach: t("type.llmAttach"),
  };
  const modelAction: Record<string, string> = {
    start: t("type.modelStart"),
    stop: t("type.modelStop"),
    restart: t("type.modelRestart"),
    logs: t("type.modelLogs"),
  };
  const stage: Record<string, string> = {
    requested: t("stage.requested"),
    completed: t("stage.completed"),
    finished: t("stage.finished"),
    cancelled: t("stage.cancelled"),
    failed: t("stage.failed"),
    detached: t("stage.detached"),
  };
  const eventType = (type: string): string => {
    if (known[type]) return known[type];
    const [kind, name, status, ...rest] = type.split(".");
    if (!rest.length && kind === "bench" && bench[name]) {
      if (status === "finished") return bench[name];
      if (status === "failed") return t("type.benchFailed", { name: bench[name] });
      if (status === "cancelled") return t("type.benchCancelled", { name: bench[name] });
    }
    if (!rest.length && kind === "llm" && action[name] && status) return t("type.llmAction", { action: action[name], stage: stage[status] ?? status });
    if (!rest.length && kind === "model" && modelAction[name] && status) return t("type.llmAction", { action: modelAction[name], stage: stage[status] ?? status });
    return type ? typeLabel(type) : t("type.event");
  };
  return { severityLabels, categoryLabels, eventType };
}
