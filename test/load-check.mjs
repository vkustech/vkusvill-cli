// The client must never hammer VkusVill: request limits, background share, 429/503 handling with a
// pause shared between running copies, and lists that stop loading pages on their own. Local mock only.
// node test/load-check.mjs

import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "vv-load-"));
process.env.VV_CONFIG_DIR = path.join(tmp, "config");
process.env.VV_CACHE_DIR = path.join(tmp, "cache");
// Never touch the real credential store from tests
process.env.VV_SECRETS = "file";
delete process.env.VV_TOKEN;

// ——— Mock MCP server: answers as told, counts hits ———

const S = { hits: 0, status: 200, retryAfter: null, times: [] };
const server = http.createServer(async (req, res) => {
  for await (const _ of req);
  S.hits++;
  S.times.push(Date.now());
  if (S.status !== 200) {
    res.writeHead(S.status, S.retryAfter != null ? { "Retry-After": String(S.retryAfter) } : {});
    if (S.status === 429 && S.then200) { S.status = 200; S.retryAfter = null; }
    return res.end();
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ ok: true, data: { items: [], meta: {} } }) }] } }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/mcp`;

const api = await import("../src/api.js");
api._setEndpointForTests(base);
const L = api._limitsForTests;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const q = () => `q${++n}`;
// Drops what the previous test left queued and clears the counters and the pause
const fresh = () => { L.reset(); S.hits = 0; S.times = []; S.status = 200; S.retryAfter = null; S.then200 = false; };

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

console.log("request limits");
await test("background work takes at most 30 requests a minute and leaves the rest to the user", async () => {
  fresh();
  for (let i = 0; i < 40; i++) api.search(q(), {}, { prio: "lo" }).catch(() => {});
  await sleep(800);
  assert.equal(S.hits, 30);
  await api.search(q());
  assert.equal(S.hits, 31, "an interactive request still goes through");
});
await test("no more than 55 requests within a minute in total", async () => {
  fresh();
  for (let i = 0; i < 70; i++) api.search(q()).catch(() => {});
  await sleep(1000);
  assert.equal(S.hits, 55);
});
await test("at most 4 requests in flight", async () => {
  fresh();
  let open = 0, peak = 0;
  const slow = http.createServer(async (req, res) => {
    for await (const _ of req);
    open++; peak = Math.max(peak, open);
    await sleep(100);
    open--;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: '{"ok":true,"data":{}}' }] } }));
  });
  await new Promise((r) => slow.listen(0, "127.0.0.1", r));
  api._setEndpointForTests(`http://127.0.0.1:${slow.address().port}/mcp`);
  await Promise.all(Array.from({ length: 12 }, () => api.search(q())));
  api._setEndpointForTests(base);
  slow.close();
  assert.equal(peak, 4);
});

console.log("when VkusVill pushes back");
await test("a 429 waits as long as Retry-After says, then retries", async () => {
  fresh();
  S.status = 429; S.retryAfter = 1; S.then200 = true;
  const t0 = Date.now();
  await api.search(q());
  assert.equal(S.hits, 2);
  assert.ok(S.times[1] - S.times[0] >= 1000, `retried after ${S.times[1] - S.times[0]} ms`);
  assert.ok(Date.now() - t0 < 3000);
});
await test("the pause is shared with other running copies", async () => {
  fresh();
  S.status = 429; S.retryAfter = 2; S.then200 = true;
  const first = api.search(q());
  await sleep(200);
  const until = +readFileSync(path.join(process.env.VV_CACHE_DIR, ".pause"), "utf8");
  assert.ok(until > Date.now() + 1000, "the pause is written for other processes");
  // Another copy of the client: its own module state, the same cache folder
  const other = await import(`../src/api.js?other`);
  other._setEndpointForTests(base);
  const t0 = Date.now();
  await other.search(q());
  assert.ok(Date.now() - t0 >= 1300, `the other copy waited ${Date.now() - t0} ms`);
  await first;
});
await test("repeated 429s give up after two retries", async () => {
  fresh();
  S.status = 429; S.retryAfter = 1;
  await assert.rejects(api.search(q()), /перегружен/);
  assert.equal(S.hits, 3);
});
await test("a 503 is not retried and pauses everything", async () => {
  fresh();
  S.status = 503; S.retryAfter = 1;
  await assert.rejects(api.search(q()), /перегружен/);
  assert.equal(S.hits, 1);
  S.status = 200;
  const t0 = Date.now();
  await api.search(q());
  assert.ok(Date.now() - t0 >= 700, `the next request waited ${Date.now() - t0} ms`);
});
await test("a long pause fails fast instead of freezing the interface, cached answers still work", async () => {
  fresh();
  const cachedQ = q();
  await api.search(cachedQ);
  S.status = 429; S.retryAfter = 600;
  await assert.rejects(api.search(q()), /паузу/);
  const hits = S.hits;
  const t0 = Date.now();
  await assert.rejects(api.search(q()), /паузу/);
  assert.ok(Date.now() - t0 < 500);
  assert.equal(S.hits, hits, "nothing was sent during the pause");
  await api.search(cachedQ);
});

console.log("lists");
const { ProductBrowser } = await import("../src/views/browser.js");
await test("a filter that matches nothing does not walk the whole catalog", async () => {
  fresh();
  let pages = 0;
  const app = { invalidate() {}, compare: new Set(), toast() {} };
  const b = new ProductBrowser(app, {
    loader: async (page) => { pages++; return { items: Array.from({ length: 10 }, (_, i) => ({ id: page * 100 + i, name: "x", price: 1 })), hasMore: true, total: 9999 }; },
  });
  b.filters = new Set(["sale"]); // nothing on sale
  await b.loadMore();
  for (let i = 0; i < 50; i++) { b.tick(); await sleep(5); }
  assert.equal(pages, 11, `${pages} pages`);
  b.list.sel = 1; // the user moves: a few more pages are fine
  for (let i = 0; i < 50; i++) { b.tick(); await sleep(5); }
  assert.ok(pages <= 21);
});
await test("an empty page ends the list", async () => {
  let pages = 0;
  const b = new ProductBrowser({ invalidate() {}, compare: new Set() }, { loader: async () => { pages++; return { items: [], hasMore: true }; } });
  await b.loadMore();
  for (let i = 0; i < 20; i++) { b.tick(); await sleep(5); }
  assert.equal(pages, 1);
  assert.equal(b.hasMore, false);
});

server.close();
console.log(`\n${passed} passed${process.exitCode ? ", some failed" : ""}`);
process.exit(process.exitCode ?? 0);
