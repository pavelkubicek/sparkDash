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
  # Never reboot from here: that is the invariant. The fwupd 2.0.x client has no reboot
  # capability at all (no systemctl/reboot call in fwupdmgr nor the daemon), and `--offline`
  # does not exist in it — it died at argument parsing with "Failed to parse arguments".
  # Offline / capsule-on-disk staging is automatic in 2.x, and a device that now needs a
  # reboot surfaces as UpdateState 4, which the check body below reports as FWREBOOT=1.
  # --no-reboot-check is a real Application Option ("Do not check or prompt for reboot
  # after update"): it keeps fwupdmgr from nagging, and the person reboots when they choose.
  timeout -k 10 3600 fwupdmgr update -y --no-reboot-check >"$FWLOG" 2>&1
  frc=$?
  okrc=0
  { [ "$frc" = 0 ] || [ "$frc" = 2 ]; } && okrc=1
  # What fwupdmgr actually said: the interesting lines, falling back to the raw tail, newest
  # first, on one line so clean (first line, 200 chars) can carry it. Newest first because the
  # real cause is normally the LAST line of the tail: oldest-first evidence lines pushed it
  # past the 200-char cap and out of MSG. Attached to every failure message, so a failure is
  # never an empty "failed:" line, and emitted as FWTAIL for the dashboard to show alongside.
  newest_first() { awk '{ l[NR] = $0 } END { for (i = NR; i > 0; i--) print l[i] }'; }
  WHY=$(grep -iE 'failure|failed|error|not supported|requires|denied|unauthorized' "$FWLOG" | tail -n 3 | newest_first)
  [ -n "$WHY" ] || WHY=$(tail -n 3 "$FWLOG" | newest_first)
  WHY=$(printf '%s' "$WHY" | tr '\n' ' ')
  # Two-tier failure classifier, case-insensitive on purpose ("Failed to parse arguments"
  # is capitalised). HARD evidence is unambiguous — the invocation itself broke ("Failed to
  # parse arguments", "Failed to connect to fwupd") or an operation was refused — and fails
  # the phase whatever the exit code left, so a broken invocation can never read as done/none.
  # SOFT evidence (plugin chatter with "error", per-device "not supported" skips) is routine
  # on device-rich Dell GB10 units that exit 0, so it escalates only on a nonzero exit.
  # 'requires' is left out of both tiers, since "Device requires restart" is what a successful
  # capsule-on-disk staging prints.
  if grep -qiE '^failed to |failed to (parse|connect|open|download|write|update|obtain)|^failure$|failure:|denied|unauthorized' "$FWLOG" \
     || { [ "$frc" != 0 ] && grep -qiE 'error|not supported' "$FWLOG"; }; then
    printf 'FWTAIL=%s\n' "$(clean "$WHY")"
    fail fw-failed "$(clean "fwupdmgr update failed (exit $frc): $WHY")"
  # Work was done and a capsule staged or a device updated. Checked BEFORE the no-work wording,
  # because a mixed run legitimately prints "No updates found for X" for the devices without an
  # update while staging one for another — that is done, not "nothing to upgrade". The no-work
  # lines themselves are excluded from the staging evidence first, so "Nothing needs updating"
  # stays the pure no-work answer it is.
  elif [ "$okrc" = 1 ] && grep -viE 'nothing to do|no updates|no devices to update|nothing needs updating' "$FWLOG" | grep -qiE 'installing|updating|requires (a )?restart|requires reboot'; then
    printf 'FWUP=done\n'
  # "Nothing to do" only on explicit no-work wording — case-insensitive, and never on mere
  # exit code. 'failed to obtain' is gone: it is failure evidence, not an empty queue.
  elif grep -qiE 'nothing to do|no updates|no devices to update|nothing needs updating' "$FWLOG"; then
    printf 'FWUP=none\n'
  # 0 did the work it was asked to do; 2 is the documented "no actions, and that is fine".
  # Anything else (1 in some fwupd versions, 124 from the timeout, …) failed.
  elif [ "$okrc" = 1 ]; then
    printf 'FWUP=done\n'
  else
    printf 'FWTAIL=%s\n' "$(clean "$WHY")"
    fail fw-failed "$(clean "fwupdmgr update failed (exit $frc): $WHY")"
  fi
fi
# The check body follows (appended by the caller) and prints RESULT.
