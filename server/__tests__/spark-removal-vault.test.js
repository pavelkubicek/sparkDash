/**
 * Vault purge on unit removal, end to end on a spawned isolated server: the sudo password
 * remembered for a unit's account lives in the sudo vault shared by the Storage Manager and the
 * Updates page, and it must not outlive the unit. The entry is pre-seeded as a raw file (a blob
 * is only decrypted when actually used, so the has/delete path works with any string); the unit
 * then comes and goes through the API. Config lives in a temp dir (isolatedEnv), never in the
 * real install.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { isolatedConfigEnv } from "./isolatedEnv.js";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("a removed unit takes its remembered sudo password out of the shared vault", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-vault-purge-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const env = isolatedConfigEnv(tmp);
  await writeFile(env.SPARKS_JSON_PATH, '{"sparks":[]}\n');
  const vaultFile = env.STORAGE_SUDO_JSON_PATH;
  await writeFile(vaultFile, `${JSON.stringify({ version: 1, passwords: { "u@purge.lan:22": "ciphertext-that-never-decrypts" } }, null, 2)}\n`);

  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: { ...process.env, ...env, BIND_HOST: "127.0.0.1", PORT: String(port), SPARKDASH_TOKEN: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  await Promise.race([
    new Promise((resolve) => {
      const check = () => (output.includes("server listening") ? resolve() : setTimeout(check, 10));
      check();
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 5_000)),
  ]);
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body) => {
    const res = await fetch(`${base}${p}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, text: await res.text() };
  };

  const added = await call("POST", "/api/sparks", { id: "vault-purge", name: "Vault Purge", ssh: { user: "u", host: "purge.lan", port: 22 } });
  assert.equal(added.status, 200, added.text);

  // The Updates summary sees the entry: one vault instance serves the manager and the storage alike.
  const summary = JSON.parse((await call("GET", "/api/updates/summary")).text);
  assert.equal(summary.sparks.find((s) => s.id === "vault-purge")?.indexAutoRefresh, "stored-password");

  assert.equal((await call("DELETE", "/api/sparks/vault-purge")).status, 200);
  // SudoVault keeps no empty file: the purge of the last entry removes the file itself.
  assert.equal(fs.existsSync(vaultFile), false, "the remembered sudo password did not outlive the unit");
});
