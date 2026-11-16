# Sudo full upgrade of one Spark: apt first, then firmware, and never a reboot.
# Runs as root through the wrapper's sudo (a wrong password is refused by the gate before
# anything here runs). Removal gating is decided by the dashboard before this is sent: the page
# must confirm the Remv list the last check reported. STEP/LAST lines let the dashboard show
# where the upgrade got to after the fact; the check body (appended by the caller) answers
# with the fresh state, including whether a reboot is needed now.
export LC_ALL=C
[ "$(id -u)" = 0 ] || fail no-sudo "The upgrade needs administrator rights on this Spark"
command -v apt-get >/dev/null 2>&1 || fail apt-missing "apt is not available on this Spark"
command -v base64 >/dev/null 2>&1 || fail no-base64 "base64 is not available on this Spark"
APTLOG=$(mktemp 2>/dev/null) || fail no-tmp "could not create a log file on this Spark"
FWLOG=$(mktemp 2>/dev/null) || fail no-tmp "could not create a log file on this Spark"
trap 'rm -f "$APTLOG" "$FWLOG"' EXIT
DEBIAN_FRONTEND=noninteractive timeout -k 30 10800 apt-get -y -o Dpkg::Options::=--force-confold full-upgrade >"$APTLOG" 2>&1
arc=$?
if [ "$arc" -ne 0 ]; then
  WHY=$(grep -E '^E: ' "$APTLOG" | tail -n 1)
  [ -n "$WHY" ] || WHY="apt full-upgrade exited $arc"
  fail apt-failed "$(clean "$WHY")"
fi
# Where the upgrade got to: the packages dpkg unpacked and configured, in order.
grep -E '^(Setting up|Unpacking) ' "$APTLOG" | awk '{ print "LAST=" $2 }'

printf 'STEP=firmware\n'
if ! command -v fwupdmgr >/dev/null 2>&1; then
  printf 'FWUP=missing\n'
else
  timeout -k 10 3600 fwupdmgr upgrade -y --offline >"$FWLOG" 2>&1
  frc=$?
  # 1 means "nothing to do" per device in some fwupd versions; 2 is the documented
  # "no actions, and that is fine". Anything past that failed.
  if [ "$frc" = 0 ] || [ "$frc" = 2 ]; then
    if grep -qiE 'Nothing to do|no updates' "$FWLOG"; then printf 'FWUP=none\n'; else printf 'FWUP=done\n'; fi
  elif [ "$frc" = 1 ]; then
    if grep -qiE 'Nothing to do|no updates|failed to obtain' "$FWLOG"; then printf 'FWUP=none\n'
    else fail fw-failed "$(clean "fwupdmgr upgrade failed: $(grep -E 'Failure|failed' "$FWLOG" | tail -n 1)")"; fi
  else
    fail fw-failed "$(clean "fwupdmgr upgrade failed (exit $frc): $(grep -E 'Failure|failed' "$FWLOG" | tail -n 1)")"
  fi
fi
# The check body follows (appended by the caller) and prints RESULT.
