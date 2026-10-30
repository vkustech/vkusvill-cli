// Smoke test of the package as users get it: the packed tarball, installed globally, run through its bin.
// Offline: nothing is sent to VkusVill.
// npm install -g ./vkusvill-*.tgz && node test/smoke.mjs "$(npm root -g)/vkusvill"

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const dir = realpathSync(path.resolve(process.argv[2] ?? "."));
const { version } = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));

const tmp = mkdtempSync(path.join(tmpdir(), "vv-smoke-"));
const env = { ...process.env, VV_CONFIG_DIR: path.join(tmp, "config"), VV_CACHE_DIR: path.join(tmp, "cache"), VV_SECRETS: "file", NO_COLOR: "1" };
delete env.VV_TOKEN;
// The shim npm put on PATH; on Windows it is vkusvill.cmd, which only runs through a shell. The arguments are constants.
const vv = (...args) => spawnSync("vkusvill", args, { env, encoding: "utf8", shell: process.platform === "win32", timeout: 30e3 });

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

console.log(`vkusvill ${version} on Node ${process.versions.node}, ${process.platform}`);

await test("--version prints the package version", () => {
  const r = vv("--version");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), version);
});
await test("--help prints the commands", () => {
  const r = vv("--help");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`vkusvill ${version.replaceAll(".", "\\.")}`));
  assert.match(r.stdout, /vv search/);
});

// The bundled dependencies must come from inside the package, not from anything installed around it
const require = createRequire(path.join(dir, "src", "image.js"));
const inside = (file) => assert.ok(file.startsWith(dir + path.sep), `${file} is outside ${dir}`);

await test("the QR code library is bundled and draws a code", async () => {
  inside(require.resolve("qrcode-generator"));
  const { G } = await import(pathToFileURL(path.join(dir, "src", "ui", "draw.js")).href);
  assert.ok(G.qrSize("https://vkusvill.ru/").w > 20);
});
await test("the WebP decoder is bundled and its wasm decodes a photo", async () => {
  const js = require.resolve("@jsquash/webp/decode.js");
  const wasm = require.resolve("@jsquash/webp/codec/dec/webp_dec.wasm");
  inside(js);
  inside(wasm);
  const mod = await import(pathToFileURL(js).href);
  await mod.init(await WebAssembly.compile(readFileSync(wasm)));
  // 2×2 lossless WebP: red, green, blue, white
  const img = await mod.default(Buffer.from("UklGRiwAAABXRUJQVlA4TB8AAAAvAUAAAB8gEEjeHzqN+RcQFPwf3fxHZA/gBgwR/Q8BAA==", "base64"));
  assert.equal(img.width, 2);
  assert.deepEqual([...img.data.slice(0, 4)], [255, 0, 0, 255]);
});

console.log(`\n${passed} passed${process.exitCode ? ", some failed" : ""}`);
