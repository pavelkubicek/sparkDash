import fs from "node:fs";
import path from "node:path";

/**
 * Stand-ins for the two programs sparkDash drives on a unit: `vh` (VulnHunter's operator CLI,
 * same subcommands and exit codes) and a harness one-shot ("fake-harness") that behaves like a
 * hunt: reads the prompt file, writes a *_VULNHUNT_RESULTS_* folder into the checkout.
 */
export const FAKE_VH = `#!/bin/bash
case "$1" in
  clone)
    url="$2"; dest=""; shift 2
    while [ $# -gt 0 ]; do [ "$1" = --dest ] && dest="$2"; shift; done
    [ -n "$FAKE_CLONE_FAIL" ] && { echo "fatal: unable to access '$url'" >&2; exit 2; }
    [ -f "$HOME/slow-clone" ] && sleep 60
    mkdir -p "$dest"; git init -q "$dest"
    git -C "$dest" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
    if [ -f "$HOME/plant-results" ]; then
      mkdir -p "$dest/evil_VULNHUNT_RESULTS_planted"
      printf '# VulnHunter Security Audit Report\\n| ID | Title | Severity |\\n|---|---|---|\\n| VULN-666 | planted | High |\\n' > "$dest/evil_VULNHUNT_RESULTS_planted/README.md"
    fi
    echo "cloned $url"; exit 0 ;;
  find-results)
    found=1
    for d in "$2"/*_VULNHUNT_RESULTS_*; do [ -d "$d" ] && { echo "$d"; found=0; }; done
    [ $found = 0 ] || echo "no *_VULNHUNT_RESULTS_* directory under $2" >&2
    exit $found ;;
  write-manifest)
    [ -f "$HOME/slow-manifest" ] && sleep 4
    printf '{"schema_version":"1","scan_id":"%s","agent_exit_code":%s,"cost_usd":0,"findings":[],"posted":[],"skipped":[],"failed":[]}\\n' "$(basename "$2")" "\${4:-0}" > "$2/scan_manifest.json"
    echo "$2/scan_manifest.json"; exit 0 ;;
  validate-manifest) echo "ok $2"; exit 0 ;;
  host)
    [ -n "$VULNHUNT_HOST_CMD" ] || { echo "VULNHUNT_HOST_CMD is not set" >&2; exit 2; }
    eval "exec $VULNHUNT_HOST_CMD \\"$2\\"" ;;
esac
echo "usage: vh ..." >&2; exit 2
`;

export const REPORT = `# VulnHunter Security Audit Report

**Run ID**: proj_VULNHUNT_RESULTS_2026-10-12-000000
**Repository**: https://example.com/org/repo
**Audit Date**: 2026-10-12
**Branch**: main [abc1234]
**Model**: test-model
**Findings Summary**: 0 High+, 1 High, 1 Medium, 0 Low, 0 Informational

### Summary

| ID | Title | CWE | Severity | Runtime | Exploit Test | Measured Impact | Status |
|---|---|---|---|---|---|---|---|
| VULN-001 | SQL injection in search | CWE-89 | High | in-process:node | PASS | 3 of 20 payloads returned rows | Confirmed |
| VULN-002 | <img src=x onerror=alert(1)> reflected | CWE-79 | Medium | static | PASS | n/a | Confirmed |
`;

/** A harness one-shot: argv = prompt file (last argument). */
export const FAKE_HARNESS = `#!/bin/bash
prompt="\${@: -1}"
cp "$prompt" "$HOME/prompt.seen"
echo $$ > "$HOME/harness.pid"
dir=$(sed -n '1s|^/vulnhunt ||p' "$prompt")
echo "harness: hunting in $dir"
if [ -f "$HOME/spew" ]; then head -c 400000 /dev/zero | tr '\\0' 'x' | fold -w 200; fi
[ -f "$HOME/exit-code" ] && exit "$(cat "$HOME/exit-code")"
[ -f "$HOME/ignore-term" ] && { trap '' TERM; while true; do sleep 1; done; }
[ -f "$HOME/slow" ] && { sleep 60; }
[ -f "$HOME/spew-wait" ] && sleep 6
[ -f "$HOME/no-results" ] && exit 0
res="$dir/proj_VULNHUNT_RESULTS_2026-10-12-000000"
mkdir -p "$res/poc" "$res/exploit_tests"
echo "poc" > "$res/poc/VULN-001_sql_injection.md"
echo "test" > "$res/exploit_tests/test_vuln_001.py"
if [ -f "$HOME/symlink-readme" ]; then
  ln -s "$HOME/secret.txt" "$res/README.md"
else
  cat "$HOME/report.md" > "$res/README.md"
fi
echo "harness: done"
exit 0
`;

/** A unit home with vh + the harness installed and the host command file in place (mode 600). */
export function installFakeUnit(home, { hostCmd = "fake-harness --headless", report = REPORT } = {}) {
  const bin = path.join(home, ".local", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "vh"), FAKE_VH, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "fake-harness"), FAKE_HARNESS, { mode: 0o755 });
  fs.writeFileSync(path.join(home, "report.md"), report);
  fs.writeFileSync(path.join(home, "secret.txt"), "TOP-SECRET-DO-NOT-LEAK\n");
  if (hostCmd != null) {
    const cfg = path.join(home, ".config", "sparkdash");
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(path.join(cfg, "vulnhunt-host-cmd"), `${hostCmd}\n`, { mode: 0o600 });
  }
}
