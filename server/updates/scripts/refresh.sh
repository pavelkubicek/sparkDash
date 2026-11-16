# Sudo index refresh: apt-get update (three tries, no translation packages) and fwupdmgr refresh,
# then the check body (appended by the caller) answers with the fresh state. Runs as root through
# the wrapper's sudo; a wrong password is refused by the gate before anything here runs.
export LC_ALL=C
ok=0
if ! command -v apt-get >/dev/null 2>&1; then
  fail apt-missing "apt is not available on this Spark"
fi
n=0
while [ "$n" -lt 3 ]; do
  n=$((n + 1))
  if timeout -k 10 600 apt-get update -o Acquire::Languages=none >/dev/null 2>&1; then
    ok=1
    break
  fi
  [ "$n" -lt 3 ] && sleep 2
done
REFRESH_RC=0
if [ "$ok" = 0 ]; then
  REFRESH_RC=1
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
  printf 'REFRESH_ERR=%s\n' "$(clean "apt-get update failed after 3 tries")"
else
  printf 'REFRESHED=ok\n'
fi
