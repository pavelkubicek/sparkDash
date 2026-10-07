import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import { SystemCollector } from "../SystemCollector.js";
import { HOST_PATHS } from "../../config.js";

const c = Object.create(SystemCollector.prototype);
const parse = (raw) => c._parseSensorTemp(raw);
const pick = (candidates) => c._pickCpuTemperature(candidates);
const label = (source) => c._cpuTempSourceLabel(source);

// ─── _getCPUTemperature with mocked sysfs ─────────────────
const SYS = HOST_PATHS.SYS; // /host/sys
const orig = {
  existsSync: fs.existsSync,
  readdirSync: fs.readdirSync,
  readFileSync: fs.readFileSync,
};

/** Restore the real fs methods after each mocked test. */
function restoreFs() {
  fs.existsSync = orig.existsSync;
  fs.readdirSync = orig.readdirSync;
  fs.readFileSync = orig.readFileSync;
}

/**
 * Build a fake hwmon+thermal tree, keyed by path, and mock fs so
 * `_getCPUTemperature()` walks it as if it were the real sysfs.
 *
 * @param {Record<string, string>} names  hwmon dir name -> driver name
 * @param {Record<string, string>} temps  hwmon dir -> { tempN_input: raw }
 * @param {Record<string, number>} zones  thermal_zoneN -> raw millidegrees
 */
function mockSysfs({ names = {}, temps = {}, zones = {} } = {}) {
  const hwmonDirs = Object.keys(names);
  const zoneDirs = Object.keys(zones);

  fs.existsSync = (p) => {
    const str = String(p);
    if (str === `${SYS}/class/hwmon`) return hwmonDirs.length > 0;
    if (str === `${SYS}/class/thermal`) return zoneDirs.length > 0;
    // hwmon name file / temp input, or thermal zone temp file
    for (const dir of hwmonDirs) {
      const base = `${SYS}/class/hwmon/${dir}`;
      if (str === `${base}/name`) return true;
      if (str.startsWith(base + "/")) return true;
    }
    for (const zone of zoneDirs) {
      if (str === `${SYS}/class/thermal/${zone}/temp`) return true;
    }
    return false;
  };

  fs.readdirSync = (p) => {
    if (p === `${SYS}/class/hwmon`) return hwmonDirs;
    if (p === `${SYS}/class/thermal`) return zoneDirs;
    for (const dir of hwmonDirs) {
      const base = `${SYS}/class/hwmon/${dir}`;
      if (p === base) return Object.keys(temps[dir] ?? {}).length ? Object.keys(temps[dir]) : ["temp1_input"];
    }
    return [];
  };

  fs.readFileSync = (p, enc) => {
    const str = String(p);
    for (const dir of hwmonDirs) {
      const base = `${SYS}/class/hwmon/${dir}`;
      if (str === `${base}/name`) return names[dir];
      const m = str.match(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/temp(\\d+)_input$`));
      if (m) {
        const raw = temps[dir]?.[`temp${m[1]}_input`];
        return String(raw ?? 0);
      }
    }
    for (const zone of zoneDirs) {
      if (str === `${SYS}/class/thermal/${zone}/temp`) return String(zones[zone]);
    }
    return "0";
  };
}

test("remote CPU command includes the sensor dump and the RAPL triple", () => {
  const spark = new SystemCollector({ id: "spark-test", kind: "spark" });
  const host = new SystemCollector({ id: "host-test", kind: "host" });
  const sparkCmd = spark._buildRemoteCpuCommand();
  const hostCmd = host._buildRemoteCpuCommand();
  assert.equal(sparkCmd, hostCmd);
  assert.match(sparkCmd, /coretemp\|k10temp\|zenpower\|acpitz/);
  // Every sensor line names itself, so the reader can say which one it used.
  assert.match(sparkCmd, /echo "\$n \$v"/);
  assert.match(sparkCmd, /\$z\/type/);
  assert.match(sparkCmd, /\|\| true$/);
  // stat / cpuinfo / temps / rapl energy / rapl max-range / rapl PL1
  assert.equal((sparkCmd.match(/echo '---'/g) || []).length, 5);
  assert.match(sparkCmd, /powercap\/intel-rapl:0\/energy_uj/);
  assert.match(sparkCmd, /constraint_0_power_limit_uw/);
});

test("remote CPU collection returns temperature for DGX Spark nodes", async () => {
  const collector = new SystemCollector({ id: "spark-test", kind: "spark" });
  const result = await collector._getRemoteCpu(async (spark, command) => {
    assert.equal(spark.id, "spark-test");
    assert.match(command, /coretemp\|k10temp\|zenpower\|acpitz/);
    assert.match(command, /thermal_zone\*/);
    // GB10: the three RAPL sections come back EMPTY — estimate path must survive.
    assert.equal((command.match(/echo '---'/g) || []).length, 5);
    return [
      "cpu 100 0 40 860 0 0 0 0",
      "---",
      "CPU architecture: 8",
      "---",
      "acpitz 70900",
      "---",
      "",
      "---",
      "",
      "---",
      "",
    ].join("\n");
  });

  assert.equal(result.temperature, 70.9);
  assert.equal(result.tdp, 65);
  assert.equal(result.source, "estimate");
  // GB10 exposes no CPU package sensor, and the card must not claim otherwise.
  assert.equal(result.temperatureLabel, "ACPI");
  assert.equal(result.temperatureSource, "acpitz");
});

test("remote CPU collection reports measured RAPL package watts", async () => {
  const collector = new SystemCollector({ id: "x86-test", kind: "host" });
  const now = Date.now();
  let call = 0;
  const exec = async () => {
    call++;
    // 50 mJ elapsed between the two 1s-apart samples → 50 W, PL1 65 W.
    const energy = call === 1 ? 1_000_000_000 : 1_050_000_000;
    return [
      call === 1 ? "cpu 100 0 40 860 0 0 0 0" : "cpu 200 0 80 1720 0 0 0 0",
      "---",
      "model name  : Intel Core i3-10100",
      "---",
      "61000",
      "---",
      String(energy),
      "---",
      "262143328850",
      "---",
      "65000000",
    ].join("\n");
  };
  // Force both samples into a ≥0.5s window via a fake clock.
  const realNow = Date.now;
  Date.now = () => now + (call === 0 ? 0 : call === 1 ? 0 : 1000);
  try {
    const first = await collector._getRemoteCpu(exec);
    assert.equal(first.source, "estimate", "first poll has no baseline window");
    const second = await collector._getRemoteCpu(exec);
    assert.equal(second.source, "rapl");
    assert.equal(second.draw, 50);
    assert.equal(second.tdp, 65, "PL1 from constraint_0_power_limit_uw");
  } finally {
    Date.now = realNow;
  }
});

test("RAPL counter wrap is corrected by max_energy_range", () => {
  const collector = Object.create(SystemCollector.prototype);
  collector.lastRaplReading = { energyUj: 262_141_128_850, maxRangeUj: 262_143_328_850, at: 1_000 };
  const s = collector._raplSample({ energyUj: 1_000_000, maxRangeUj: 262_143_328_850, now: 3_000 });
  // delta = 1e6 − 262_141_128_850 + range = 3_200_000 uJ over 2 s = 1.6 W
  assert.equal(s.watts, 1.6);
});

test("converts millidegrees to Celsius", () => {
  assert.equal(parse("70900"), 70.9);
  assert.equal(parse("69200"), 69.2);
});

test("takes the first plausible reading, not the highest", () => {
  assert.equal(parse("70900\n80000\n62200"), 70.9);
});

test("skips the blank line left by the section split", () => {
  assert.equal(parse("\n69200\n66200\n"), 69.2);
});

test("skips unreadable sensors", () => {
  assert.equal(parse("\n\n64500"), 64.5);
  assert.equal(parse("not-a-number\n64500"), 64.5);
});

test("rejects out-of-range values", () => {
  assert.equal(parse("0"), 0);
  assert.equal(parse("-5000"), 0);
  assert.equal(parse("200000"), 0);
  assert.equal(parse("250000"), 0);
  assert.equal(parse("0\n250000\n70900"), 70.9);
});

test("returns 0 when nothing is reported", () => {
  assert.equal(parse(""), 0);
  assert.equal(parse("\n\n"), 0);
  assert.equal(parse(undefined), 0);
});

test("rounds to one decimal", () => {
  assert.equal(parse("69250"), 69.3);
  assert.equal(parse("69240"), 69.2);
});

test("names what the sensor actually is", () => {
  assert.equal(label("coretemp"), "CPU");
  assert.equal(label("k10temp"), "CPU");
  assert.equal(label("acpitz"), "ACPI");
  assert.equal(label("soc_thermal"), "SoC");
  assert.equal(label("mt7925_phy0"), "mt7925_phy0");
  assert.equal(label(null), null);
});

test("prefers a real CPU sensor wherever it appears, and labels the fallback", () => {
  // The reported bug: the first zone on a GB10 is acpitz, ~15 °C above the die,
  // and the panel called it "CPU". A CPU sensor must win wherever it is found...
  const preferred = pick([
    { source: "acpitz", millidegrees: 44800 },
    { source: "coretemp", millidegrees: 38200 },
  ]);
  assert.deepEqual(preferred, { temperature: 38.2, temperatureLabel: "CPU", temperatureSource: "coretemp" });

  // ...and when there is none, the reading is kept but named honestly.
  const fallback = pick([
    { source: "acpitz", millidegrees: 44800 },
    { source: "acpitz", millidegrees: 43100 },
  ]);
  assert.deepEqual(fallback, { temperature: 44.8, temperatureLabel: "ACPI", temperatureSource: "acpitz" });

  // Unnamed (older command shape) readings still work, unlabelled.
  assert.deepEqual(pick([{ source: null, millidegrees: 70900 }]), {
    temperature: 70.9,
    temperatureLabel: null,
    temperatureSource: null,
  });

  // Implausible values are skipped; nothing readable means 0 with no label.
  assert.deepEqual(pick([{ source: "coretemp", millidegrees: 0 }]), {
    temperature: 0,
    temperatureLabel: null,
    temperatureSource: null,
  });
  assert.deepEqual(pick([]), { temperature: 0, temperatureLabel: null, temperatureSource: null });
});

test("remote sensor dump parsing tolerates both formats", () => {
  assert.deepEqual(c._parseSensorCandidates("acpitz 44800\ncoretemp 38200\n"), [
    { source: "acpitz", millidegrees: 44800 },
    { source: "coretemp", millidegrees: 38200 },
  ]);
  assert.deepEqual(c._parseSensorCandidates("\n70900\n"), [{ source: null, millidegrees: 70900 }]);
  assert.deepEqual(c._parseSensorCandidates(""), []);
});
