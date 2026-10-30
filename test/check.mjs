// Offline checks for the safety and persistence guarantees: no network, temp dirs only.
// node test/check.mjs

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tmp = mkdtempSync(path.join(tmpdir(), "vv-check-"));
process.env.VV_CONFIG_DIR = path.join(tmp, "config");
// Never touch the real credential store from tests
process.env.VV_SECRETS = "file";
process.env.VV_CACHE_DIR = path.join(tmp, "cache");

const { clean, cleanDeep, safeUrl } = await import("../src/safe.js");
const { Screen } = await import("../src/term/screen.js");
const { wrap } = await import("../src/term/width.js");
const { Input } = await import("../src/term/input.js");

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

console.log("terminal safety");
await test("control characters and bidi overrides are stripped from network text", () => {
  const evil = "Творог\x1b]52;c;ZXZpbA==\x07\x9b2J‮лавиа⁦​﻿";
  assert.equal(clean(evil), "Творог]52;c;ZXZpbA==2Jлавиа");
  const deep = cleanDeep({ items: [{ name: "a\x1b[31mb", props: [{ value: "\x9bx" }] }], __proto__x: 1 });
  assert.equal(deep.items[0].name, "a[31mb");
  assert.equal(deep.items[0].props[0].value, "x");
});
await test("prototype keys from JSON are dropped", () => {
  const out = cleanDeep(JSON.parse('{"__proto__": {"polluted": 1}, "constructor": 2, "ok": 3}'));
  assert.equal(({}).polluted, undefined);
  assert.deepEqual(Object.keys(out), ["ok"]);
});
await test("the screen never emits ESC or C1 from cell text", () => {
  let written = "";
  const s = new Screen({ columns: 40, rows: 2, write: (x) => { written += x; } });
  s.clear();
  s.put(0, 0, "a\x1bb\x9bc‮d\x07e");
  s.flush();
  const text = written.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  assert.ok(!/[\x1b\x07\x9b‮]/.test(text), JSON.stringify(text));
  assert.ok(text.includes("abcde"));
});
await test("wrap() terminates on zero width and wide glyphs", () => {
  assert.ok(wrap("слово", 0).length > 0);
  assert.deepEqual(wrap("漢字", 1), ["漢", "字"]);
});
await test("bracketed paste is capped", () => {
  let got = null;
  const i = new Input({ isTTY: false }, (e) => { if (e.type === "paste") got = e.text; });
  i.feed("\x1b[200~" + "x".repeat(200_000) + "\x1b[201~");
  assert.equal(got.length, 64 * 1024);
});

console.log("links");
await test("only https VkusVill and Yandex links open", () => {
  assert.ok(safeUrl("https://vkusvill.ru/goods/x-1/"));
  assert.ok(safeUrl("https://img.vkusvill.ru/a.webp", "image"));
  assert.ok(safeUrl("https://yandex.ru/maps/?pt=1,2"));
  for (const bad of ["https://yandex.ru/redir?url=https://evil.example", "https://clck.yandex.ru/x", "https://yandex.ru/maps", "file:///Applications/Calculator.app", "http://vkusvill.ru/", "https://vkusvill.ru.evil.com/", "https://evilvkusvill.ru/", "https://user:pw@vkusvill.ru/", "javascript:alert(1)", "https://vkusvill.ru&calc"])
    assert.equal(safeUrl(bad), null, bad);
  assert.equal(safeUrl("https://yandex.ru/x.webp", "image"), null);
});
await test("the Windows opener does not go through cmd", () => {
  const src = readFileSync(new URL("../src/sys.js", import.meta.url), "utf8");
  assert.ok(!/["']cmd["']/.test(src));
});

console.log("downloads");
await test("bodies are cut off at the cap while streaming, with or without Content-Length", async () => {
  const { readCapped } = await import("../src/safe.js");
  const stream = (n) => new Response(new ReadableStream({ start(c) { for (let i = 0; i < n; i++) c.enqueue(new Uint8Array(1024)); c.close(); } }));
  assert.equal((await readCapped(stream(4), 8 * 1024)).length, 4096);
  assert.equal(await readCapped(stream(64), 8 * 1024), null);
  assert.equal(await readCapped(new Response("x", { headers: { "content-length": "999999999" } }), 1024), null);
});
await test("an oversized WebP is refused from its header, before decoding", async () => {
  const { webpSize } = await import("../src/image.js");
  const vp8x = Buffer.alloc(30);
  vp8x.write("RIFF", 0, "latin1"); vp8x.write("WEBP", 8, "latin1"); vp8x.write("VP8X", 12, "latin1");
  vp8x.writeUIntLE(16382, 24, 3); vp8x.writeUIntLE(16382, 27, 3);
  assert.deepEqual(webpSize(vp8x), { w: 16383, h: 16383 });
  assert.equal(webpSize(Buffer.from("GIF89a" + "x".repeat(40))), null);
});

console.log("state file");
const file = path.join(process.env.VV_CONFIG_DIR, "state.json");
const freshStore = async () => (await import(`../src/store.js?${Math.random()}`)).store;

await test("a damaged state file is kept aside, not overwritten", async () => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(process.env.VV_CONFIG_DIR, { recursive: true });
  writeFileSync(file, '{"cart": [ broken');
  const store = await freshStore();
  assert.ok(store.warning?.includes("broken-"));
  assert.ok(readdirSync(process.env.VV_CONFIG_DIR).some((f) => f.startsWith("state.json.broken-")));
  assert.equal(store.cart.length, 0);
});
await test("hand-edited state is validated and clamped", async () => {
  const p = { id: 27695, name: "Творог\x1b[31m", price: 112 };
  writeFileSync(file, JSON.stringify({
    cart: [{ p, q: 99 }, { p: { ...p, id: 2 }, q: "abc" }, { p: { id: -1, name: "x", price: 1 }, q: 1 }, { p: { ...p, id: 3 }, q: 0.001 }],
    favs: [p, "junk", null], queries: ["творог", 42, "x".repeat(500)], prefs: [],
  }));
  const store = await freshStore();
  assert.equal(store.cart.length, 2);
  assert.equal(store.cart[0].q, 40);
  assert.equal(store.cart[1].q, 0.01);
  assert.equal(store.cart[0].p.name, "Творог[31m");
  assert.equal(store.favs.length, 1);
  assert.deepEqual(store.queries, ["творог"]);
  assert.deepEqual(store.prefs, {});
});
await test("NaN and zero quantities never reach the cart", async () => {
  const store = await freshStore();
  const n = store.count;
  assert.equal(store.add({ id: 5, name: "x", price: 1 }, NaN), false);
  assert.equal(store.add({ id: 5, name: "x", price: 1 }, 0), false);
  assert.equal(store.count, n);
});
await test("state is written atomically and readable by the owner only", async () => {
  const store = await freshStore();
  store.add({ id: 7, name: "Кефир", price: 95 }, 1);
  store.saveNow();
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(process.env.VV_CONFIG_DIR).mode & 0o077, 0);
  }
  assert.ok(!readdirSync(process.env.VV_CONFIG_DIR).some((f) => f.endsWith(".tmp")));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).v, 2);
});
await test("a running app picks up `vv cart add` from another process", async () => {
  const store = await freshStore();
  store.watch();
  const before = store.count;
  const other = await freshStore();
  other.add({ id: 8, name: "Хлеб", price: 60 }, 1);
  other.saveNow();
  await new Promise((r) => setTimeout(r, 2500));
  store.unwatch();
  assert.equal(store.count, before + 1);
});

console.log("credentials without a store");
await test("secrets kept in the file are marked, and a read does not rewrite them", async () => {
  const authMod = await import("../src/auth.js");
  const file = path.join(process.env.VV_CONFIG_DIR, "auth.json");
  writeFileSync(file, JSON.stringify({ v: 1, clientId: "client-1", clientSecret: "s", refreshToken: "r", accessToken: "a", expiresAt: Date.now() + 1e6 }), { mode: 0o600 });
  const rec = authMod.read();
  assert.equal(rec.refreshToken, "r");
  const once = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(once.secrets, "file", "an old file is marked after the one migration attempt");
  const before = statSync(file).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  authMod.read();
  assert.equal(statSync(file).mtimeMs, before, "later reads leave the file alone");
  assert.equal(authMod.status().storage, "файл auth.json (только для вас)");
  assert.match(authMod.status().storageHint, /VV_SECRETS/);
});

console.log("command line");
const vv = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL("../bin/vv.js", import.meta.url)), ...args], { encoding: "utf8", env: process.env });
await test("bad quantities and flags are refused before any request", () => {
  assert.notEqual(vv("cart", "add", "abc").status, 0);
  assert.notEqual(vv("search", "x", "--page", "0").status, 0);
  assert.notEqual(vv("search", "x", "--sort", "evil").status, 0);
  assert.notEqual(vv("--nope").status, 0);
  // The secret is never taken from arguments: they show in `ps` and shell history
  assert.notEqual(vv("login", "--client-id", "x", "--client-secret", "s").status, 0);
});
await test("flag values do not leak into the search query", async () => {
  const src = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
  assert.ok(src.includes("VALUE_FLAGS"));
});

console.log(`\n${passed} passed${process.exitCode ? ", some failed" : ""}`);
process.exit(process.exitCode ?? 0);
