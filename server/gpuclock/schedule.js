/**
 * On-unit programs for the time-of-day GPU clock schedule.
 *
 * The schedule is enforced on each unit, not by the dashboard: a server tick
 * would leave the night cap unapplied whenever the container is stopped and
 * would apply yesterday's window after a reboot. One small tick script reads
 * the spec (`TZ=<zone>` plus `start end cap` minutes), computes the window that
 * covers "now" in that zone, and applies the cap only when the marker differs.
 *
 * Two hook families, chosen per unit exactly like the fixed cap:
 *  - systemd: `sparkdash-gpu-clock-schedule.service` + `.timer` (root, every
 *    5 minutes and 20 s after boot);
 *  - cron: `@reboot` and every-five-minutes lines in the SSH user's own crontab,
 *    through the same narrow `sudo -n nvidia-smi -lgc` rule the fixed cap uses.
 * Names are distinct from sparkLimiter's `spark-gpu-clock-limit.service`, so
 * installing one family can remove the other without guessing.
 *
 * The spec is removed before a tick re-reads it under the lock, so a removal
 * cannot be undone by a tick that started earlier. Programs always exit 0 and
 * report `KEY=value` lines, like the fixed-cap programs.
 */
import {
  MARKER_FILE,
  SCHEDULE_SCRIPT_FILE,
  SCHEDULE_SPEC_FILE,
  SCHEDULE_TAG,
  SCHEDULE_TIMER_NAME,
  SCHEDULE_UNIT_NAME,
  header,
  needSudoLine,
  resolvePaths,
  wrapManual,
} from "./commands.js";
import { formatGpuClockSpec, validateGpuClockSchedule } from "../../src/shared/gpuClockSchedule.js";

/**
 * The tick script. Paths are shell expressions (`$RUNDIR/...`, `$ALT_DIR/...`),
 * so one template serves both hook families; `@@NV@@`, `@@FLOCK@@`, `@@SUDO@@`,
 * `@@BOOTID@@` and `@@RUNDIR@@` are substituted at install time from values
 * resolved on the unit.
 */
function tickTemplate({ spec, marker, otherMarker, fail, lock }) {
  return [
    "#!/bin/sh",
    "# sparkDash GPU clock schedule: apply the cap for the window that covers now.",
    "# Installed by sparkDash; remove it from Settings -> GPU clock cap.",
    "set -u",
    'NV="@@NV@@"',
    'FLOCK="@@FLOCK@@"',
    'SUDO="@@SUDO@@"',
    'BOOTID_FILE="@@BOOTID@@"',
    'RUNDIR="@@RUNDIR@@"',
    // Resolved at install time: cron may run with a different HOME than the login shell.
    'ALT_DIR="@@ALT_DIR@@"',
    `SPEC="${spec}"`,
    `MARKER="${marker}"`,
    `OTHER_MARKER="${otherMarker}"`,
    `FAIL="${fail}"`,
    `LOCK="${lock}"`,
    'bootid() { tr -dc "0-9a-fA-F-" < "$BOOTID_FILE" 2>/dev/null | head -c 64; }',
    "fail() {",
    '  B=$(bootid); [ -n "$B" ] && printf "%s\\n" "$B" > "$FAIL" 2>/dev/null',
    '  logger -t sparkdash "GPU clock schedule: $1" 2>/dev/null || true',
    "  exit 1",
    "}",
    "cap_now() {",
    '  tz=$(sed -n "s/^TZ=//p" "$SPEC" 2>/dev/null | head -n 1 | tr -cd "A-Za-z0-9_+/-")',
    '  [ -n "$tz" ] || return 1',
    '  h=$(TZ="$tz" date +%H 2>/dev/null); m=$(TZ="$tz" date +%M 2>/dev/null)',
    '  [ -n "$h" ] && [ -n "$m" ] || return 1',
    // dash has no 10# base prefix; strip the zero padding before arithmetic.
    '  h=$(printf "%s" "$h" | sed "s/^0*//"); [ -n "$h" ] || h=0',
    '  m=$(printf "%s" "$m" | sed "s/^0*//"); [ -n "$m" ] || m=0',
    '  now=$((h * 60 + m))',
    "  awk -v now=\"$now\" '$1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ {",
    "    if ($1 == $2) { print $3; exit }",
    "    if ($1 < $2) { if (now >= $1 && now < $2) { print $3; exit } }",
    "    else { if (now >= $1 || now < $2) { print $3; exit } }",
    '  }\' "$SPEC"',
    "}",
    // No spec means the schedule was removed: touch nothing, report nothing.
    '[ -r "$SPEC" ] || exit 0',
    'cap=$(cap_now) || fail "could not read the schedule"',
    '[ -n "$cap" ] || fail "the schedule does not cover this time"',
    "B=$(bootid)",
    "cur=''",
    'for F in "$MARKER" "$OTHER_MARKER"; do',
    '  [ -r "$F" ] || continue',
    '  read -r cm cb < "$F" || continue',
    '  cm=$(printf "%s" "${cm:-}" | tr -dc 0-9)',
    '  cb=$(printf "%s" "${cb:-}" | tr -dc "0-9a-fA-F-")',
    '  [ -n "$cm" ] && [ "$cb" = "$B" ] && { cur=$cm; break; }',
    "done",
    '[ "$cur" = "$cap" ] && { rm -f "$FAIL" 2>/dev/null; exit 0; }',
    '[ -n "$FLOCK" ] || fail "flock (util-linux) was not found"',
    'mkdir -p "${LOCK%/*}" 2>/dev/null',
    '[ -f "$LOCK" ] || : >> "$LOCK" 2>/dev/null',
    '[ -w "$LOCK" ] || fail "the change lock ($LOCK) is not writable"',
    'exec 9>>"$LOCK"',
    '"$FLOCK" -w 30 9 || fail "another GPU clock change is running"',
    // Re-read under the lock: a removal deletes the spec before it resets clocks.
    '[ -r "$SPEC" ] || exit 0',
    'cap=$(cap_now) || fail "could not read the schedule"',
    '[ -n "$cap" ] || exit 0',
    'OUT=$($SUDO "$NV" -lgc "0,$cap" 2>&1) || fail "nvidia-smi refused $cap MHz: $(printf "%s" "$OUT" | head -n 1 | head -c 160)"',
    'mkdir -p "${MARKER%/*}" 2>/dev/null',
    'printf "%s %s\\n" "$cap" "$B" > "$MARKER" 2>/dev/null || fail "could not record the cap"',
    'if [ "$OTHER_MARKER" != "$MARKER" ]; then rm -f "$OTHER_MARKER" 2>/dev/null; fi',
    'rm -f "$FAIL" 2>/dev/null',
    "exit 0",
    "",
  ].join("\n");
}

function unitText(scriptPath) {
  return [
    "[Unit]",
    "Description=sparkDash GPU clock schedule",
    "After=nvidia-persistenced.service",
    "Wants=nvidia-persistenced.service",
    "",
    "[Service]",
    "Type=oneshot",
    // A oneshot that stays "active" would never be started again by the timer.
    "RemainAfterExit=no",
    `ExecStart=${scriptPath}`,
    "Nice=10",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

function timerText() {
  return [
    "[Unit]",
    "Description=Apply the sparkDash GPU clock schedule",
    "",
    "[Timer]",
    "OnBootSec=20s",
    // Every five minutes in the host's own clock; the script maps that instant to
    // the schedule's zone, so a host in another zone still switches on time.
    "OnCalendar=*:0/5",
    "AccuracySec=1s",
    "Persistent=true",
    `Unit=${SCHEDULE_UNIT_NAME}`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

function validated(config) {
  const check = validateGpuClockSchedule(config);
  if (!check.ok) {
    throw Object.assign(new Error(check.errors.join("; ")), { status: 400 });
  }
  return check.config;
}

/**
 * Install (or update) the schedule on one unit: spec, tick script, hook, then
 * one immediate run so the cap matches "now". The fixed cap's hooks are removed
 * only after the new hook has proved it works.
 */
export function buildScheduleInstallProgram(config, overrides = {}) {
  const paths = resolvePaths(overrides);
  const cfg = validated(config);
  const spec = formatGpuClockSpec(cfg).replace(/\n$/, "");
  const scriptPath = `${paths.schedScriptDir}/${SCHEDULE_SCRIPT_FILE}`;
  const caps = cfg.windows.map((w) => w.maxMHz);
  const rootTick = tickTemplate({
    spec: `$RUNDIR/${SCHEDULE_SPEC_FILE}`,
    marker: `$RUNDIR/${MARKER_FILE}`,
    otherMarker: `$ALT_DIR/${MARKER_FILE}`,
    fail: `$RUNDIR/${SCHEDULE_SPEC_FILE}.failed`,
    // A distinct lock from the fixed cap's: the install holds that one while it
    // starts the first tick as a child.
    lock: `$RUNDIR/${SCHEDULE_SPEC_FILE}.lock`,
  });
  const userTick = tickTemplate({
    spec: `$ALT_DIR/${SCHEDULE_SPEC_FILE}`,
    marker: `$ALT_DIR/${MARKER_FILE}`,
    otherMarker: `$RUNDIR/${MARKER_FILE}`,
    fail: `$ALT_DIR/${SCHEDULE_SPEC_FILE}.failed`,
    lock: `$ALT_DIR/${SCHEDULE_SPEC_FILE}.lock`,
  });
  return [
    ...header(paths),
    '[ -n "$NV" ] || fail no-nvidia "nvidia-smi was not found on this unit"',
    "HW=$(hwmax)",
    '[ -n "$HW" ] || fail no-gpu "could not read the GPU maximum clock"',
    ...caps.map(
      (m) =>
        `[ ${m} -le "$HW" ] || fail range "the schedule asks for ${m} MHz, above this GPU's maximum clock ($HW MHz)"`,
    ),
    needSudoLine(paths),
    "take_lock",
    // Same choice as "Keep after reboot": root + systemd, else the user's cron.
    "HOOK=none",
    `if can_sudo_root && [ -d ${paths.systemdRunDir} ]; then HOOK=unit; elif can_cron; then HOOK=cron; fi`,
    'if [ "$HOOK" = none ] && can_sudo_root; then fail no-systemd "the time schedule needs systemd or a running cron service, and this unit has neither"; fi',
    'if [ "$HOOK" = none ]; then fail no-sudo "the time schedule needs passwordless sudo for the system service (NOPASSWD: ALL) or a running cron service for an @reboot job, and this unit offers neither"; fi',
    'cron_load || fail cron-failed "could not read the crontab; nothing was changed"',
    // A fixed-cap boot service would re-apply its own cap at boot; without root it
    // cannot be removed, so refuse before installing the schedule.
    'if [ -f "$UNIT" ] && ! can_sudo_root; then fail service-failed "a fixed-cap boot service is installed and cannot be removed without NOPASSWD: ALL; nothing was changed"; fi',
    'marker_preflight "install the schedule"',
    'D=$(mktemp -d) || fail service-failed "could not create a temporary directory"',
    'trap \'rm -rf "$D"\' EXIT',
    "cat > \"$D/spec\" <<'SPARKDASH_SPEC_EOF'",
    spec,
    "SPARKDASH_SPEC_EOF",
    'if [ "$HOOK" = unit ]; then',
    '  cat > "$D/tick" <<\'SPARKDASH_TICK_EOF\'',
    rootTick.replace(/\n$/, ""),
    "SPARKDASH_TICK_EOF",
    '  sed "s#@@NV@@#$NV#g; s#@@FLOCK@@#$FLOCK#g; s#@@SUDO@@##g; s#@@BOOTID@@#$BOOTID_FILE#g; s#@@RUNDIR@@#$RUNDIR#g; s#@@ALT_DIR@@#$ALT_DIR#g" "$D/tick" > "$D/tick.final" || fail service-failed "could not prepare the schedule script"',
    `  $SUDO install -d -m 755 $OWNER ${paths.schedScriptDir} || fail service-failed "could not create the schedule script directory"`,
    '  $SUDO install -m 755 $OWNER "$D/tick.final" "$SCHED_SCRIPT" || fail service-failed "could not install the schedule script"',
    '  $SUDO install -m 644 $OWNER "$D/spec" "$SCHED_SPEC" || fail service-failed "could not install the schedule spec"',
    "  cat > \"$D/unit\" <<'SPARKDASH_SCHED_UNIT_EOF'",
    unitText(scriptPath).replace(/\n$/, ""),
    "SPARKDASH_SCHED_UNIT_EOF",
    "  cat > \"$D/timer\" <<'SPARKDASH_SCHED_TIMER_EOF'",
    timerText().replace(/\n$/, ""),
    "SPARKDASH_SCHED_TIMER_EOF",
    '  $SUDO install -m 644 $OWNER "$D/unit" "$SCHED_UNIT" || fail service-failed "could not install the schedule service"',
    '  $SUDO install -m 644 $OWNER "$D/timer" "$SCHED_TIMER" || fail service-failed "could not install the schedule timer"',
    "  rollback_sched() {",
    `    $SUDO $SYSTEMCTL disable --now ${SCHEDULE_TIMER_NAME} >/dev/null 2>&1`,
    `    $SUDO $SYSTEMCTL disable --now ${SCHEDULE_UNIT_NAME} >/dev/null 2>&1`,
    '    $SUDO rm -f "$SCHED_UNIT" "$SCHED_TIMER" "$SCHED_SCRIPT" "$SCHED_SPEC" >/dev/null 2>&1',
    "    $SUDO $SYSTEMCTL daemon-reload >/dev/null 2>&1",
    "  }",
    '  $SUDO $SYSTEMCTL daemon-reload || { rollback_sched; fail service-failed "systemctl daemon-reload failed; the schedule is not installed"; }',
    `  $SUDO $SYSTEMCTL enable --now ${SCHEDULE_TIMER_NAME} >/dev/null 2>&1 || { rollback_sched; fail service-failed "the schedule timer did not start; the schedule is not installed"; }`,
    `  $SUDO $SYSTEMCTL start ${SCHEDULE_UNIT_NAME} >/dev/null 2>&1 || { rollback_sched; fail service-failed "the schedule did not apply the first window; the schedule is not installed"; }`,
    // A user marker from an earlier cron install would be read first by the status.
    // In the sandbox both paths can coincide; never delete the marker just written.
    '  if [ "$ALT_MARKER" != "$MARKER" ]; then rm -f "$ALT_MARKER" 2>/dev/null || $SUDO rm -f "$ALT_MARKER" 2>/dev/null || true; fi',
    // Same path as the root spec in the sandbox; only drop a genuinely other copy.
    '  if [ "$ALT_SCHED_SPEC" != "$SCHED_SPEC" ]; then rm -f "$ALT_SCHED_SPEC" "$ALT_SCHED_SCRIPT" 2>/dev/null || true; fi',
    '  CAP=$(marker_cap) || { rollback_sched; fail service-failed "the schedule is installed but did not record a cap"; }',
    '  if [ -r "$SCHED_FAIL" ] && [ "$(tr -dc "0-9a-fA-F-" < "$SCHED_FAIL" 2>/dev/null | head -c 64)" = "$(bootid)" ]; then',
    '    rollback_sched',
    '    fail service-failed "the schedule is installed but could not apply the cap; see journalctl -u sparkdash-gpu-clock-schedule"',
    "  fi",
    "else",
    '  SUDO_BIN=$(command -v sudo 2>/dev/null || true)',
    '  [ -n "$SUDO_BIN" ] || fail no-sudo "sudo was not found on this unit"',
    '  for P in "$SUDO_BIN" "$NV" "$CRONBIN" "$ALT_DIR" "$ALT_SCHED_SCRIPT" "$ALT_SCHED_SPEC" "$BOOTID_FILE" "$FLOCK"; do',
    '    safe_path "$P" || fail cron-failed "a path the schedule job needs (sudo, nvidia-smi, crontab or the home directory) has characters that cannot be put in a crontab safely; nothing was changed"',
    "  done",
    // The status reads the root spec first; one left by an earlier root install
    // would describe the wrong schedule. With only the narrow rule it cannot go.
    '  if [ -e "$SCHED_SPEC" ] && ! can_sudo_root; then fail marker-failed "a root-owned schedule spec is left from an earlier install and cannot be removed; remove $SCHED_SPEC as root and retry"; fi',
    '  $SUDO rm -f "$SCHED_SPEC" "$SCHED_SCRIPT" 2>/dev/null || true',
    '  mkdir -p "$ALT_DIR" 2>/dev/null || fail cron-failed "could not create $ALT_DIR"',
    '  cat > "$D/tick" <<\'SPARKDASH_TICK_EOF\'',
    userTick.replace(/\n$/, ""),
    "SPARKDASH_TICK_EOF",
    '  sed "s#@@NV@@#$NV#g; s#@@FLOCK@@#$FLOCK#g; s#@@SUDO@@#$SUDO_BIN#g; s#@@BOOTID@@#$BOOTID_FILE#g; s#@@RUNDIR@@#$RUNDIR#g; s#@@ALT_DIR@@#$ALT_DIR#g" "$D/tick" > "$D/tick.final" || fail cron-failed "could not prepare the schedule script"',
    '  cp "$D/tick.final" "$ALT_SCHED_SCRIPT" || fail cron-failed "could not install the schedule script"',
    '  chmod 700 "$ALT_SCHED_SCRIPT" || fail cron-failed "could not secure the schedule script"',
    '  cp "$D/spec" "$ALT_SCHED_SPEC" || fail cron-failed "could not install the schedule spec"',
    '  chmod 644 "$ALT_SCHED_SPEC" 2>/dev/null || true',
    '  drop_sched_unit || fail service-failed "the time schedule service could not be removed and would re-apply its own window at boot"',
    '  drop_sched_cron || fail cron-failed "could not remove the previous schedule job"',
    '  T=$(mktemp) || fail cron-failed "could not create a temporary file"',
    '  cron_text > "$T"',
    `  printf '%s\\n' "@reboot /bin/sh $ALT_SCHED_SCRIPT # ${SCHEDULE_TAG}" >> "$T"`,
    `  printf '%s\\n' "*/5 * * * * /bin/sh $ALT_SCHED_SCRIPT # ${SCHEDULE_TAG}" >> "$T"`,
    '  "$CRONBIN" "$T" >/dev/null 2>&1 || { rm -f "$T"; fail cron-failed "could not add the schedule job; nothing was changed"; }',
    '  rm -f "$T"',
    '  if ! cron_load || ! sched_cron_has; then',
    "    drop_sched_cron",
    '    fail cron-failed "the schedule job did not install; nothing was changed"',
    "  fi",
    // A root marker from an earlier install would be read first by the status.
    '  if [ "$MARKER" != "$ALT_MARKER" ]; then rm -f "$MARKER" 2>/dev/null || $SUDO rm -f "$MARKER" 2>/dev/null || true; fi',
    '  if ! /bin/sh "$ALT_SCHED_SCRIPT"; then',
    "    drop_sched_cron",
    '    rm -f "$ALT_SCHED_SCRIPT" "$ALT_SCHED_SPEC" 2>/dev/null',
    '    fail cron-failed "the schedule is installed but could not apply the cap"',
    "  fi",
    '  CAP=$(marker_cap) || fail cron-failed "the schedule is installed but did not record a cap"',
    "fi",
    // The schedule supersedes a fixed cap: drop its hooks only now that the new
    // hook has applied a cap.
    'drop_service || fail service-failed "the schedule is installed, but the old boot service could not be removed and would re-apply its own cap at boot"',
    'drop_fixed_cron || fail cron-failed "the schedule is installed, but the old @reboot job could not be removed and would re-apply its own cap at boot"',
    'PK2=$HOOK',
    paths.manual
      ? "printf 'Done: GPU clock schedule installed (%s).\\n' \"$PK2\""
      : "printf 'RESULT=ok\\nCAP=%s\\nSCHED_KIND=%s\\n' \"$CAP\" \"$PK2\"",
    "exit 0",
    "",
  ].join("\n");
}

/** Remove the schedule and reset the clocks (the same outcome as "Remove limit"). */
export function buildScheduleRemoveProgram(overrides = {}) {
  const paths = resolvePaths(overrides);
  return [
    ...header(paths),
    '[ -n "$NV" ] || fail no-nvidia "nvidia-smi was not found on this unit"',
    needSudoLine(paths),
    "take_lock",
    'marker_preflight "remove the schedule"',
    // Delete the spec first: a tick that has not re-read it under the lock exits
    // without touching the clocks, so a removal cannot be undone by an old tick.
    'rm -f "$SCHED_SPEC" "$ALT_SCHED_SPEC" "$ALT_SCHED_SCRIPT" 2>/dev/null',
    '$SUDO rm -f "$SCHED_SPEC" "$ALT_SCHED_SPEC" "$ALT_SCHED_SCRIPT" 2>/dev/null',
    'drop_sched_cron || fail cron-failed "could not remove the time schedule job"',
    'drop_sched_unit || fail service-failed "could not remove the time schedule service"',
    // The tick holds the schedule lock (root's for the timer, the user's for
    // cron); take the same one for the reset so a tick cannot re-cap after it.
    'if [ -n "$FLOCK" ] && can_sudo_root; then',
    `  $SUDO "$FLOCK" -w 30 "$RUNDIR/${SCHEDULE_SPEC_FILE}.lock" "$NV" -rgc >/dev/null 2>&1 || fail rgc-failed "nvidia-smi could not reset the clocks"`,
    'elif [ -n "$FLOCK" ]; then',
    '  mkdir -p "$ALT_DIR" 2>/dev/null',
    `  [ -f "$ALT_DIR/${SCHEDULE_SPEC_FILE}.lock" ] || : >> "$ALT_DIR/${SCHEDULE_SPEC_FILE}.lock" 2>/dev/null`,
    `  exec 8>>"$ALT_DIR/${SCHEDULE_SPEC_FILE}.lock"`,
    '  "$FLOCK" -w 30 8 || fail rgc-failed "the schedule lock could not be taken"',
    '  "$NV" -rgc >/dev/null 2>&1 || fail rgc-failed "nvidia-smi could not reset the clocks"',
    "else",
    '  "$NV" -rgc >/dev/null 2>&1 || fail rgc-failed "nvidia-smi could not reset the clocks"',
    "fi",
    'rm -f "$MARKER" "$ALT_MARKER" "$SCHED_FAIL" "$ALT_SCHED_FAIL" 2>/dev/null || $SUDO rm -f "$MARKER" "$ALT_MARKER" "$SCHED_FAIL" "$ALT_SCHED_FAIL" 2>/dev/null || fail marker-failed "could not clear the recorded cap"',
    paths.manual ? "printf 'Done: GPU clock schedule removed and clocks reset.\\n'" : "printf 'RESULT=ok\\n'",
    "exit 0",
    "",
  ].join("\n");
}

/**
 * Paste-into-a-terminal command for a unit where the dashboard has no sudo.
 * `action` is "schedule" or "unschedule"; `config` is the schedule to install.
 */
export function buildManualScheduleCommand(action, config, overrides = {}) {
  const manual = { ...overrides, manual: true };
  if (action === "schedule") {
    const cfg = validated(config);
    const what = `install the GPU clock schedule (${cfg.windows
      .map((w) => `${w.start}–${w.end} ${w.maxMHz} MHz`)
      .join(", ")})`;
    return wrapManual(buildScheduleInstallProgram(cfg, manual), what);
  }
  if (action === "unschedule") {
    return wrapManual(buildScheduleRemoveProgram(manual), "remove the GPU clock schedule and reset the clocks");
  }
  throw Object.assign(new Error("action must be schedule or unschedule"), { status: 400 });
}
