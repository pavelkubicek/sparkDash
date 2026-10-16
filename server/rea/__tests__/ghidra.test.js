import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  GHIDRA_RECORD,
  GHIDRA_VERSION,
  JDK_PIN,
  exitToken,
  buildGhidraInstallProgram,
  buildRunProgram,
  buildStatusProgram,
} from "../commands.js";

// Hermetic: a fake JDK, a fake Ghidra release served over file://, real bash, real make. No network.

const made = [];
const procs = new Set();
const tmp = (p) => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
  made.push(d);
  return d;
};
const killGroup = (pid) => {
  for (const t of [-pid, pid]) {
    try {
      process.kill(t, "SIGKILL");
    } catch {}
  }
};
after(() => {
  for (const p of procs) killGroup(p);
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const NONCE = "g1";
const TX = exitToken(NONCE);
const exitOf = (out) => {
  const m = out.trimEnd().split("\n").at(-1);
  assert.ok(m.startsWith(TX), `no exit token in: ${out.slice(-400)}`);
  return Number(m.slice(TX.length));
};
const NATIVE = { aarch64: "linux_arm_64", x86_64: "linux_x86_64" }[execFileSync("uname", ["-m"]).toString().trim()] ?? "linux_x86_64";
const NODE_DIR = path.dirname(process.execPath);

function exec(cmd, { home, env = {}, timeoutMs = 90_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-c", cmd], {
      env: { HOME: home, PATH: `${NODE_DIR}:/usr/local/bin:/usr/bin:/bin`, LANG: "C", SPARKDASH_REA_JDK_DIRS: "", SPARKDASH_REA_GHIDRA_URL: "file:///nonexistent/ghidra.zip", SPARKDASH_REA_JDK_URL: "file:///nonexistent/jdk.tar.gz", ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    procs.add(child.pid);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => {
      killGroup(child.pid);
      reject(new Error(`timed out\n${out}`));
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      procs.delete(child.pid);
      resolve({ code, out });
    });
  });
}

const sha256 = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

/** A JDK directory whose java prints what a real 64-bit JDK of that major prints. */
function fakeJdk(major = 21, { javac = true } = {}) {
  const h = tmp("rea-jdk-");
  fs.mkdirSync(path.join(h, "bin"));
  const ver = major === 8 ? "1.8.0_492" : `${major}.0.1`;
  fs.writeFileSync(path.join(h, "bin", "java"), `#!/bin/bash\n[ "$1" = -version ] && { echo 'openjdk version "${ver}" 2025-01-01' >&2; echo 'OpenJDK 64-Bit Server VM (build x, mixed mode)' >&2; exit 0; }\nexit 0\n`, { mode: 0o755 });
  if (javac) fs.writeFileSync(path.join(h, "bin", "javac"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  return h;
}

/**
 * A Ghidra release zip. `native: false` leaves the decompiler out and ships a Makefile (what the real release
 * looks like on aarch64); `fail` makes analyzeHeadless fail.
 */
function fakeGhidraZip({ native = true, version = GHIDRA_VERSION, makeFails = false, importOk = true } = {}) {
  const work = tmp("rea-gzip-");
  const top = path.join(work, "tree", `ghidra_${version}_PUBLIC`);
  const w = (rel, text, mode = 0o644) => {
    const f = path.join(top, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text, { mode });
  };
  w("Ghidra/application.properties", `application.name=Ghidra\napplication.java.min=21\napplication.version=${version}\n`);
  // Records what the program was started with, then behaves like a successful (or failing) import.
  w(
    "support/analyzeHeadless",
    `#!/bin/bash\n{ echo "JAVA_HOME=$JAVA_HOME"; echo "GHIDRA_INSTALL_DIR=$GHIDRA_INSTALL_DIR"; echo "ARGS=$*"; } > "$HOME/headless.env"\n` +
      (importOk ? `echo "INFO  REPORT: Import succeeded"\nexit 0\n` : `echo "ERROR could not import"\nexit 1\n`),
    0o755
  );
  w("ghidraRun", "#!/bin/bash\nexit 0\n", 0o755);
  if (native) {
    w(`Ghidra/Features/Decompiler/os/${NATIVE}/decompile`, "#!/bin/bash\nexit 0\n", 0o755);
    w(`Ghidra/Features/Decompiler/os/${NATIVE}/sleigh`, "#!/bin/bash\nexit 0\n", 0o755);
  } else {
    w(
      "Ghidra/Features/Decompiler/src/decompile/cpp/Makefile",
      makeFails
        ? "ghidra_opt:\n\t@echo 'g++: error: simulated compile failure' >&2; exit 2\nsleigh_opt:\n\t@exit 2\n"
        : // Like Ghidra's: ARCH_TYPE is -m32 off x86_64 unless overridden on the command line, and the object
          // directories are not created by the Makefile before the recipes need them.
          "ARCH_TYPE=-m32\n" +
          "ghidra_opt:\n\t@test -z '$(ARCH_TYPE)' || { echo 'bad ARCH_TYPE=$(ARCH_TYPE)' >&2; exit 4; }\n\t@test -d ghi_opt || { echo 'no ghi_opt' >&2; exit 3; }\n\tprintf '#!/bin/bash\\nexit 0\\n' > ghidra_opt; chmod +x ghidra_opt\n" +
          "sleigh_opt:\n\t@test -z '$(ARCH_TYPE)' || exit 4\n\t@test -d sla_opt || exit 3\n\tprintf '#!/bin/bash\\nexit 0\\n' > sleigh_opt; chmod +x sleigh_opt\n" +
          "clean:\n\trm -f *.o\n"
    );
  }
  const zip = path.join(work, "ghidra.zip");
  execFileSync("python3", [
    "-I",
    "-c",
    `
import os, sys, zipfile
root, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for d, _, files in os.walk(root):
        for f in files:
            p = os.path.join(d, f)
            i = zipfile.ZipInfo(os.path.relpath(p, root))
            i.external_attr = (os.stat(p).st_mode & 0o777) << 16
            z.writestr(i, open(p, "rb").read())
`,
    path.join(work, "tree"),
    zip,
  ]);
  return { url: `file://${zip}`, sha: sha256(zip) };
}

/** A Temurin-like tarball (single top directory with bin/java and bin/javac). */
function fakeJdkTarball() {
  const work = tmp("rea-jdktar-");
  const top = path.join(work, "src", "jdk-21.0.12.1+1");
  fs.mkdirSync(path.join(top, "bin"), { recursive: true });
  const src = fakeJdk(21);
  for (const f of ["java", "javac"]) fs.copyFileSync(path.join(src, "bin", f), path.join(top, "bin", f)), fs.chmodSync(path.join(top, "bin", f), 0o755);
  const tar = path.join(work, "jdk.tar.gz");
  execFileSync("tar", ["-czf", tar, "-C", path.join(work, "src"), "jdk-21.0.12.1+1"]);
  return { url: `file://${tar}`, sha: sha256(tar) };
}

const home = () => tmp("rea-ghome-");
const gdir = (h) => path.join(h, ".local", "share", "sparkdash", "ghidra", GHIDRA_VERSION);
const rec = (h) => path.join(h, ".config", "sparkdash", "ghidra-install");
const kv = (text) => Object.fromEntries(text.split("\n").filter((l) => /^[A-Za-z0-9_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
const envFor = (zip, extra = {}) => ({ SPARKDASH_REA_GHIDRA_URL: zip.url, SPARKDASH_REA_GHIDRA_SHA256: zip.sha, ...extra });

/** A PATH of /usr/bin symlinks without the named tools, so "this unit has no g++" is real on a dev host. */
function binWithout(re) {
  const dir = tmp("rea-bin-");
  for (const f of fs.readdirSync("/usr/bin")) {
    if (re.test(f)) continue;
    try {
      fs.symlinkSync(path.join("/usr/bin", f), path.join(dir, f));
    } catch {}
  }
  return dir;
}

test("pins: checksums and sizes are well formed", () => {
  assert.equal(GHIDRA_VERSION, "12.1.4");
  assert.match(GHIDRA_RECORD, /\.config\/sparkdash\/ghidra-install$/);
  for (const k of ["aarch64", "x64"]) {
    assert.match(JDK_PIN[k].sha256, /^[0-9a-f]{64}$/);
    assert.match(JDK_PIN[k].url, /^https:\/\/github\.com\/adoptium\/temurin21-binaries\/releases\/download\//);
    assert.ok(JDK_PIN[k].bytes > 100_000_000);
  }
});

test("install: unpacks a verified Ghidra, uses the unit's JDK 21, passes the smoke test and writes the record", async () => {
  const h = home();
  const jdk = fakeJdk(21);
  const zip = fakeGhidraZip();
  const r = await exec(buildGhidraInstallProgram({ nonce: NONCE }), { home: h, env: envFor(zip, { JAVA_HOME: jdk }) });
  assert.equal(exitOf(r.out), 0, r.out);
  assert.ok(fs.existsSync(path.join(gdir(h), "support", "analyzeHeadless")));
  assert.ok(!fs.existsSync(`${gdir(h)}.staging`));
  // exec bits survive the unpack
  fs.accessSync(path.join(gdir(h), "support", "analyzeHeadless"), fs.constants.X_OK);
  fs.accessSync(path.join(gdir(h), "Ghidra", "Features", "Decompiler", "os", NATIVE, "decompile"), fs.constants.X_OK);
  const record = kv(fs.readFileSync(rec(h), "utf8"));
  assert.equal(record.VERSION, GHIDRA_VERSION);
  assert.equal(record.GHIDRA_INSTALL_DIR, gdir(h));
  assert.equal(record.JAVA_HOME, jdk);
  assert.equal(record.JAVA_MAJOR, "21");
  assert.equal(fs.statSync(rec(h)).mode & 0o777, 0o600);
  // the smoke test ran Ghidra with exactly that JDK and install dir, in a throwaway project
  const seen = kv(fs.readFileSync(path.join(h, "headless.env"), "utf8"));
  assert.equal(seen.JAVA_HOME, jdk);
  assert.equal(seen.GHIDRA_INSTALL_DIR, gdir(h));
  assert.match(seen.ARGS, /-import .* -noanalysis -deleteProject/);
  assert.match(r.out, /Ghidra imported a test program/);
  assert.match(r.out, /installed: Ghidra 12\.1\.4/);
  // no JDK was downloaded: the unit's own was used
  assert.ok(!fs.existsSync(path.join(h, ".local", "share", "sparkdash", "jdk", "temurin-21-aarch64")));
});

test("install: a second run re-verifies without downloading", async () => {
  const h = home();
  const jdk = fakeJdk(21);
  const zip = fakeGhidraZip();
  assert.equal(exitOf((await exec(buildGhidraInstallProgram({ nonce: NONCE }), { home: h, env: envFor(zip, { JAVA_HOME: jdk }) })).out), 0);
  const again = await exec(buildGhidraInstallProgram({ nonce: NONCE }), { home: h, env: { JAVA_HOME: jdk } });
  assert.equal(exitOf(again.out), 0, again.out);
  assert.match(again.out, /already unpacked/);
  assert.doesNotMatch(again.out, /downloading/);
});

test("install: no JDK on the unit -> the pinned Temurin is downloaded, verified and used", async () => {
  const h = home();
  const zip = fakeGhidraZip();
  const jdk = fakeJdkTarball();
  const r = await exec(buildGhidraInstallProgram({ nonce: NONCE }), {
    home: h,
    env: envFor(zip, { SPARKDASH_REA_JDK_URL: jdk.url, SPARKDASH_REA_JDK_SHA256: jdk.sha }),
  });
  assert.equal(exitOf(r.out), 0, r.out);
  assert.match(r.out, /installing Temurin/);
  const record = kv(fs.readFileSync(rec(h), "utf8"));
  assert.match(record.JAVA_HOME, /\/\.local\/share\/sparkdash\/jdk\/temurin-21-(aarch64|x64)$/);
  fs.accessSync(path.join(record.JAVA_HOME, "bin", "java"), fs.constants.X_OK);
  assert.equal(kv(fs.readFileSync(path.join(h, "headless.env"), "utf8")).JAVA_HOME, record.JAVA_HOME);
  assert.deepEqual(fs.readdirSync(path.join(h, ".local", "share", "sparkdash", "jdk")).filter((n) => n.startsWith(".staging")), []);
});

test("install: a JDK that is too old, not 64-bit or without javac is not used", async () => {
  const h = home();
  const zip = fakeGhidraZip();
  const jdk = fakeJdkTarball();
  const old = fakeJdk(8);
  // a directory of JDKs (like /usr/lib/jvm) holding only one that has no javac
  const jvm = tmp("rea-jvm-");
  const nojavac = path.join(jvm, "jdk-21-jre");
  fs.cpSync(fakeJdk(21, { javac: false }), nojavac, { recursive: true });
  const r = await exec(buildGhidraInstallProgram({ nonce: NONCE }), {
    home: h,
    env: envFor(zip, { JAVA_HOME: old, SPARKDASH_REA_JDK_DIRS: jvm, SPARKDASH_REA_JDK_URL: jdk.url, SPARKDASH_REA_JDK_SHA256: jdk.sha }),
  });
  assert.equal(exitOf(r.out), 0, r.out);
  assert.match(r.out, /No JDK 21 or newer was found/);
  assert.doesNotMatch(kv(fs.readFileSync(rec(h), "utf8")).JAVA_HOME, new RegExp(`${old}|${nojavac}`));
});

test("install: a Ghidra download that fails the pinned checksum is refused and cleaned up", async () => {
  const h = home();
  const zip = fakeGhidraZip();
  const r = await exec(buildGhidraInstallProgram({ nonce: NONCE }), { home: h, env: { SPARKDASH_REA_GHIDRA_URL: zip.url, JAVA_HOME: fakeJdk(21) } });
  assert.equal(exitOf(r.out), 4, r.out);
  assert.match(r.out, /pinned checksum/);
  assert.ok(!fs.existsSync(gdir(h)));
  assert.ok(!fs.existsSync(`${gdir(h)}.staging`));
  assert.ok(!fs.existsSync(rec(h)));
});

test("install: a Ghidra download that cannot be fetched -> 3", async () => {
  const h = home();
  const r = await exec(buildGhidraInstallProgram({ nonce: NONCE }), { home: h, env: { JAVA_HOME: fakeJdk(21) } });
  assert.equal(exitOf(r.out), 3, r.out);
  assert.match(r.out, /Could not download Ghidra/);
  assert.ok(!fs.existsSync(`${gdir(h)}.staging`));
});

test("install: a release of another version is refused", async () => {
  const h = home();
  const zip = fakeGhidraZip({ version: "11.3.1" });
  const r = await exec(buildGhidraInstallProgram({ nonce: NONCE }), { home: h, env: envFor(zip, { JAVA_HOME: fakeJdk(21) }) });
  assert.equal(exitOf(r.out), 6, r.out);
  assert.match(r.out, /not version 12\.1\.4/);
  assert.ok(!fs.existsSync(gdir(h)));
  assert.ok(!fs.existsSync(rec(h)));
});

test("install: a failed headless smoke test -> 4, no record, so REA is never pointed at a broken Ghidra", async () => {
  const h = home();
  const zip = fakeGhidraZip({ importOk: false });
  const r = await exec(buildGhidraInstallProgram({ nonce: NONCE }), { home: h, env: envFor(zip, { JAVA_HOME: fakeJdk(21) }) });
  assert.equal(exitOf(r.out), 4, r.out);
  assert.match(r.out, /could not import a test program/);
  assert.ok(!fs.existsSync(rec(h)));
});

test("install: no native decompiler in the release -> built from the bundled sources", async () => {
  const h = home();
  const zip = fakeGhidraZip({ native: false });
  const r = await exec(buildGhidraInstallProgram({ nonce: NONCE }), { home: h, env: envFor(zip, { JAVA_HOME: fakeJdk(21) }) });
  assert.equal(exitOf(r.out), 0, r.out);
  assert.match(r.out, /building Ghidra's native decompiler/);
  const nd = path.join(gdir(h), "Ghidra", "Features", "Decompiler", "os", NATIVE);
  fs.accessSync(path.join(nd, "decompile"), fs.constants.X_OK);
  fs.accessSync(path.join(nd, "sleigh"), fs.constants.X_OK);
  // build outputs do not stay behind in the source tree
  const cpp = path.join(gdir(h), "Ghidra", "Features", "Decompiler", "src", "decompile", "cpp");
  assert.ok(!fs.existsSync(path.join(cpp, "ghidra_opt")));
  assert.ok(fs.readdirSync(path.join(h, ".local", "share", "sparkdash", "ghidra")).every((n) => !n.startsWith("build-")));
});

test("install: a failing decompiler build -> 6 with the compiler output, no record", async () => {
  const h = home();
  const zip = fakeGhidraZip({ native: false, makeFails: true });
  const r = await exec(buildGhidraInstallProgram({ nonce: NONCE }), { home: h, env: envFor(zip, { JAVA_HOME: fakeJdk(21) }) });
  assert.equal(exitOf(r.out), 6, r.out);
  assert.match(r.out, /simulated compile failure/);
  assert.match(r.out, /Building Ghidra's decompiler failed/);
  assert.ok(!fs.existsSync(rec(h)));
});

test("install: no compiler on an aarch64 unit -> 5 BEFORE anything is downloaded", { skip: NATIVE !== "linux_arm_64" }, async () => {
  const h = home();
  const zip = fakeGhidraZip({ native: false });
  const r = await exec(buildGhidraInstallProgram({ nonce: NONCE }), {
    home: h,
    env: envFor(zip, { PATH: binWithout(/^(g\+\+|c\+\+|make|gmake|x86_64-linux-gnu-g\+\+.*|aarch64-linux-gnu-g\+\+.*)$/), JAVA_HOME: fakeJdk(21) }),
  });
  assert.equal(exitOf(r.out), 5, r.out);
  assert.match(r.out, /g\+\+ and make are needed/);
  assert.doesNotMatch(r.out, /downloading/);
  assert.ok(!fs.existsSync(`${gdir(h)}.staging`));
});

test("install: no zlib development files on an aarch64 unit -> 5 before anything is downloaded", { skip: NATIVE !== "linux_arm_64" }, async () => {
  const h = home();
  const zip = fakeGhidraZip({ native: false });
  const bin = binWithout(/^g\+\+$/);
  // a g++ that works except it cannot link -lz
  fs.writeFileSync(path.join(bin, "g++"), `#!/bin/bash\nfor a in "$@"; do [ "$a" = -lz ] && { echo "cannot find -lz" >&2; exit 1; }; done\nexec /usr/bin/g++ "$@"\n`, { mode: 0o755 });
  const r = await exec(buildGhidraInstallProgram({ nonce: NONCE }), { home: h, env: envFor(zip, { PATH: bin, JAVA_HOME: fakeJdk(21) }) });
  assert.equal(exitOf(r.out), 5, r.out);
  assert.match(r.out, /zlib's development files/);
  assert.doesNotMatch(r.out, /downloading/);
});

test("install: too little free space is refused with a clear message", async () => {
  // df is stubbed; everything else is real
  const h = home();
  const bin = binWithout(/^df$/);
  fs.writeFileSync(path.join(bin, "df"), `#!/bin/bash\necho 'Filesystem 1024-blocks Used Available Capacity Mounted on'\necho '/dev/x 100 90 1000 99% /'\n`, { mode: 0o755 });
  const r = await exec(buildGhidraInstallProgram({ nonce: NONCE }), { home: h, env: { PATH: bin, JAVA_HOME: fakeJdk(21) } });
  assert.equal(exitOf(r.out), 5, r.out);
  assert.match(r.out, /free in the home directory/);
});

test("status + run: the managed Ghidra is reported and exported to rea; the user's own GHIDRA_INSTALL_DIR wins", async () => {
  const h = home();
  const jdk = fakeJdk(21);
  const zip = fakeGhidraZip();
  assert.equal(exitOf((await exec(buildGhidraInstallProgram({ nonce: NONCE }), { home: h, env: envFor(zip, { JAVA_HOME: jdk }) })).out), 0);

  const st = kv((await exec(buildStatusProgram({ nonce: NONCE, deep: false }), { home: h, env: { SPARKDASH_REA_JDK_DIRS: "" } })).out);
  assert.equal(st.GHIDRA_DIR, gdir(h));
  assert.equal(st.GHIDRA_VERSION, "12.1.4");
  assert.equal(st.GHIDRA_NATIVE, "1");
  assert.equal(st.GHIDRA_JAVA, "21");
  assert.equal(st.GHIDRA_MANAGED, "1");
  assert.equal(st.GHIDRA_PIN, "12.1.4");
  assert.equal(st.GHIDRA_INSTALLABLE, "1");
  assert.equal(st.ENGINE_ghidra, path.join(gdir(h), "support", "analyzeHeadless"));

  // a launcher that records the environment rea would start with
  const launcher = path.join(h, ".local", "bin", "rea-sparkdash");
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, `#!/bin/bash\n{ echo "GHIDRA_INSTALL_DIR=$GHIDRA_INSTALL_DIR"; echo "JAVA_HOME=$JAVA_HOME"; echo "PATH0=\${PATH%%:*}"; } > "$HOME/rea.env"\necho '{"ok":true}'\n`, { mode: 0o755 });
  const prog = (id) =>
    buildRunProgram({ runId: id, argvB64: Buffer.from("inspect-artifact\0--json\0").toString("base64"), pathsB64: "", displayLine: "rea test", timeoutSeconds: 30, resultCapBytes: 100000, nonce: NONCE });
  const r = await exec(prog("rea-20261012-120000-aaaa"), { home: h });
  assert.equal(exitOf(r.out), 0, r.out);
  const seen = kv(fs.readFileSync(path.join(h, "rea.env"), "utf8"));
  assert.equal(seen.GHIDRA_INSTALL_DIR, gdir(h));
  assert.equal(seen.JAVA_HOME, jdk);
  assert.equal(seen.PATH0, path.join(jdk, "bin"));

  // the user's own setting is left alone, JAVA_HOME included
  const r2 = await exec(prog("rea-20261012-120000-bbbb"), { home: h, env: { GHIDRA_INSTALL_DIR: "/opt/my-ghidra", JAVA_HOME: "/opt/my-jdk" } });
  assert.equal(exitOf(r2.out), 0, r2.out);
  const mine = kv(fs.readFileSync(path.join(h, "rea.env"), "utf8"));
  assert.equal(mine.GHIDRA_INSTALL_DIR, "/opt/my-ghidra");
  assert.equal(mine.JAVA_HOME, "/opt/my-jdk");
});

test("status: nothing installed -> empty Ghidra values, installable when the tools are there", async () => {
  const h = home();
  const st = kv((await exec(buildStatusProgram({ nonce: NONCE, deep: false }), { home: h, env: { PATH: `${NODE_DIR}:/usr/local/bin:/usr/bin:/bin` } })).out);
  assert.equal(st.GHIDRA_DIR, "");
  assert.equal(st.GHIDRA_VERSION, "");
  assert.equal(st.GHIDRA_NATIVE, "0");
  assert.equal(st.GHIDRA_MANAGED, "0");
  assert.match(st.GHIDRA_FREE_KIB, /^[0-9]+$/);
  assert.ok(["0", "1"].includes(st.GHIDRA_INSTALLABLE));
});

test("status: a record whose directory is gone is ignored (no stale environment)", async () => {
  const h = home();
  fs.mkdirSync(path.dirname(rec(h)), { recursive: true });
  fs.writeFileSync(rec(h), `GHIDRA_INSTALL_DIR=${path.join(h, "gone")}\nJAVA_HOME=${path.join(h, "gone-jdk")}\n`);
  const st = kv((await exec(buildStatusProgram({ nonce: NONCE, deep: false }), { home: h })).out);
  assert.equal(st.GHIDRA_DIR, "");
  assert.equal(st.GHIDRA_NATIVE, "0");
});

// ── the real thing (opt-in) ─────────────────────────────────────────────────
// SPARKDASH_REA_REAL_GHIDRA_ZIP=<ghidra_12.1.4_PUBLIC_*.zip>  SPARKDASH_REA_REAL_JDK_TAR=<Temurin 21 tar.gz>
// SPARKDASH_REA_REAL_REA_DIR=<dir with node_modules/rea-agents (npm ci of server/rea/pinned)>
// Runs the real install program offline (file:// URLs) in a temp HOME: real unzip, a real decompiler build,
// the real JDK, a real headless import, and then REA's own doctor and a real decompile through Ghidra.
const REAL_ZIP = process.env.SPARKDASH_REA_REAL_GHIDRA_ZIP;
const REAL_JDK = process.env.SPARKDASH_REA_REAL_JDK_TAR;
const REAL_REA = process.env.SPARKDASH_REA_REAL_REA_DIR;

test("REAL: install, doctor and a decompile with the actual Ghidra release and Temurin JDK", { skip: !REAL_ZIP || !REAL_JDK, timeout: 900_000 }, async () => {
  const h = home();
  const r = await exec(buildGhidraInstallProgram({ nonce: NONCE }), {
    home: h,
    timeoutMs: 800_000,
    env: {
      SPARKDASH_REA_GHIDRA_URL: `file://${REAL_ZIP}`,
      SPARKDASH_REA_GHIDRA_SHA256: sha256(REAL_ZIP),
      SPARKDASH_REA_JDK_URL: `file://${REAL_JDK}`,
      SPARKDASH_REA_JDK_SHA256: sha256(REAL_JDK),
    },
  });
  console.log(r.out.split("\n").map((l) => `    | ${l}`).join("\n"));
  assert.equal(exitOf(r.out), 0, r.out);
  const record = kv(fs.readFileSync(rec(h), "utf8"));
  assert.match(record.JAVA_MAJOR, /^21$/);
  const nd = path.join(record.GHIDRA_INSTALL_DIR, "Ghidra", "Features", "Decompiler", "os", NATIVE);
  fs.accessSync(path.join(nd, "decompile"), fs.constants.X_OK);
  if (NATIVE === "linux_arm_64") fs.accessSync(path.join(record.GHIDRA_INSTALL_DIR, "GPL", "DemanglerGnu", "os", NATIVE, "demangler_gnu_v2_41"), fs.constants.X_OK);

  // a small native program to analyze
  const src = path.join(h, "hello.c");
  fs.writeFileSync(src, '#include <stdio.h>\nint add(int a, int b) { return a + b; }\nint main(void) { printf("%d\\n", add(2, 3)); return 0; }\n');
  execFileSync("gcc", ["-O0", "-o", path.join(h, "hello"), src]);

  if (REAL_REA) {
    const env = { ...process.env, HOME: h, GHIDRA_INSTALL_DIR: record.GHIDRA_INSTALL_DIR, JAVA_HOME: record.JAVA_HOME, PATH: `${record.JAVA_HOME}/bin:${process.env.PATH}`, NO_COLOR: "1" };
    const rea = path.join(REAL_REA, "node_modules", "rea-agents", "scripts", "rea.mjs");
    const run = (args, t = 600_000) => spawnSyncText(process.execPath, [rea, ...args], { env, timeout: t });
    const doctor = run(["doctor", "--json"], 120_000);
    const report = JSON.parse(doctor.stdout);
    const gh = (report.scope_checks ?? report.checks ?? []).filter((c) => /ghidra|java|decompiler/i.test(`${c.name} ${c.code ?? ""}`));
    console.log("    | doctor ghidra checks:", JSON.stringify(gh.map((c) => [c.name, c.ok, c.detail ?? c.code])));
    assert.ok(gh.length > 0, "doctor reports ghidra checks");
    assert.ok(gh.every((c) => c.ok), `ghidra checks pass: ${JSON.stringify(gh)}`);
    const dec = run(["decompile", path.join(h, "hello"), "add", "--provider", "ghidra", "--format", "json"]);
    console.log("    | decompile exit", dec.status, dec.stdout.slice(0, 1500), dec.stderr.slice(-800));
    assert.equal(dec.status, 0, dec.stderr);
    assert.match(dec.stdout, /add/);
  }
});

function spawnSyncText(cmd, args, opts) {
  const r = spawnSync(cmd, args, { ...opts, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
