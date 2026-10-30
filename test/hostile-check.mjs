// Hostile input: crafted terminal input and pastes, odd server data, a damaged auth.json, a phishing
// cart link, a page that throws while drawing. Local only: temp dirs and a mock server.
// node test/hostile-check.mjs

import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "vv-hostile-"));
process.env.VV_CONFIG_DIR = path.join(tmp, "config");
process.env.VV_CACHE_DIR = path.join(tmp, "cache");
// Never touch the real credential store from tests
process.env.VV_SECRETS = "file";
delete process.env.VV_TOKEN;

const { Input } = await import("../src/term/input.js");
const { cleanDeep, safeUrl } = await import("../src/safe.js");
const { wrap } = await import("../src/term/width.js");

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};
const events = (...chunks) => {
  const out = [];
  const i = new Input({ isTTY: false }, (e) => out.push(e));
  for (const c of chunks) i.feed(c);
  return out;
};
const keys = (evs) => evs.filter((e) => e.type === "key").map((e) => (e.ctrl ? "^" : "") + e.name);

console.log("terminal input");
await test("keys hidden after the end of a paste are not pressed", () => {
  const evs = events("\x1b[200~молоко\x1b[201~\x0bочистить корзину\x1b[B\x1b[B\r");
  assert.deepEqual(keys(evs), []);
  assert.deepEqual(evs.map((e) => e.text), ["молоко"]);
});
await test("pasted text loses control characters", () => {
  const [e] = events("\x1b[200~a\x1b]52;c;eA==\x07b‮c\x1b[201~");
  assert.equal(e.text, "a]52;c;eA==bc");
});
await test("an end marker split across reads still ends the paste", () => {
  const evs = events("\x1b[200~abc\x1b[20", "1~", "x");
  assert.deepEqual(evs.map((e) => e.type === "paste" ? `paste:${e.text}` : e.name), ["paste:abc", "x"]);
});
await test("a huge chunk of plain input is parsed in linear time", () => {
  const t0 = Date.now();
  events("я".repeat(64 * 1024));
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
});
await test("an endless escape sequence is dropped, not buffered forever", () => {
  const t0 = Date.now();
  const evs = events("\x1b[" + "1".repeat(2e6), "x");
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
  assert.ok(keys(evs).includes("x"), "typing works afterwards");
});
await test("terminal replies are not taken for keypresses", () => {
  assert.deepEqual(keys(events("\x1b[?1;2c", "\x1b[>0;10;1c", "\x1b]11;rgb:0000/0000/0000\x07", "\x1bP1+r\x1b\\", "q")), ["q"]);
});
await test("Alt+P is still a key, not the start of a swallowed reply", () => {
  const evs = events("\x1bP", "x");
  assert.deepEqual(evs.map((e) => `${e.alt ? "alt+" : ""}${e.name}`), ["alt+P", "x"]);
});

console.log("server data");
await test("a key that becomes __proto__ after cleaning is dropped", () => {
  const o = cleanDeep(JSON.parse('{"__pro\\u0000to__": {"x": 1}, "ok": 1}'));
  assert.equal(Object.getPrototypeOf(o), Object.prototype);
  assert.deepEqual(Object.keys(o), ["ok"]);
});
await test("very long strings are cut, and wrapping stays fast", () => {
  const o = cleanDeep({ d: "a".repeat(400000) });
  assert.ok(o.d.length <= 10001);
  const t0 = Date.now();
  wrap("a".repeat(400000), 60);
  wrap("слово ".repeat(70000), 60);
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
});
await test("carriage returns cannot overwrite rows in command output", () => {
  assert.equal(cleanDeep("Творог\rПОДДЕЛКА"), "ТворогПОДДЕЛКА");
});
await test("links on non-standard ports are refused", () => {
  assert.equal(safeUrl("https://vkusvill.ru:8443/"), null);
  assert.ok(safeUrl("https://vkusvill.ru/cart/?x=1", "cart"));
  assert.equal(safeUrl("https://yandex.ru/maps/", "cart"), null);
});

console.log("cart link");
const S = { link: "https://pay-vkusvi11.example/pay" };
const server = http.createServer(async (req, res) => {
  for await (const _ of req);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ ok: true, data: { link: S.link } }) }] } }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const api = await import("../src/api.js");
api._setEndpointForTests(`http://127.0.0.1:${server.address().port}/mcp`);
await test("a cart link that is not VkusVill is never shown, copied or turned into a QR code", async () => {
  await assert.rejects(api.cartLink([{ id: 1, q: 1 }]), /не на свой сайт/);
  S.link = "https://vkusvill.ru/cart/share/abc";
  assert.equal((await api.cartLink([{ id: 2, q: 1 }])).link, S.link);
  S.link = "https://vkusvill.ru/" + "x".repeat(3000);
  await assert.rejects(api.cartLink([{ id: 3, q: 1 }]));
});
server.close();

await test("cached photos come back whole; cached answers are cleaned again", async () => {
  await api.diskPut("img", "u", "A".repeat(50000));
  assert.equal((await api.diskGet("img", "u", 60e3)).length, 50000);
  await api.diskPut("api", "k", { name: "x\x1b]52;c;eA==\x07y" });
  assert.equal((await api.diskGet("api", "k", 60e3)).name, "x]52;c;eA==y");
});

console.log("damaged files");
await test("a damaged auth.json does not crash status or sign-in", async () => {
  mkdirSync(process.env.VV_CONFIG_DIR, { recursive: true });
  const auth = await import("../src/auth.js");
  for (const bad of [
    { clientId: "abcd-1234", secrets: "store" },
    { clientId: "abcd-1234", scopes: "catalog.search", scope: { x: 1 }, expiresAt: "soon", redirectUri: "javascript:alert(1)", refreshToken: 42 },
    { clientId: "abcd-1234", scopes: ["(a+)+$"] },
    { clientId: "\x1b]52;c;x\x07" },
  ]) {
    writeFileSync(path.join(process.env.VV_CONFIG_DIR, "auth.json"), JSON.stringify(bad), { mode: 0o600 });
    const st = auth.status();
    const rec = auth.read();
    if (rec) {
      assert.equal(rec.redirectUri.startsWith("http"), true);
      assert.ok(rec.scopes == null || (Array.isArray(rec.scopes) && rec.scopes.every((s) => /^[\w.:-]+$/.test(s))));
      assert.equal(rec.refreshToken, null);
      assert.equal(typeof st.signedIn, "boolean");
    }
  }
});

console.log("drawing");
await test("a page that throws while drawing shows an error instead of ending the session", async () => {
  const { App } = await import("../src/app.js");
  const { VIEWS } = await import("../src/main.js");
  const app = new App({ views: VIEWS, headless: true, size: [100, 30] });
  app.screen.out = { write() {} };
  app.page.draw = () => { throw new TypeError("steps.map is not a function"); };
  app.render();
  assert.match(app.screen.snapshot(), /Не получилось показать/);
  app.page.key = () => { throw new Error("boom"); };
  app.onEvent({ type: "key", name: "x", ch: "x", hot: "x" });
});

console.log(`\n${passed} passed${process.exitCode ? ", some failed" : ""}`);
process.exit(process.exitCode ?? 0);
