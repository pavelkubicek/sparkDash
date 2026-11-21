# Sudo index refresh: apt-get update (three tries, no translation packages) and fwupdmgr refresh,
# then the check body (appended by the caller) answers with the fresh state. Runs as root through
# the wrapper's sudo; a wrong password is refused by the gate before anything here runs.
export LC_ALL=C
ok=0
if ! command -v apt-get >/dev/null 2>&1; then
  fail apt-missing "apt is not available on this Spark"
fi
# apt's own complaints go here, so the real reason (the last E: line) can be reported instead of
# a bare "failed after 3 tries". A read-only /tmp leaves it empty: the retry and the message cope.
APT_LOG=$(mktemp 2>/dev/null) || APT_LOG=""
[ -n "$APT_LOG" ] || APT_LOG=/tmp/sparkdash-apt-update.$$.log
trap 'rm -f "$APT_LOG"' EXIT
try_update() {
  timeout -k 10 600 apt-get update -o Acquire::Languages=none "$@" >"$APT_LOG" 2>&1
}
n=0
while [ "$n" -lt 3 ]; do
  n=$((n + 1))
  if try_update; then
    ok=1
    break
  fi
  [ "$n" -lt 3 ] && sleep 2
done
# A repository that changed its Release metadata (a PPA renamed its Label, a suite moved) is a hard
# error apt refuses by default, and it fails every retry identically. One try with the change
# allowed — the documented remedy, taken only for that error class and nothing else.
if [ "$ok" = 0 ] && grep -q "changed its '" "$APT_LOG" 2>/dev/null; then
  if try_update -o Acquire::AllowReleaseInfoChange=true; then
    ok=1
  fi
fi
REFRESH_RC=0
if [ "$ok" = 0 ]; then
  REFRESH_RC=1
fi
# A plain apt-get update never writes apt.systemd.daily's success stamp, so the check's STAMP
# (and the UI's "index refreshed" age) would keep telling the night's last run after a dashboard
# refresh: mark it ourselves. Guarded — a read-only unit or a layout without the dir is left as is.
if [ "$ok" = 1 ]; then
  APT_STAMP="${SPARKDASH_APT_STAMP-/var/lib/apt/periodic/update-success-stamp}"
  mkdir -p "$(dirname "$APT_STAMP")" >/dev/null 2>&1 || true
  touch "$APT_STAMP" >/dev/null 2>&1 || true
fi
# fwupdmgr refresh is best effort: a unit without fwupd, or with an unreachable remote, still
# gets its apt index refreshed and the fresh check below reports what it can.
if command -v fwupdmgr >/dev/null 2>&1; then
  if timeout -k 10 300 fwupdmgr refresh >/dev/null 2>&1; then
    printf 'REFRESH_FW=ok\n'
  else
    printf 'REFRESH_FW=failed\n'
  fi
else
  printf 'REFRESH_FW=missing\n'
fi
if [ "$REFRESH_RC" = 1 ]; then
  WHY=$(grep -E '^E: ' "$APT_LOG" 2>/dev/null | tail -n 1)
  [ -n "$WHY" ] || WHY="apt-get update failed after 3 tries"
  printf 'REFRESH_ERR=%s\n' "$(clean "$WHY")"
else
  printf 'REFRESHED=ok\n'
fi
