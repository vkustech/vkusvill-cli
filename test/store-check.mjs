// Secrets in the platform's real credential store — macOS Keychain, Windows DPAPI, Linux Secret
// Service — under a throwaway name: the file keeps no secrets, old files migrate, another process
// sees them, forget removes them. Skipped where the platform has no store. node test/store-check.mjs

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const tmp = mkdtempSync(path.join(tmpdir(), "vv-keychain-"));
process.env.VV_CONFIG_DIR = path.join(tmp, "config");
process.env.VV_CACHE_DIR = path.join(tmp, "cache");
// A throwaway Keychain item, never the user's real one
process.env.VV_KEYCHAIN_SERVICE = `vkusvill-cli-test-${randomBytes(4).toString("hex")}`;
delete process.env.VV_SECRETS;
delete process.env.VV_TOKEN;

const auth = await import("../src/auth.js");
const secrets = await import("../src/secrets.js");
if (!secrets.save({ probe: 1 })) { console.log(`credential store: skipped (${secrets.fileHint() ?? "none on this platform"})`); process.exit(0); }
secrets.remove();
console.log(`credential store: ${secrets.storageLabel()}`);
const FILE = path.join(process.env.VV_CONFIG_DIR, "auth.json");
const SECRET = "s3cret with spaces & \"quotes\"; " + randomBytes(8).toString("hex");

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

try {
  test("the secret goes to the Keychain, auth.json keeps none", () => {
    auth.setClient({ clientId: "client-1", clientSecret: SECRET });
    const file = readFileSync(FILE, "utf8");
    assert.ok(!file.includes(SECRET));
    assert.equal(JSON.parse(file).secrets, "store");
    assert.equal(secrets.load().clientSecret, SECRET);
    assert.equal(auth.read().clientSecret, SECRET);
    assert.equal(auth.status().storage, secrets.storageLabel());
  });
  test("another process reads the same secret", () => {
    const code = `const a = await import(${JSON.stringify(new URL("../src/auth.js", import.meta.url).href)}); process.stdout.write(a.read().clientSecret);`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env: process.env, encoding: "utf8" });
    assert.equal(r.stdout, SECRET);
  });
  test("a file from an older version moves its secrets to the Keychain on first read", () => {
    mkdirSync(path.dirname(FILE), { recursive: true });
    writeFileSync(FILE, JSON.stringify({ v: 1, clientId: "client-1", clientSecret: SECRET, accessToken: "at-legacy", refreshToken: "rt-legacy", expiresAt: Date.now() + 1e6 }), { mode: 0o600 });
    const rec = auth.read();
    assert.equal(rec.refreshToken, "rt-legacy");
    const file = readFileSync(FILE, "utf8");
    assert.ok(!file.includes("rt-legacy") && !file.includes(SECRET), "the file no longer has secrets");
    assert.equal(secrets.load().refreshToken, "rt-legacy");
  });
  test("the secret is never on a command line", () => {
    const src = readFileSync(new URL("../src/secrets.js", import.meta.url), "utf8");
    assert.match(src, /run\(SECURITY, \["-i"\], `add-generic-password/);
    assert.ok(!/add-generic-password[^`]*-w /.test(src), "no -w <password> argument");
    assert.match(src, /run\(POWERSHELL, \[\.\.\.PS, dpapi\("Protect"\)\], Buffer\.from\(text/, "DPAPI gets the secret on stdin");
    assert.ok(!/run\("powershell/.test(src), "PowerShell by full path, never looked up in the current folder");
  });
  // forget() revokes first; with no reachable server that part is best effort
  auth._setMetadataForTests({ revocation_endpoint: "http://127.0.0.1:9/revoke", scopes: [] });
  await auth.forget();
  test("forget removes the Keychain item and the file", () => {
    assert.equal(existsSync(FILE), false);
    assert.equal(secrets.load(), null);
  });
} finally {
  secrets.remove();
}

console.log(`\n${passed} passed${process.exitCode ? ", some failed" : ""}`);
process.exit(process.exitCode ?? 0);
