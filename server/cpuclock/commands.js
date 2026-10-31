/**
 * On-unit programs for the CPU maximum-frequency cap.
 *
 * `cpupower -c all frequency-set -u <MHz>MHz` limits every core. The cap is
 * kept across reboots by the hook the unit can take — the same split as the GPU
 * cap: a oneshot systemd unit where sudo reaches a root shell, otherwise an
 * `@reboot` line in the SSH user's crontab through a narrow cpupower sudo rule.
 * NVML-style readback does not exist for cpupower either, so the applied value
 * is recorded in a marker (`/run/sparkdash/cpu-clock-cap` as root, else
 * `~/.config/sparkdash/cpu-clock-cap`); the live sysfs `scaling_max_freq` is
 * read alongside it so a cap applied by something else is not reported as ours.
 *
 * Every program is POSIX sh, takes only validated integers and fixed paths, and
 * reports `KEY=value` lines on stdout (`RESULT=ok|error`, `CODE`, `MSG`, …).
 */
export const CPU_SERVICE = "sparkdash-cpu-clock-limit";
export const CPU_UNIT_NAME = `${CPU_SERVICE}.service`;
export const CPU_MARKER_FILE = "cpu-clock-cap";
export const CPU_CRON_TAG = "sparkdash-cpu-clock-cap";
export const CPU_MIN_MHZ = 300;
export const CPU_MAX_MHZ = 10000;
export const CPU_DEFAULT_MHZ = 2808;

const SAFE_PATH = /^\/[A-Za-z0-9_./-]*$/;

const DEFAULT_PATHS = Object.freeze({
  unitDir: "/etc/systemd/system",
  runDir: "/run/sparkdash",
  bootIdFile: "/proc/sys/kernel/random/boot_id",
  systemdRunDir: "/run/systemd/system",
  /** cpu0's cpufreq directory; tests point this at a fixture. */
  cpufreqDir: "/sys/devices/system/cpu/cpu0/cpufreq",
  cpupower: ["/usr/bin/cpupower", "/usr/local/bin/cpupower", "/bin/cpupower"],
  flock: ["/usr/bin/flock", "/bin/flock"],
  systemctl: "systemctl",
  sandbox: false,
  /** Test sandbox only: a fake `sudo -n` standing in for the narrow rule. */
  sandboxSudo: "",
});

export function resolvePaths(overrides = {}) {
  const p = { ...DEFAULT_PATHS, ...overrides };
  const list = [
    p.unitDir,
    p.runDir,
    p.bootIdFile,
    p.systemdRunDir,
    p.cpufreqDir,
    ...p.cpupower,
    ...p.flock,
  ];
  if (p.systemctl !== "systemctl") list.push(p.systemctl);
  if (p.sandboxSudo) list.push(p.sandboxSudo);
  for (const v of list) {
    if (typeof v !== "string" || !SAFE_PATH.test(v) || v.includes("..")) {
      throw new Error("unsafe path in CPU clock program");
    }
  }
  return p;
}

/** Validate a CPU cap request. Throws an Error with `status` 400. */
export function parseCpuCapRequest(body) {
  const fail = (msg) => Object.assign(new Error(msg), { status: 400 });
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const maxMHz = b.maxMHz;
  if (!Number.isInteger(maxMHz) || maxMHz < CPU_MIN_MHZ || maxMHz > CPU_MAX_MHZ) {
    throw fail(`maxMHz must be a whole number from ${CPU_MIN_MHZ} to ${CPU_MAX_MHZ}`);
  }
  if (b.persist !== undefined && typeof b.persist !== "boolean") throw fail("persist must be true or false");
  return { maxMHz, persist: b.persist === true };
}

/** The oneshot unit that re-applies the cap at boot. `$$` is systemd's `$`. */
export function buildCpuUnit({ maxMHz, hwMaxMHz, cpupower = "/usr/bin/cpupower", runDir = DEFAULT_PATHS.runDir, bootIdFile = DEFAULT_PATHS.bootIdFile }) {
  for (const n of [maxMHz, hwMaxMHz]) if (!Number.isInteger(n) || n < 0) throw new Error("bad CPU clock value");
  const marker = `${runDir}/${CPU_MARKER_FILE}`;
  return [
    "[Unit]",
    `Description=Limit the CPU maximum frequency (${maxMHz} MHz), managed by sparkDash`,
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    `ExecStart=${cpupower} -c all frequency-set -u ${maxMHz}MHz`,
    `ExecStartPost=/bin/sh -c 'mkdir -p ${runDir} && echo ${maxMHz} $$(cat ${bootIdFile}) > ${marker}'`,
    `ExecStop=${cpupower} -c all frequency-set -u ${hwMaxMHz}MHz`,
    `ExecStopPost=/bin/rm -f ${marker}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/**
 * The @reboot line used where sudo only reaches cpupower. It re-applies the cap
 * through the narrow rule, refreshes the marker (a boot invalidates it), retries
 * three times, and leaves a failure marker plus a logger line when every attempt
 * fails. It checks its own tagged line before capping, so a superseded job
 * exits without touching the clocks. No `%` may appear in a crontab command.
 */
function cpuCronLine({ maxMHz }) {
  return `${[
    `@reboot J=@@JOB@@; C=@@CRON@@; D="@@ALT_DIR@@"; B=@@BOOTID@@; F=@@FLOCK@@; M="$D/${CPU_MARKER_FILE}";`,
    `take() { $F -w 120 9 || exit 4; L=$($C -l 2>&1);`,
    `case $?:"$L" in 0:*"@reboot J=$J; "*) ;; 0:*|*:*"no crontab for"*) exit 3 ;; *) exit 5 ;; esac; };`,
    `log() { logger -t sparkdash "CPU clock cap ${maxMHz} MHz was not applied at boot$1"; };`,
    `for i in 1 2 3; do /bin/sleep 20; /bin/mkdir -p "$D";`,
    `( take; @@SUDO@@ -n @@CPUPOWER@@ -c all frequency-set -u ${maxMHz}MHz || exit 1;`,
    `echo "${maxMHz} $(/bin/cat $B)" > "$M" && /bin/rm -f "$M.failed" ) 9>>"$M.lock";`,
    `case $? in 0|3) exit 0 ;; esac;`,
    "done;",
    `( take; /bin/cat $B > "$M.failed" || exit 6 ) 9>>"$M.lock"; r=$?;`,
    `case $r in 3) ;; 0|6) log ;; 5) log ": the crontab could not be read" ;;`,
    `*) log ": the change lock could not be taken" ;; esac;`,
    `# ${CPU_CRON_TAG}`,
  ].join(" ")}\n`;
}

function header(paths) {
  const cp = paths.cpupower.map((c) => `"${c}"`).join(" ");
  const fl = paths.flock.map((c) => `"${c}"`).join(" ");
  return [
    "set -u",
    'SUDO=""',
    paths.sandbox
      ? paths.sandboxSudo
        ? `SUDO="${paths.sandboxSudo}"`
        : ":"
      : `[ "$(id -u)" = 0 ] || SUDO="sudo -n"`,
    `SYSTEMCTL=${paths.systemctl}`,
    `OWNER="${paths.sandbox ? "" : "-o root -g root"}"`,
    `UNIT=${paths.unitDir}/${CPU_UNIT_NAME}`,
    `RUNDIR=${paths.runDir}`,
    `MARKER=${paths.runDir}/${CPU_MARKER_FILE}`,
    paths.sandbox ? `HOMEDIR=${paths.runDir}` : 'HOMEDIR="${HOME:-}"',
    paths.sandbox ? `ALT_DIR=${paths.runDir}` : 'ALT_DIR="$HOMEDIR/.config/sparkdash"',
    `ALT_MARKER="$ALT_DIR/${CPU_MARKER_FILE}"`,
    'ALT_FAIL="$ALT_DIR/cpu-clock-cap.failed"',
    `LOCKFILE="$ALT_DIR/${CPU_MARKER_FILE}.lock"`,
    `BOOTID_FILE=${paths.bootIdFile}`,
    `CPUFREQ=${paths.cpufreqDir}`,
    "CPUPOWER=''",
    `for c in ${cp}; do if [ -x "$c" ]; then CPUPOWER="$c"; break; fi; done`,
    "FLOCK=''",
    `for c in ${fl}; do if [ -x "$c" ]; then FLOCK="$c"; break; fi; done`,
    "fail() { printf 'RESULT=error\\nCODE=%s\\nMSG=%s\\n' \"$1\" \"$2\"; exit 0; }",
    'digits() { tr -dc 0-9; }',
    'clean() { printf "%s" "$1" | head -n 1 | tr -cd "A-Za-z0-9 .,:_()/-" | head -c 160; }',
    // cpuinfo_max_freq is kHz; the UI and cpupower speak MHz.
    'hwmax() { K=$(cat "$CPUFREQ/cpuinfo_max_freq" 2>/dev/null | digits); [ -n "$K" ] && echo $((K / 1000)); }',
    'curmax() { K=$(cat "$CPUFREQ/scaling_max_freq" 2>/dev/null | digits); [ -n "$K" ] && echo $((K / 1000)); }',
    'bootid() { tr -dc "0-9a-fA-F-" < "$BOOTID_FILE" 2>/dev/null | head -c 64; }',
    'marker_cap() {',
    '  for F in "$MARKER" "$ALT_MARKER"; do',
    '    [ -r "$F" ] || continue',
    '    read -r M B < "$F" || continue',
    '    M=$(printf "%s" "${M:-}" | digits)',
    '    B=$(printf "%s" "${B:-}" | tr -dc "0-9a-fA-F-")',
    '    if [ -n "$M" ] && [ "$B" = "$(bootid)" ]; then printf "%s" "$M"; return 0; fi',
    '  done',
    '  return 1',
    '}',
    'safe_path() { case "$1" in /*) ;; *) return 1 ;; esac; case "$1" in *[!A-Za-z0-9_./-]*|*..*) return 1 ;; esac; }',
    "take_lock() {",
    '  [ -n "$FLOCK" ] || fail lock-failed "flock (util-linux) was not found on this unit; nothing was changed"',
    '  [ -n "$HOMEDIR" ] || fail lock-failed "the home directory is not set, so the change lock cannot be taken; nothing was changed"',
    '  mkdir -p "$ALT_DIR" 2>/dev/null; [ -f "$LOCKFILE" ] || touch "$LOCKFILE" 2>/dev/null',
    '  [ -f "$LOCKFILE" ] && [ -w "$LOCKFILE" ] || fail lock-failed "could not open the change lock ($LOCKFILE); nothing was changed"',
    '  exec 9>>"$LOCKFILE"',
    '  "$FLOCK" -w 30 9; LRC=$?',
    '  [ "$LRC" = 0 ] && return 0',
    '  [ "$LRC" = 1 ] && fail busy "another CPU clock change is still running on this unit; try again in a moment"',
    '  fail lock-failed "could not take the change lock ($LOCKFILE); nothing was changed"',
    "}",
    // NOPASSWD: ALL works outright; otherwise the rule list must name cpupower.
    // The exact frequency command is still checked by sudo when the cap is applied.
    'need_sudo() { [ -z "$SUDO" ] && return 0; command -v sudo >/dev/null 2>&1 || return 1; $SUDO true >/dev/null 2>&1 || $SUDO -l 2>/dev/null | grep -q "$CPUPOWER"; }',
    'can_sudo_root() { [ -z "$SUDO" ] && return 0; $SUDO sh -c : >/dev/null 2>&1; }',
    'can_rm() { [ -e "$1" ] || [ -L "$1" ] || return 0; RD=${1%/*}; RD=${RD:-/}; [ -w "$RD" ] && [ -x "$RD" ]; }',
    'marker_preflight() {',
    '  for F in "$MARKER" "$ALT_MARKER" "$ALT_FAIL"; do',
    '    can_rm "$F" || can_sudo_root || fail marker-failed "the recorded cap ($F) cannot be removed by this user and sudo here cannot reach a root shell; nothing was changed. Remove it as root (sudo rm -f $F), then $1 again"',
    '  done',
    '}',
    `CRON_TAG="${CPU_CRON_TAG}"`,
    `CRON_RE='^@reboot .* # ${CPU_CRON_TAG}[[:space:]]*$'`,
    'CRONBIN=$(command -v crontab 2>/dev/null || true)',
    "CRON_TXT=''",
    'cron_load() {',
    "  CRON_TXT=''",
    '  [ -n "$CRONBIN" ] || return 0',
    '  CRON_TXT=$("$CRONBIN" -l 2>/dev/null) && return 0',
    "  CRON_TXT=''",
    '  case "$("$CRONBIN" -l 2>&1 >/dev/null)" in *"no crontab for"*) return 0 ;; esac',
    '  return 1',
    '}',
    `cron_text() { [ -z "$CRON_TXT" ] || printf '%s\\n' "$CRON_TXT"; }`,
    'cron_has() { cron_text | grep -q "$CRON_RE"; }',
    'cron_clocks() { cron_text | grep "$CRON_RE" | sed -n \'s/.*-u \\([0-9][0-9]*\\)MHz.*/\\1/p\' | head -n 1; }',
    'can_cron() {',
    '  [ -n "$CRONBIN" ] || return 1',
    '  for u in cron.service crond.service; do',
    `    [ "$($SYSTEMCTL is-active "$u" 2>/dev/null)" = active ] && return 0`,
    '  done',
    '  return 1',
    '}',
    "drop_cron() {",
    '  [ -n "$CRONBIN" ] || return 0',
    '  cron_load || return 1',
    '  cron_has || { rm -f "$ALT_FAIL" 2>/dev/null; return 0; }',
    '  T=$(mktemp) || return 1',
    '  cron_text | grep -v "$CRON_RE" > "$T"',
    '  if [ -s "$T" ]; then',
    '    "$CRONBIN" "$T" >/dev/null 2>&1 || { rm -f "$T"; return 1; }',
    '  else',
    '    "$CRONBIN" -r >/dev/null 2>&1 || { rm -f "$T"; return 1; }',
    '  fi',
    '  rm -f "$T"',
    '  cron_load || return 1',
    '  ! cron_has && { rm -f "$ALT_FAIL" 2>/dev/null; true; }',
    '}',
    "drop_service() {",
    '  if [ -f "$UNIT" ]; then',
    `    $SUDO $SYSTEMCTL disable --now ${CPU_UNIT_NAME} >/dev/null 2>&1 || true`,
    '    $SUDO rm -f "$UNIT" || return 1',
    "    $SUDO $SYSTEMCTL daemon-reload >/dev/null 2>&1 || true",
    "  fi",
    "}",
  ];
}

/** Read-only: hardware/current limits, the recorded cap, sudo and both hooks. */
export function buildCpuStatusProgram(overrides = {}) {
  const paths = resolvePaths(overrides);
  return [
    ...header(paths),
    '[ -n "$CPUPOWER" ] || fail no-cpupower "cpupower was not found on this unit"',
    'HW=$(hwmax)',
    '[ -n "$HW" ] || fail no-cpufreq "could not read the CPU frequency limits from $CPUFREQ"',
    'CUR=$(curmax)',
    'if [ "$(id -u)" = 0 ]; then S=root; elif need_sudo; then S=yes; else S=no; fi',
    `PK=none; if [ "$S" != no ]; then if can_sudo_root && [ -d ${paths.systemdRunDir} ]; then PK=unit; elif can_cron; then PK=cron; fi; fi`,
    "CI=0; CCLK=''; CF=0",
    'cron_load || fail cron-failed "could not read the crontab; boot-hook status is unknown"',
    'if cron_has; then CI=1; CCLK=$(cron_clocks); fi',
    'if [ "$CI" = 1 ] && [ -n "$(bootid)" ] && [ -r "$ALT_FAIL" ] && [ "$(tr -dc "0-9a-fA-F-" < "$ALT_FAIL" 2>/dev/null | head -c 64)" = "$(bootid)" ]; then CF=1; fi',
    // A marker is the record; without one, a live limit below the hardware
    // maximum is still a real cap (applied by hand or by an older build).
    "CAP=$(marker_cap) || CAP=''",
    'if [ -z "$CAP" ] && [ -n "$CUR" ] && [ "$CUR" -lt "$HW" ]; then CAP=$CUR; fi',
    "INST=0; CLK=''; EN=''; ACT=''",
    'if [ -f "$UNIT" ]; then',
    "  INST=1",
    '  CLK=$(sed -n \'s/^ExecStart=.* -u \\([0-9][0-9]*\\)MHz.*/\\1/p\' "$UNIT" | head -n 1 | tr -dc "0-9")',
    `  EN=$($SYSTEMCTL is-enabled ${CPU_UNIT_NAME} 2>/dev/null | head -n 1 | tr -dc "a-z-")`,
    `  ACT=$($SYSTEMCTL is-active ${CPU_UNIT_NAME} 2>/dev/null | head -n 1 | tr -dc "a-z-")`,
    "fi",
    "printf 'RESULT=ok\\nHWMAX=%s\\nCURMAX=%s\\nSUDO=%s\\nPERSIST_KIND=%s\\nCAP=%s\\nSVC_INSTALLED=%s\\nSVC_CLOCKS=%s\\nSVC_ENABLED=%s\\nSVC_ACTIVE=%s\\nCRON_INSTALLED=%s\\nCRON_CLOCKS=%s\\nCRON_FAILED=%s\\n' \"$HW\" \"$CUR\" \"$S\" \"$PK\" \"$CAP\" \"$INST\" \"$CLK\" \"$EN\" \"$ACT\" \"$CI\" \"$CCLK\" \"$CF\"",
    "exit 0",
    "",
  ].join("\n");
}

/** Cap the CPU now; with `persist`, also install the boot hook. */
export function buildCpuApplyProgram({ maxMHz, persist }, overrides = {}) {
  const paths = resolvePaths(overrides);
  const req = parseCpuCapRequest({ maxMHz, persist });
  const unit = buildCpuUnit({
    maxMHz: req.maxMHz,
    hwMaxMHz: 0,
    cpupower: "@@CPUPOWER@@",
    runDir: paths.runDir,
    bootIdFile: paths.bootIdFile,
  });
  // The unit's ExecStop needs the hardware maximum, which is only known on the
  // unit; @@HWMAX@@ is replaced there before the file is installed.
  const unitText = unit.replace(" -u 0MHz", " -u @@HWMAX@@MHz");
  const cron = cpuCronLine({ maxMHz: req.maxMHz });
  return [
    ...header(paths),
    '[ -n "$CPUPOWER" ] || fail no-cpupower "cpupower was not found on this unit"',
    'HW=$(hwmax)',
    '[ -n "$HW" ] || fail no-cpufreq "could not read the CPU frequency limits from $CPUFREQ"',
    `[ ${req.maxMHz} -le "$HW" ] || fail range "the cap is above this CPU's maximum frequency ($HW MHz)"`,
    'need_sudo || fail no-sudo "passwordless sudo is required for cpupower (a NOPASSWD rule for the exact frequency-set commands)"',
    "take_lock",
    `MAX=${req.maxMHz}; PERSIST=${req.persist ? 1 : 0}`,
    "HOOK=none",
    `if can_sudo_root && [ -d ${paths.systemdRunDir} ]; then HOOK=unit; elif can_cron; then HOOK=cron; fi`,
    'if [ "$PERSIST" = 1 ] && [ "$HOOK" = none ]; then fail no-sudo "keeping the cap after reboot needs NOPASSWD: ALL for the system service or a running cron service, and this unit offers neither"; fi',
    'cron_load || fail cron-failed "could not read the crontab; nothing was changed"',
    'if [ "$HOOK" = cron ] && [ -f "$UNIT" ]; then fail service-failed "a boot service this unit cannot remove without NOPASSWD: ALL is still installed; nothing was changed"; fi',
    'marker_preflight "set the cap"',
    'OUT=$($SUDO "$CPUPOWER" -c all frequency-set -u "${MAX}MHz" 2>&1) || fail cpupower-failed "cpupower refused the frequency cap: $(clean "$OUT")"',
    'write_marker() {',
    '  B=$(bootid); [ -n "$B" ] || return 1',
    '  if can_sudo_root; then',
    '    $SUDO sh -c \'mkdir -p "$1" && chmod 755 "$1" && echo "$2 $3" > "$4"\' sh "$RUNDIR" "$MAX" "$B" "$MARKER" || return 1',
    '    if [ "$MARKER" != "$ALT_MARKER" ]; then rm -f "$ALT_MARKER" 2>/dev/null || $SUDO rm -f "$ALT_MARKER" 2>/dev/null || return 1; fi',
    '    return 0',
    '  fi',
    '  [ -n "$HOMEDIR" ] || return 1',
    '  mkdir -p "$ALT_DIR" 2>/dev/null || return 1',
    '  printf "%s %s\\n" "$MAX" "$B" > "$ALT_MARKER" 2>/dev/null || return 1',
    '  [ "$MARKER" = "$ALT_MARKER" ] && return 0',
    '  rm -f "$MARKER" 2>/dev/null && return 0',
    '  return 1',
    '}',
    'write_marker || fail marker-failed "the cap is applied but could not be recorded"',
    'if [ "$PERSIST" = 0 ]; then',
    '  drop_cron || fail cron-failed "the cap is applied until the next reboot, but the existing @reboot job could not be removed"',
    '  if [ -f "$UNIT" ]; then',
    '    if ! drop_service; then',
    '      OUT=$($SUDO "$CPUPOWER" -c all frequency-set -u "${MAX}MHz" 2>&1) || fail cpupower-failed "the old boot service could not be removed, and restoring the live cap failed: $(clean "$OUT")"',
    '      write_marker >/dev/null 2>&1',
    '      fail service-failed "the cap is applied until the next reboot, but the existing boot service could not be removed"',
    '    fi',
    '    OUT=$($SUDO "$CPUPOWER" -c all frequency-set -u "${MAX}MHz" 2>&1) || fail cpupower-failed "cpupower refused the frequency cap: $(clean "$OUT")"',
    '    write_marker || fail marker-failed "the old service was removed; the live cap was restored but could not be recorded"',
    '  fi',
    "else",
    '  D=$(mktemp -d) || fail service-failed "could not create a temporary directory"',
    '  trap \'rm -rf "$D"\' EXIT',
    '  if [ "$HOOK" = unit ]; then',
    "  cat > \"$D/unit\" <<'SPARKDASH_CPU_UNIT_EOF'",
    unitText.replace(/\n$/, ""),
    "SPARKDASH_CPU_UNIT_EOF",
    '  sed "s#@@CPUPOWER@@#$CPUPOWER#g; s#@@HWMAX@@#$HW#g" "$D/unit" > "$D/unit.final" || fail service-failed "could not prepare the service file"',
    '  $SUDO install -m 644 $OWNER "$D/unit.final" "$UNIT" || fail service-failed "could not install the service file"',
    '  $SUDO $SYSTEMCTL daemon-reload || fail service-failed "systemctl daemon-reload failed; the cap applies until the next reboot"',
    `  $SUDO $SYSTEMCTL enable ${CPU_UNIT_NAME} >/dev/null 2>&1 || fail service-failed "could not enable the service; the cap applies until the next reboot"`,
    `  $SUDO $SYSTEMCTL restart ${CPU_UNIT_NAME} >/dev/null 2>&1 || fail service-failed "the service did not start; the cap applies until the next reboot"`,
    '  write_marker || fail marker-failed "the service is installed but the cap could not be recorded"',
    '  drop_cron || fail cron-failed "the boot service is installed, but the old @reboot job could not be removed"',
    "  else",
    '  SUDO_BIN=$(command -v sudo 2>/dev/null || true)',
    '  [ -n "$SUDO_BIN" ] || fail no-sudo "sudo was not found on this unit"',
    '  JOB=$(od -An -N8 -tx1 /dev/urandom 2>/dev/null | tr -dc 0-9a-f)',
    '  [ ${#JOB} = 16 ] || fail cron-failed "could not prepare the @reboot job; nothing was changed"',
    '  for P in "$SUDO_BIN" "$CPUPOWER" "$CRONBIN" "$ALT_DIR" "$ALT_MARKER" "$ALT_FAIL" "$BOOTID_FILE" "$FLOCK"; do',
    '    safe_path "$P" || fail cron-failed "a path the @reboot job needs has characters that cannot be put in a crontab safely; nothing was changed"',
    "  done",
    "  cat > \"$D/cron\" <<'SPARKDASH_CPU_CRON_EOF'",
    cron.replace(/\n$/, ""),
    "SPARKDASH_CPU_CRON_EOF",
    '  CRON_LINE=$(sed "s#@@JOB@@#$JOB#g; s#@@CRON@@#$CRONBIN#g; s#@@SUDO@@#$SUDO_BIN#g; s#@@CPUPOWER@@#$CPUPOWER#g; s#@@ALT_DIR@@#$ALT_DIR#g; s#@@BOOTID@@#$BOOTID_FILE#g; s#@@FLOCK@@#$FLOCK#g" "$D/cron") || fail cron-failed "could not prepare the @reboot job"',
    '  T=$(mktemp) || fail cron-failed "could not create a temporary file"',
    '  cron_text | grep -v "$CRON_RE" > "$T"',
    "  printf '%s\\n' \"$CRON_LINE\" >> \"$T\"",
    '  "$CRONBIN" "$T" >/dev/null 2>&1 || { rm -f "$T"; fail cron-failed "could not add the @reboot job; the cap applies until the next reboot"; }',
    '  rm -f "$T"',
    '  if ! cron_load || ! cron_has || [ "$(cron_clocks)" != "$MAX" ] || ! cron_text | grep -q "^@reboot J=$JOB; "; then',
    "    drop_cron",
    '    fail cron-failed "the @reboot job did not install; the cap applies until the next reboot"',
    "  fi",
    '  rm -f "$ALT_FAIL" 2>/dev/null',
    "  fi",
    "fi",
    'PK2=$HOOK',
    "printf 'RESULT=ok\\nCAP=%s\\nPERSIST=%s\\nPERSIST_KIND=%s\\n' \"$MAX\" \"$PERSIST\" \"$PK2\"",
    "exit 0",
    "",
  ].join("\n");
}

/** Remove the cap: drop both hooks, restore the hardware maximum, clear markers. */
export function buildCpuResetProgram(overrides = {}) {
  const paths = resolvePaths(overrides);
  return [
    ...header(paths),
    '[ -n "$CPUPOWER" ] || fail no-cpupower "cpupower was not found on this unit"',
    'HW=$(hwmax)',
    '[ -n "$HW" ] || fail no-cpufreq "could not read the CPU frequency limits from $CPUFREQ"',
    'need_sudo || fail no-sudo "passwordless sudo is required for cpupower (a NOPASSWD rule for the exact frequency-set commands)"',
    "take_lock",
    'marker_preflight "reset"',
    'drop_cron || fail cron-failed "could not remove the existing @reboot job"',
    'drop_service || fail service-failed "could not remove the existing service"',
    'OUT=$($SUDO "$CPUPOWER" -c all frequency-set -u "${HW}MHz" 2>&1) || fail cpupower-failed "cpupower could not restore the maximum frequency: $(clean "$OUT")"',
    'rm -f "$MARKER" "$ALT_MARKER" "$ALT_FAIL" 2>/dev/null || $SUDO rm -f "$MARKER" "$ALT_MARKER" "$ALT_FAIL" 2>/dev/null || fail marker-failed "could not clear the recorded cap"',
    "printf 'RESULT=ok\\n'",
    "exit 0",
    "",
  ].join("\n");
}

/** Parse a program's KEY=value stdout; unknown keys are dropped. */
export function parseCpuProgramOutput(out) {
  const KEYS = new Set([
    "RESULT", "CODE", "MSG", "HWMAX", "CURMAX", "SUDO", "PERSIST_KIND", "PERSIST", "CAP",
    "SVC_INSTALLED", "SVC_CLOCKS", "SVC_ENABLED", "SVC_ACTIVE",
    "CRON_INSTALLED", "CRON_CLOCKS", "CRON_FAILED",
  ]);
  const res = {};
  for (const line of String(out ?? "").split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m && KEYS.has(m[1])) res[m[1]] = m[2].slice(0, 300);
  }
  if (res.RESULT !== "ok" && res.RESULT !== "error") {
    return { RESULT: "error", CODE: "bad-output", MSG: "the unit returned an unexpected answer" };
  }
  return res;
}
