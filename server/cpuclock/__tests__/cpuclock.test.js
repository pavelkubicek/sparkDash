import { test } from "node:test";
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CPU_MARKER_FILE,
  CPU_UNIT_NAME,
  buildCpuApplyProgram,
  buildCpuResetProgram,
  buildCpuStatusProgram,
  parseCpuCapRequest,
  parseCpuProgramOutput,
} from "../commands.js";

/**
 * A temp tree with fake cpupower, per-core sysfs cpufreq files, systemctl,
 * sudo and crontab. cpu0-1 are efficiency cores at 3000 MHz, cpu2-3 are
 * performance cores at 3900 MHz (the GB10 shape). `narrowSudo` models a unit
 * whose only passwordless rule is the cpupower one; `cron` models a running
 * cron service.
 */
function sandbox({ narrowSudo = false, cron = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cpuclock-"));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  for (const d of ["units", "run", "systemd", "user-home", "sys"]) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, "boot_id"), "11111111-2222-3333-4444-555555555555\n");
  for (const [cpu, maxMHz] of [[0, 3000], [1, 3000], [2, 3900], [3, 3900]]) {
    const dir = path.join(root, "sys", `cpu${cpu}`, "cpufreq");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "cpuinfo_max_freq"), `${maxMHz * 1000}\n`);
    fs.writeFileSync(path.join(dir, "scaling_max_freq"), `${maxMHz * 1000}\n`);
  }
  if (cron) fs.writeFileSync(path.join(root, "cron_active"), "");
  const calls = path.join(root, "calls.log");
  const crontab = path.join(root, "crontab");
  fs.writeFileSync(
    path.join(bin, "cpupower"),
    `#!/bin/sh
echo "cpupower $*" >> ${calls}
C=all; M=
while [ $# -gt 0 ]; do
  case "$1" in
    -c) C=$2; shift 2 ;;
    -u) M=\${2%MHz}; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$M" ] || exit 0
if [ "$C" = all ]; then C="0 1 2 3"; else C=$(printf '%s' "$C" | tr ',' ' '); fi
for c in $C; do echo $((M * 1000)) > ${root}/sys/cpu$c/cpufreq/scaling_max_freq; done
exit 0
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "systemctl"),
    `#!/bin/sh
echo "systemctl $*" >> ${calls}
case "$1" in
  is-enabled) [ -f ${root}/units/${CPU_UNIT_NAME} ] && echo enabled || echo disabled ;;
  is-active)
    if [ -f ${root}/cron_active ] && { [ "$2" = cron.service ] || [ "$2" = crond.service ]; }; then
      echo active
    elif [ -f ${root}/units/${CPU_UNIT_NAME} ]; then
      echo active
    else
      echo inactive
    fi ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "sudo"),
    `#!/bin/sh
echo "sudo $*" >> ${calls}
while [ "$1" = "-n" ] || [ "$1" = "-k" ]; do shift; done
if [ "$1" = "-l" ]; then echo "${bin}/cpupower -c 2,3 frequency-set -u 2808MHz"; exit 0; fi
case "$1" in
  ${bin}/cpupower) exec "$@" ;;
esac
echo "sudo: a password is required" >&2
exit 1
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "crontab"),
    `#!/bin/sh
echo "crontab $*" >> ${calls}
case "$1" in
  -l) if [ -f ${crontab} ]; then cat ${crontab}; else echo "no crontab for $(id -un)" >&2; exit 1; fi ;;
  -r) rm -f ${crontab} ;;
  *) cp "$1" ${crontab} ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(bin, "logger"), `#!/bin/sh\necho "logger $*" >> ${calls}\n`, { mode: 0o755 });
  const paths = {
    unitDir: path.join(root, "units"),
    runDir: path.join(root, "run"),
    bootIdFile: path.join(root, "boot_id"),
    systemdRunDir: path.join(root, "systemd"),
    cpufreqDir: path.join(root, "sys/cpu0/cpufreq"),
    cpupower: [path.join(bin, "cpupower")],
    systemctl: path.join(bin, "systemctl"),
    sandbox: true,
    sandboxSudo: narrowSudo ? path.join(bin, "sudo") : "",
  };
  const environment = (env = {}) => ({
    ...process.env,
    ...env,
    HOME: env.HOME?.startsWith(`${root}/`) ? env.HOME : path.join(root, "user-home"),
    PATH: env.PATH?.split(":").includes(bin) ? env.PATH : `${bin}:${env.PATH ?? process.env.PATH ?? ""}`,
  });
  const exec = (program, { env, ...options } = {}) =>
    execFileSync("sh", ["-c", program], { encoding: "utf8", ...options, env: environment(env) });
  const run = (program) => parseCpuProgramOutput(exec(program));
  const read = (f) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), "utf8") : null);
  return {
    root,
    paths,
    run,
    read,
    calls: () => read("calls.log") ?? "",
    cronText: () => read("crontab") ?? "",
    scaling: (cpu) => read(`sys/cpu${cpu}/cpufreq/scaling_max_freq`)?.trim(),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("parseCpuCapRequest accepts a normal cap and rejects everything else", () => {
  assert.deepEqual(parseCpuCapRequest({ maxMHz: 2808 }), { maxMHz: 2808, persist: false, perfOnly: true });
  assert.deepEqual(parseCpuCapRequest({ maxMHz: 2808, persist: true, perfOnly: false }), {
    maxMHz: 2808,
    persist: true,
    perfOnly: false,
  });
  for (const bad of [
    null,
    {},
    { maxMHz: "2808" },
    { maxMHz: 2808.5 },
    { maxMHz: 299 },
    { maxMHz: 10001 },
    { maxMHz: -1 },
    { maxMHz: 2808, persist: "yes" },
    { maxMHz: 2808, perfOnly: "no" },
  ]) {
    assert.throws(() => parseCpuCapRequest(bad), (e) => e.status === 400, JSON.stringify(bad));
  }
});

test("CPU programs are valid POSIX sh and carry only validated values", () => {
  for (const prog of [
    buildCpuStatusProgram(),
    buildCpuApplyProgram({ maxMHz: 2808, persist: false }),
    buildCpuApplyProgram({ maxMHz: 2808, persist: true, perfOnly: false }),
    buildCpuResetProgram(),
  ]) {
    execFileSync("sh", ["-n", "-c", prog]);
  }
  assert.match(buildCpuApplyProgram({ maxMHz: 2808, persist: false }), /-u 2808MHz/);
  assert.throws(() => buildCpuApplyProgram({ maxMHz: 2808 }, { unitDir: "/etc/x; id" }), /unsafe path/);
});

test("the default caps only the performance cores and reports both groups", () => {
  const sb = sandbox();
  try {
    const res = sb.run(buildCpuApplyProgram({ maxMHz: 2808, persist: true }, sb.paths));
    assert.equal(res.RESULT, "ok", JSON.stringify(res));
    assert.equal(res.CAP, "2808");
    assert.equal(res.PERSIST_KIND, "unit");
    assert.equal(res.PERSIST_MODE, "perf");
    assert.equal(sb.scaling(2), "2808000");
    assert.equal(sb.scaling(3), "2808000");
    assert.equal(sb.scaling(0), "3000000");
    assert.equal(sb.scaling(1), "3000000");
    const unit = sb.read(`units/${CPU_UNIT_NAME}`);
    assert.ok(unit);
    assert.match(unit, /ExecStart=.* -c 2,3 frequency-set -u 2808MHz/);
    assert.match(unit, /ExecStop=.* -c 2,3 frequency-set -u 3900MHz/);
    assert.match(unit, /ExecStop=.* -c 0,1 frequency-set -u 3000MHz/);
    assert.equal(sb.read(`run/${CPU_MARKER_FILE}`).trim(), "2808 11111111-2222-3333-4444-555555555555 perf");

    const status = sb.run(buildCpuStatusProgram(sb.paths));
    assert.equal(status.RESULT, "ok", JSON.stringify(status));
    assert.equal(status.HWMAX, "3900");
    assert.equal(status.PERFMAX, "3900");
    assert.equal(status.MINMAX, "3000");
    assert.equal(status.HET, "1");
    assert.equal(status.PERF_CPUS, "2,3");
    assert.equal(status.CURMAX, "2808");
    assert.equal(status.CAP, "2808");
    assert.equal(status.CAP_MODE, "perf");
    assert.equal(status.SVC_INSTALLED, "1");
    assert.equal(status.SVC_CPUS, "2,3");
    assert.equal(status.SVC_MODE, "perf");
  } finally {
    sb.cleanup();
  }
});

test("the all-cores mode caps every core to the shared ceiling", () => {
  const sb = sandbox();
  try {
    const res = sb.run(buildCpuApplyProgram({ maxMHz: 2808, persist: true, perfOnly: false }, sb.paths));
    assert.equal(res.RESULT, "ok", JSON.stringify(res));
    assert.equal(res.PERSIST_MODE, "all");
    for (const cpu of [0, 1, 2, 3]) assert.equal(sb.scaling(cpu), "2808000");
    const status = sb.run(buildCpuStatusProgram(sb.paths));
    assert.equal(status.CAP, "2808");
    assert.equal(status.CAP_MODE, "all");
    assert.equal(status.SVC_CPUS, "all");
    assert.equal(status.SVC_MODE, "all");
    assert.equal(status.CURMAX, "2808");
  } finally {
    sb.cleanup();
  }
});

test("the cron path uses the narrow rule and installs an @reboot job for the perf cores", () => {
  const sb = sandbox({ narrowSudo: true, cron: true });
  try {
    const res = sb.run(buildCpuApplyProgram({ maxMHz: 2808, persist: true }, sb.paths));
    assert.equal(res.RESULT, "ok", JSON.stringify(res));
    assert.equal(res.PERSIST_KIND, "cron");
    assert.equal(sb.scaling(2), "2808000");
    assert.equal(sb.scaling(0), "3000000");
    assert.match(sb.cronText(), /@reboot .* -c 2,3 frequency-set -u 2808MHz.* # sparkdash-cpu-clock-cap/);
    assert.equal(sb.read(`run/${CPU_MARKER_FILE}`).trim(), "2808 11111111-2222-3333-4444-555555555555 perf");
    const status = sb.run(buildCpuStatusProgram(sb.paths));
    assert.equal(status.CRON_INSTALLED, "1");
    assert.equal(status.CRON_CLOCKS, "2808");
    assert.equal(status.CRON_CPUS, "2,3");
    assert.equal(status.CRON_MODE, "perf");
    assert.equal(status.CAP, "2808");
  } finally {
    sb.cleanup();
  }
});

test("reset restores each group's own maximum and removes hooks and marker", () => {
  const sb = sandbox();
  try {
    assert.equal(sb.run(buildCpuApplyProgram({ maxMHz: 2808, persist: true }, sb.paths)).RESULT, "ok");
    const res = sb.run(buildCpuResetProgram(sb.paths));
    assert.equal(res.RESULT, "ok", JSON.stringify(res));
    assert.equal(sb.scaling(2), "3900000");
    assert.equal(sb.scaling(3), "3900000");
    assert.equal(sb.scaling(0), "3000000");
    assert.equal(sb.read(`units/${CPU_UNIT_NAME}`), null);
    assert.equal(sb.read(`run/${CPU_MARKER_FILE}`), null);
    const status = sb.run(buildCpuStatusProgram(sb.paths));
    assert.equal(status.CAP, "");
    assert.equal(status.CAP_MODE, "");
    assert.equal(status.SVC_INSTALLED, "0");
  } finally {
    sb.cleanup();
  }
});

test("a cap above the selected core group's ceiling is refused before anything changes", () => {
  const perf = sandbox();
  try {
    const res = perf.run(buildCpuApplyProgram({ maxMHz: 3901, persist: false }, perf.paths));
    assert.equal(res.RESULT, "error");
    assert.equal(res.CODE, "range");
    assert.equal(perf.scaling(2), "3900000");
  } finally {
    perf.cleanup();
  }
  const all = sandbox();
  try {
    const res = all.run(buildCpuApplyProgram({ maxMHz: 3001, persist: false, perfOnly: false }, all.paths));
    assert.equal(res.RESULT, "error");
    assert.equal(res.CODE, "range");
    assert.equal(all.scaling(0), "3000000");
  } finally {
    all.cleanup();
  }
});
