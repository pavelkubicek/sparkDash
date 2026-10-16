import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { ReaStore, isValidRunId, isValidUploadId, newRunId, newUploadId } from "../ReaStore.js";

const made = [];
const tmp = (p) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), p));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const mk = (over = {}) => {
  const dir = tmp("rea-store-");
  const opts = { file: path.join(dir, "runs.json"), resultsDir: path.join(dir, "res"), ...over };
  return { dir, opts, store: new ReaStore(opts) };
};
let n = 0;
const id = () => newRunId(Date.UTC(2026, 9, 12, 12, 0, n++ % 60), () => (n * 7919) / 1e7);
const hash = (c) => c.repeat(64).slice(0, 64);
const mode = (f) => fs.statSync(f).mode & 0o777;

test("ids: run and upload ids are generated in the contract format and validated strictly", () => {
  assert.match(newRunId(Date.UTC(2026, 9, 12, 8, 9, 10), () => 0.5), /^rea-20261012-080910-[a-z0-9]{4}$/);
  assert.match(newUploadId(Date.UTC(2026, 9, 12, 8, 9, 10), () => 0.5), /^up-20261012-080910-[a-z0-9]{6}$/);
  assert.match(newRunId(), /^rea-[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/);
  assert.equal(isValidRunId(newRunId(1, () => 0.999999999)), true);
  assert.equal(isValidUploadId(newUploadId(1, () => 0)), true);
  for (const bad of ["../../etc/passwd", "vh-20261012-080910-abcd", "rea-20261012-080910-ABCD", "rea-20261012-080910-abc", "rea-20261012-080910-abcd/..", "", null, 5, undefined]) {
    assert.equal(isValidRunId(bad), false, String(bad));
  }
  for (const bad of ["up-20261012-080910-abcd", "up-20261012-080910-abcdefg", "rea-20261012-080910-abcd", "up-20261012-080910-ABCDEF", "../up-20261012-080910-abcdef"]) {
    assert.equal(isValidUploadId(bad), false, bad);
  }
  assert.throws(() => mk().store.add({ id: "nope" }), /invalid run id/);
});

test("index: add (newest first), get/list copies, update keeps the id, remove, persistence, private file", () => {
  const { store, opts } = mk();
  const a = id();
  const b = id();
  assert.deepEqual(store.add({ id: a, sparkId: "s1", status: "running" }), []);
  store.add({ id: b, sparkId: "s2", status: "running" });
  assert.deepEqual(store.list().map((r) => r.id), [b, a]);
  assert.deepEqual(store.list({ sparkId: "s1" }).map((r) => r.id), [a]);
  const got = store.get(a);
  got.status = "mutated";
  assert.equal(store.get(a).status, "running", "callers get copies");
  const u = store.update(a, { status: "completed", id: "rea-19990101-000000-zzzz" });
  assert.equal(u.id, a);
  assert.equal(u.status, "completed");
  assert.equal(store.update("rea-20000101-000000-zzzz", { x: 1 }), null);
  assert.equal(mode(opts.file), 0o600);
  const again = new ReaStore(opts);
  assert.deepEqual(again.list().map((r) => [r.id, r.status]), [[b, "running"], [a, "completed"]]);
  assert.equal(again.remove(a), true);
  assert.equal(again.remove(a), false);
  assert.equal(new ReaStore(opts).get(a), null);
});

test("index: a corrupt or foreign file is quarantined and entries with bad ids are dropped", () => {
  const dir = tmp("rea-store-");
  const file = path.join(dir, "runs.json");
  fs.writeFileSync(file, "{not json");
  const s = new ReaStore({ file, resultsDir: path.join(dir, "res") });
  assert.deepEqual(s.list(), []);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("runs.json.corrupt-")));
  const good = id();
  fs.writeFileSync(file, JSON.stringify({ version: 1, runs: [{ id: "../x" }, { id: good, sparkId: "s" }, null, 7] }));
  assert.deepEqual(new ReaStore({ file, resultsDir: path.join(dir, "res") }).list().map((r) => r.id), [good]);
});

test("eviction: more than 100 runs drop the oldest with their bundles and views", () => {
  const { store, opts } = mk();
  const first = id();
  store.add({ id: first, sparkId: "s1" });
  assert.equal(store.saveBundle(first, { r: 1 }), true);
  assert.equal(store.saveView(first, hash("a"), { v: 1 }), true);
  const bundleFile = path.join(opts.resultsDir, `${first}.json.gz`);
  assert.ok(fs.existsSync(bundleFile));
  let evictedAll = [];
  for (let i = 0; i < 100; i += 1) evictedAll = evictedAll.concat(store.add({ id: `rea-20261012-1200${String(i % 60).padStart(2, "0")}-${String(i).padStart(4, "0")}`, sparkId: "s1" }));
  assert.equal(store.list().length, 100);
  assert.deepEqual(evictedAll.map((r) => r.id), [first]);
  assert.equal(store.get(first), null);
  assert.ok(!fs.existsSync(bundleFile));
  assert.equal(store.loadView(first, hash("a")), null);
  assert.ok(!fs.existsSync(path.join(opts.resultsDir, "views", first)));
});

test("bundles: gzip round trip, 0600, unknown run refused, removed with the run and the unit", () => {
  const { store, opts } = mk();
  const a = id();
  const b = id();
  store.add({ id: a, sparkId: "s1" });
  store.add({ id: b, sparkId: "s2" });
  assert.equal(store.saveBundle("rea-20200101-000000-zzzz", {}), false, "unknown run");
  assert.equal(store.saveBundle("../../x", {}), false);
  const body = { result: "x".repeat(10_000), summary: { kind: "generic" } };
  assert.equal(store.saveBundle(a, body), true);
  assert.deepEqual(store.loadBundle(a), body);
  const f = path.join(opts.resultsDir, `${a}.json.gz`);
  assert.equal(mode(f), 0o600);
  assert.ok(fs.statSync(f).size < 1000, "gzip");
  assert.equal(zlib.gunzipSync(fs.readFileSync(f)).length, JSON.stringify(body).length);
  assert.equal(store.loadBundle("rea-20200101-000000-zzzz"), null);
  fs.writeFileSync(f, "garbage");
  assert.equal(store.loadBundle(a), null, "corrupt bundle reads as missing");
  store.saveBundle(b, { b: 1 });
  store.removeSpark("s2");
  assert.equal(store.get(b), null);
  assert.equal(store.loadBundle(b), null);
  assert.equal(store.remove(a), true);
  assert.ok(!fs.existsSync(f));
});

test("views: round trip (text or value), 0600, bad hash and unknown run refused, dropped with the run", () => {
  const { store, opts } = mk();
  const a = id();
  store.add({ id: a, sparkId: "s1" });
  assert.equal(store.saveView(a, hash("a"), { page: [1, 2, 3] }), true);
  assert.equal(store.saveView(a, hash("b"), '{"text":true}'), true);
  assert.deepEqual(store.loadView(a, hash("a")), { page: [1, 2, 3] });
  assert.deepEqual(store.loadView(a, hash("b")), { text: true });
  assert.equal(store.loadView(a, hash("c")), null);
  assert.equal(store.saveView(a, "../etc", {}), false);
  assert.equal(store.saveView(a, "ABC", {}), false);
  assert.equal(store.saveView("rea-20200101-000000-zzzz", hash("a"), {}), false);
  assert.equal(store.loadView("../x", hash("a")), null);
  const f = path.join(opts.resultsDir, "views", a, `${hash("a")}.json.gz`);
  assert.equal(mode(f), 0o600);
  assert.equal(store.remove(a), true);
  assert.ok(!fs.existsSync(path.join(opts.resultsDir, "views", a)));
});

test("views: LRU by access time with a count cap", () => {
  const { store } = mk({ maxViews: 3 });
  const a = id();
  const b = id();
  store.add({ id: a, sparkId: "s1" });
  store.add({ id: b, sparkId: "s1" });
  store.saveView(a, hash("1"), { n: 1 });
  store.saveView(a, hash("2"), { n: 2 });
  store.saveView(b, hash("3"), { n: 3 });
  assert.deepEqual(store.loadView(a, hash("1")), { n: 1 }, "touch the oldest: now the most recent");
  store.saveView(b, hash("4"), { n: 4 });
  assert.equal(store.loadView(a, hash("2")), null, "the least recently used was evicted");
  assert.deepEqual(store.loadView(a, hash("1")), { n: 1 });
  assert.deepEqual(store.loadView(b, hash("3")), { n: 3 });
  assert.deepEqual(store.loadView(b, hash("4")), { n: 4 });
});

test("views: byte cap evicts the oldest; a single view over the cap is not stored", () => {
  const rnd = (k) => ({ blob: Array.from({ length: k }, (_, i) => `${i}-${Math.random().toString(36)}`).join("") });
  const { store } = mk({ maxViewBytes: 3000 });
  const a = id();
  store.add({ id: a, sparkId: "s1" });
  const sizes = [];
  for (let i = 0; i < 4; i += 1) {
    assert.equal(store.saveView(a, hash(String(i)), rnd(150)), true);
    sizes.push(i);
  }
  const alive = sizes.filter((i) => store.loadView(a, hash(String(i))) !== null);
  assert.ok(alive.length < 4, "something was evicted to stay within the byte cap");
  assert.ok(alive.includes(3), "the newest view is kept");
  assert.equal(store.saveView(a, hash("9"), rnd(5000)), false, "a view bigger than the whole cap is refused");
  assert.equal(store.loadView(a, hash("9")), null);
  const total = fs
    .readdirSync(path.join(store.resultsDir, "views", a))
    .reduce((s, f) => s + fs.statSync(path.join(store.resultsDir, "views", a, f)).size, 0);
  assert.ok(total <= 3000);
});
