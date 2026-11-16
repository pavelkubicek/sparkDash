# DGX Dashboard services on one unit: status (unprivileged), or turn both units off/on (sudo).
# $1: status | on | off. The two units always move together — the owner's example loop:
#   for u in dgx-dashboard.service dgx-dashboard-admin.service; do systemctl disable --now "$u"; done
# The answer carries both units either way, so the page reads the truth after applying.
export LC_ALL=C
MODE=${1-status}
case $MODE in on | off | status) ;; *) fail bad-mode "Unknown dashboard service action" ;; esac
UNITS="dgx-dashboard.service dgx-dashboard-admin.service"
command -v systemctl >/dev/null 2>&1 || fail no-systemd "systemd is not available on this Spark"

answer_status() {
  i=0
  for u in $UNITS; do
    i=$((i + 1))
    printf 'D%s_UNIT=%s\n' "$i" "$u"
    e=$(systemctl is-enabled "$u" 2>/dev/null)
    [ -n "$e" ] || e=not-found
    case $e in not-found | enabled | disabled | static | masked | generated | indirect | alias | preset | linked) ;; *) e=not-found ;; esac
    a=$(systemctl is-active "$u" 2>/dev/null)
    [ -n "$a" ] || a=unknown
    case $a in active | inactive | failed | activating | deactivating | reloading | not-found) ;; *) a=unknown ;; esac
    m=$(systemctl show -p MemoryCurrent --value "$u" 2>/dev/null)
    case $m in '' | *[!0-9]*) m= ;; esac
    p=$(systemctl show -p MainPID --value "$u" 2>/dev/null)
    case $p in '' | *[!0-9]*) p= ;; esac
    printf 'D%s_ENABLED=%s\nD%s_ACTIVE=%s\nD%s_MEM=%s\nD%s_PID=%s\n' "$i" "$e" "$i" "$a" "$i" "$m" "$i" "$p"
  done
  printf 'RESULT=ok\n'
}

if [ "$MODE" = status ]; then
  answer_status
  exit 0
fi

[ "$(id -u)" = 0 ] || fail no-sudo "Turning the Dashboard services needs administrator rights on this Spark"
i=0
for u in $UNITS; do
  i=$((i + 1))
  # Each unit moves on its own; a unit that is not installed simply stays as it is, which the
  # status below reports. systemctl is not allowed to abort the loop.
  if [ "$MODE" = off ]; then
    timeout -k 10 120 systemctl disable --now "$u" >/dev/null 2>&1 || printf 'DERR%s=not-fully-applied\n' "$i"
  else
    timeout -k 10 120 systemctl enable --now "$u" >/dev/null 2>&1 || printf 'DERR%s=not-fully-applied\n' "$i"
  fi
done
answer_status
