import fs from "node:fs";
import path from "node:path";

/**
 * A bash stand-in for the on-unit `rea` launcher (~/.local/bin/rea-sparkdash): same subcommands
 * the programs use, JSON on stdout, an error object + exit 1 for unknown commands. Behaviour is
 * toggled by marker files in $HOME:
 *   rea-slow         sleep 60 before printing (a long analysis)
 *   rea-big          print a result of about 300 KB
 *   rea-bigview      inspect-analysis-view prints about 600 KB
 *   rea-ignore-term  ignore TERM and never finish (only KILL ends it)
 *   rea-exit-code    exit with the code in the file after printing a valid result
 *   rea-error-zero   print an error object but exit 0
 *   rea-error-code   print an error object with the code named in the file, exit 1
 * Every call is logged to $HOME/rea.argv (one line per call) and the pid to $HOME/rea.pid.
 */
export const FAKE_REA = `#!/bin/bash
printf '%s\\n' "$*" >> "$HOME/rea.argv"
echo $$ > "$HOME/rea.pid"
err() { printf '{"code":"%s","message":"%s","cta":null}\\n' "$1" "$2"; exit 1; }
cmd="$1"
case "$cmd" in
  --version) echo "@VERSION@"; exit 0 ;;
  doctor)
    echo '{"healthy":false,"environment_healthy":true,"scope":{"mode":"audit-wide"},"scope_checks":[{"name":"node","ok":true,"classification":"healthy","detail":"fake"},{"name":"ghidra","ok":false,"classification":"missing_analysis_engine","remediation":"Set GHIDRA_INSTALL_DIR."}]}'
    exit 1 ;;
  providers)
    echo '{"open":true,"capabilities":[{"operation":"disassemble","available":false,"reason":"no provider","availability_code":"provider_missing","effects":{"mutates_artifact":false,"launches_process":true,"may_show_ui":false,"may_access_network":false,"may_write_filesystem":false,"changes_permissions":false,"requires_root":false},"limitations":[]}]}'
    exit 0 ;;
esac
[ -f "$HOME/rea-error-code" ] && err "$(cat "$HOME/rea-error-code")" "forced error"
[ -f "$HOME/rea-error-zero" ] && { echo '{"code":"forced","message":"error with exit 0","cta":null}'; exit 0; }
[ -f "$HOME/rea-ignore-term" ] && { trap '' TERM; while true; do sleep 1; done; }
[ -f "$HOME/rea-slow" ] && sleep 60
case "$cmd" in
  inspect-artifact|analyze-javascript-application)
    target="$2"
    [ -e "$target" ] || err target_unavailable "Cannot open artifact: $target does not exist"
    if [ -f "$HOME/rea-big" ]; then
      printf '{"kind":"artifact","data":"'; head -c 300000 /dev/zero | tr '\\0' 'x'; printf '"}\\n'
    elif [ "$cmd" = analyze-javascript-application ]; then
      printf '{"kind":"javascript-app","path":"%s","modules":[{"id":"m1","name":"index.js"},{"id":"m2","name":"util.js"}],"limitations":["fake"]}\\n' "$target"
    else
      printf '{"kind":"artifact","path":"%s","bytes":%s,"format":"unknown"}\\n' "$target" "$(stat -c %s "$target" 2>/dev/null || echo 0)"
    fi
    ;;
  inspect-analysis-view)
    f="$2"
    [ -f "$f" ] || err missing_argument "no view file"
    # Like the real 6.4.0 CLI: only an inline-evidence source is accepted (a file source is invalid_request).
    head -c 200 "$f" | grep -q '"source":{"kind":"inline","evidence":' || err invalid_request "source.kind must be one of: retained-evidence, inline"
    if [ -f "$HOME/rea-bigview" ]; then
      printf '{"view":"big","data":"'; head -c 600000 /dev/zero | tr '\\0' 'y'; printf '"}\\n'
    else
      # The request is {"source":{"kind":"inline","evidence":<possibly huge>},"view":<view>}: echo only the small parts.
      v=$(tail -c 600 "$f" | tr -d '\\n' | sed 's/.*},"view"://; s/}$//')
      printf '{"view":"ok","request":{"source":{"kind":"inline"},"view":%s}}\\n' "$v"
    fi
    ;;
  compare)
    [ -f "$2" ] && [ -f "$3" ] || err target_unavailable "compare inputs missing"
    # Like the real CLI: a single Evidence record is not a bundle.
    grep -q '"records"' "$2" && grep -q '"records"' "$3" || err evidence_integrity_mismatch "Expected an Evidence bundle with records and manifest arrays, but this JSON is one Evidence record."
    printf '{"kind":"compare","left":%s,"right":%s,"same":%s}\\n' "$(stat -c %s "$2")" "$(stat -c %s "$3")" "$(cmp -s "$2" "$3" && echo true || echo false)"
    ;;
  *) err COMMAND_NOT_FOUND "'$cmd' is not a command for 'rea'." ;;
esac
[ -f "$HOME/rea-exit-code" ] && exit "$(cat "$HOME/rea-exit-code")"
exit 0
`;

/** Write the fake launcher to <home>/.local/bin/rea-sparkdash. */
export function installFakeRea(home, { version = "6.4.0" } = {}) {
  const bin = path.join(home, ".local", "bin");
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, "rea-sparkdash");
  fs.writeFileSync(file, FAKE_REA.replace("@VERSION@", version), { mode: 0o755 });
  // The compare program wraps each run's Evidence record with REA's own bundle builder from the pinned install.
  const dist = path.join(home, ".local", "share", "sparkdash", "rea", version, "node_modules", "rea-agents", "dist", "domain");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "package.json"), '{"type":"module"}\n');
  fs.writeFileSync(
    path.join(dist, "evidenceBundle.js"),
    "export const createEvidenceBundle = (records, unknowns = []) => ({ artifacts: [], providers: [], environments: [], scenarios: [], captures: [], unknowns, records });\n" +
      "export const serializeEvidenceBundle = (bundle) => JSON.stringify(bundle);\n"
  );
  return file;
}
