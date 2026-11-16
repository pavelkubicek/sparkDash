# The sudo-free check: what apt would upgrade, what a full-upgrade simulation would do
# (including removals), what fwupd offers, and whether a reboot is pending. Appended verbatim
# after the refresh and install bodies, so those answer with the fresh state too.
# Every collector answers for itself (SIM_ERR / FW_ERR) and the program always exits 0:
# a failed part keeps its previous value on the dashboard, never a healthy guess.
export LC_ALL=C
command -v apt-get >/dev/null 2>&1 || fail apt-missing "apt is not available on this Spark"
command -v apt >/dev/null 2>&1 || fail apt-missing "apt is not available on this Spark"
command -v base64 >/dev/null 2>&1 || fail no-base64 "base64 is not available on this Spark"

# 1. Upgradable packages: `apt list --upgradable` rows read "name/suite version [arch] [upgradable from: old]".
APTOUT=$(timeout -k 10 120 apt list --upgradable 2>/dev/null); arc=$?
if [ "$arc" -ge 124 ]; then
  fail apt-failed "apt list could not run on this Spark"
elif [ "$arc" -ne 0 ]; then
  printf 'APT_ERR=%s\n' "$(clean "apt list answered nothing (exit $arc)")"
fi
if [ "$arc" = 0 ]; then APTJSON=$(printf '%s\n' "$APTOUT" | awk '
  function plain(s) { gsub(/[\\"]/, "", s); return s }
  /^[A-Za-z0-9][A-Za-z0-9+._-]*\// {
    name = $0; sub(/\/.*/, "", name)
    ver = $0; sub(/^[^ ]+ /, "", ver); sub(/ .*/, "", ver)
    old = ""
    if (match($0, /\[upgradable from: [^]]+\]/)) {
      old = substr($0, RSTART, RLENGTH)
      sub(/^\[upgradable from: /, "", old); sub(/\]$/, "", old)
    }
    if (name == "" || ver == "") next
    sep = rows ? "," : ""; rows = rows sep "{\"name\":\"" plain(name) "\",\"newVersion\":\"" plain(ver) "\",\"oldVersion\":\"" plain(old) "\"}"
  }
  END { printf "[%s]", rows }')
printf 'APT_B64=%s\n' "$(printf '%s' "$APTJSON" | base64 | tr -d '\n')"; fi

# 2. The unprivileged simulation: the summary line plus the Remv (removal) lines an install would cause.
SIMOUT=$(timeout -k 10 120 apt-get -s full-upgrade 2>/dev/null); src=$?
if ! printf '%s\n' "$SIMOUT" | grep -qE '^[0-9]+ upgraded, '; then
  printf 'SIM_ERR=%s\n' "$(clean "apt-get -s full-upgrade answered nothing (exit $src)")"
else
  SIMJSON=$(printf '%s\n' "$SIMOUT" | awk '
    /^Remv / { if (!($2 in seen)) { seen[$2] = 1; sep = rem ? "," : ""; rem = rem sep "\"" $2 "\"" } }
    /^[0-9]+ upgraded, / && !got {
      up = $0; sub(/ upgraded.*/, "", up)
      kept = $0; sub(/.* and /, "", kept); sub(/ not upgraded.*/, "", kept)
      got = 1
    }
    END { printf "{\"upgrades\":%d,\"kept\":%d,\"removals\":[%s]}", up + 0, kept + 0, rem }')
  printf 'SIM_B64=%s\n' "$(printf '%s' "$SIMJSON" | base64 | tr -d '\n')"
fi

# 3. Firmware through fwupd. get-updates --json exits 2 for "no actions, and that is fine".
if ! command -v fwupdmgr >/dev/null 2>&1; then
  printf 'FW_STATE=missing\n'
else
  FWOUT=$(timeout -k 10 180 fwupdmgr get-updates --json 2>/dev/null); frc=$?
  if [ "$frc" = 0 ] || [ "$frc" = 2 ]; then
    # Each device object starts at a "{"; a non-empty VersionUpgrade means an update is offered for it.
    FWJSON=$(printf '%s\n' "$FWOUT" | tr '{' '\n' | awk '
      function field(k,   s) {
        if (match($0, "\"" k "\":\"[^\"]*\"")) {
          s = substr($0, RSTART, RLENGTH); sub("\"" k "\":\"", "", s); sub(/"$/, "", s)
          gsub(/[\\"]/, "", s); return s
        }
        return ""
      }
      /"VersionUpgrade"/ {
        u = field("VersionUpgrade"); if (u == "") next
        sep = devs ? "," : ""; devs = devs sep "{\"name\":\"" field("Name") "\",\"current\":\"" field("Version") "\",\"available\":\"" u "\"}"
        n++
      }
      END { printf "{\"count\":%d,\"devices\":[%s]}", n + 0, devs }')
    printf 'FW_STATE=ok\nFW_B64=%s\n' "$(printf '%s' "$FWJSON" | base64 | tr -d '\n')"
  else
    printf 'FW_STATE=error\nFW_ERR=%s\n' "$(clean "fwupdmgr get-updates answered nothing (exit $frc)")"
  fi
  # A pending firmware reboot is a device fact, not an exit code: UEFI keys, dbx, NVMe and EC
  # plugins always carry needs-reboot/needs-shutdown as capability flags, so old fwupdmgr
  # `check-reboot-needed` exits 0 on idle machines too. What fwupd applied and still waits to
  # finish is a device whose UpdateState is 4 (FWUPD_UPDATE_STATE_NEEDS_REBOOT). fwupd 2.0.x
  # prints `"UpdateState" : 4`, newer prints `"UpdateState": 4`; the pattern accepts both and
  # is applied per device object (the same `tr '{' '\n'` split the firmware list uses).
  DEVOUT=$(timeout -k 10 60 fwupdmgr get-devices --json 2>/dev/null); drc=$?
  if [ "$drc" -ne 0 ] || ! printf '%s' "$DEVOUT" | grep -q '"Devices"'; then
    printf 'FWREBOOT=unknown\n'
  elif printf '%s' "$DEVOUT" | tr '{' '\n' | grep -Eq '"UpdateState"[[:space:]]*:[[:space:]]*4([^0-9]|$)'; then
    printf 'FWREBOOT=1\n'
  else
    printf 'FWREBOOT=0\n'
  fi
fi

# 4. Pending reboots and index freshness.
if [ -f /run/reboot-required ]; then printf 'REBOOT=1\n'; else printf 'REBOOT=0\n'; fi
STAMP=$(stat -c %Y /var/lib/apt/periodic/update-success-stamp 2>/dev/null)
case $STAMP in '' | *[!0-9]*) STAMP= ;; esac
printf 'STAMP=%s\n' "$STAMP"
printf 'RESULT=ok\n'
