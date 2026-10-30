// Client for the official VkusVill MCP server (https://mcp.vkusvill.ru/mcp): JSON-RPC tools/call,
// a disk cache, a polite priority queue (see below) and the user's OAuth token (auth.js).

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, stat, readdir, unlink, utimes, chmod } from "node:fs/promises";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, chmodSync } from "node:fs";
import path from "node:path";
import { clean, cleanDeep, readCapped, safeUrl } from "./safe.js";
import { CACHE_DIR, ownDir } from "./paths.js";
import { USER_AGENT } from "./version.js";
import * as auth from "./auth.js";

let ENDPOINT = process.env.VV_ENDPOINT ?? "https://mcp.vkusvill.ru/mcp";
// The token is only ever sent to the official server, even when VV_ENDPOINT points elsewhere
let OFFICIAL = (() => {
  try { const u = new URL(ENDPOINT); return u.protocol === "https:" && u.hostname === "mcp.vkusvill.ru"; } catch { return false; }
})();

// For tests only: a local mock server that is trusted with the token
export function _setEndpointForTests(url) { ENDPOINT = url; OFFICIAL = true; }

// Tools that only work for a signed-in user
const PERSONAL = new Set(["vkusvill_orders_history", "vkusvill_product_lp", "vkusvill_discounts_personal"]);
// Scopes known to gate a tool. Only certain pairs: elsewhere the server's answer decides
const TOOL_SCOPE = { vkusvill_products_search: "catalog.search", vkusvill_orders_history: "purchase_history.read" };

const scopeError = (tool) => {
  const need = TOOL_SCOPE[tool];
  return new VVError(need
    ? `Клиенту не выдано «${auth.scopeLabel(need)}» — отметьте это действие в настройках клиента на vkusvill.ru, затем vv login --scope all`
    : "Клиенту не хватает прав для этого — проверьте действия в настройках клиента на vkusvill.ru, затем vv login --scope all", "scope");
};

const MAX_RESPONSE = 20 * 1024 * 1024;
const MEM_LIMIT = 400;
const DAY = 24 * 3600e3;

export { CACHE_DIR };

const TTL = { default: 6 * 3600e3, vkusvill_shops: 7 * DAY, vkusvill_recipes: DAY, vkusvill_products_discount: 3600e3 };
// Personal data and one-off links never touch the disk
const NO_CACHE = new Set(["vkusvill_cart_link_create", "vkusvill_orders_history", "vkusvill_product_lp", "vkusvill_discounts_personal"]);

const mem = new Map();
const inflight = new Map();
export const stats = { requests: 0, cacheHits: 0, active: 0, queued: 0, lastError: null };

// ——— Disk cache ———

function keyFile(kind, key) {
  return path.join(CACHE_DIR, kind, createHash("sha1").update(key).digest("hex").slice(0, 20) + ".json");
}

// The cache is used only from a folder of this user: in a shared XDG_CACHE_HOME another user could
// plant answers or symlinks. Otherwise everything still works, just without a disk cache
let cacheOwn = null;
function cacheUsable() {
  if (cacheOwn === null) { try { ownDir(CACHE_DIR); chmodSync(CACHE_DIR, 0o700); cacheOwn = true; } catch { cacheOwn = false; } }
  return cacheOwn;
}

export async function diskGet(kind, key, ttl) {
  if (!cacheUsable()) return undefined;
  try {
    const f = keyFile(kind, key);
    if (Date.now() - (await stat(f)).mtimeMs > ttl) return undefined;
    const v = JSON.parse(await readFile(f, "utf8"));
    // Answers are cleaned again, as if they came from the network; a photo is bytes in base64,
    // checked by the decoder, and must not be cut like a long string
    return kind === "img" ? (typeof v === "string" ? v : undefined) : cleanDeep(v);
  } catch {
    return undefined;
  }
}

export async function diskPut(kind, key, value) {
  if (!cacheUsable()) return;
  try {
    const f = keyFile(kind, key);
    await mkdir(path.dirname(f), { recursive: true, mode: 0o700 });
    await writeFile(f, JSON.stringify(value), { mode: 0o600 });
  } catch {}
}

// Removes expired entries and keeps the cache under a size cap; runs at most once a day
const PRUNE = { api: 8 * DAY, img: 31 * DAY };
const CACHE_CAP = 300 * 1024 * 1024;
export async function pruneCache() {
  // Older versions created the folder world-readable
  try { await chmod(CACHE_DIR, 0o700); } catch {}
  const marker = path.join(CACHE_DIR, ".pruned");
  try { if (Date.now() - (await stat(marker)).mtimeMs < DAY) return; } catch {}
  const files = [];
  for (const [kind, maxAge] of Object.entries(PRUNE)) {
    const dir = path.join(CACHE_DIR, kind);
    let names = [];
    try { names = await readdir(dir); } catch { continue; }
    for (const name of names) {
      const f = path.join(dir, name);
      try {
        const st = await stat(f);
        if (Date.now() - st.mtimeMs > maxAge) await unlink(f);
        else files.push({ f, size: st.size, t: st.mtimeMs });
      } catch {}
    }
  }
  let total = files.reduce((s, x) => s + x.size, 0);
  for (const x of files.sort((a, b) => a.t - b.t)) {
    if (total <= CACHE_CAP) break;
    try { await unlink(x.f); total -= x.size; } catch {}
  }
  try {
    await mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
    await writeFile(marker, "", { mode: 0o600 });
    await utimes(marker, new Date(), new Date());
  } catch {}
}

// ——— Request queue ———
// Interactive requests (hi) go before background ones (lo); at most 4 in flight. Within any sliding
// minute: at most 55 requests, of which background work may take 30, so it never crowds out the user.
// A 429 pauses every request of every running copy (the pause is shared through a file) for as long
// as the server asked; retries count against the same limits.

const LIMIT = { hi: 55, lo: 30 };
const MAX_PAUSE_WAIT = 60e3; // longer pauses fail fast instead of freezing the interface
const queue = { hi: [], lo: [] };
const sent = [];
let running = 0;
let pumpTimer = null;
let onChange = () => {};
export function onActivity(fn) { onChange = fn; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAUSE_FILE = () => path.join(CACHE_DIR, ".pause");
let pausedUntil = 0, pauseReadAt = 0;

// The moment before which nothing may be sent: this process's pause or one set by another copy
function pauseEnd(now = Date.now()) {
  if (now - pauseReadAt > 1000) {
    pauseReadAt = now;
    try { pausedUntil = Math.max(pausedUntil, +readFileSync(PAUSE_FILE(), "utf8") || 0); } catch {}
  }
  return pausedUntil;
}

function pause(ms) {
  const until = Date.now() + ms;
  if (until <= pausedUntil) return;
  pausedUntil = until;
  try { mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 }); writeFileSync(PAUSE_FILE(), String(until), { mode: 0o600 }); } catch {}
}

// Retry-After in seconds or as an HTTP date; without one, 2 s, 4 s, 8 s…
function retryAfter(res, attempt) {
  const h = res.headers.get("retry-after");
  const s = h == null ? NaN : /^\d+$/.test(h.trim()) ? +h * 1000 : Date.parse(h) - Date.now();
  return Math.min(3600e3, Math.max(1000, Number.isFinite(s) ? s : 2000 * 2 ** attempt));
}

// How long a request of this priority has to wait: 0 means it may go now
function wait(prio) {
  const now = Date.now();
  while (sent.length && now - sent[0] > 60e3) sent.shift();
  const limit = LIMIT[prio];
  const window = sent.length >= limit ? sent[sent.length - limit] + 60e3 - now : 0;
  return Math.max(0, pauseEnd(now) - now, window);
}

const pauseError = (ms) => new VVError(`ВкусВилл просит сделать паузу — попробуйте через ${Math.ceil(ms / 60e3)} мин`, "rate");

function pump() {
  clearTimeout(pumpTimer);
  while (running < 4) {
    const prio = queue.hi.length ? "hi" : queue.lo.length ? "lo" : null;
    if (!prio) break;
    const w = wait(prio);
    if (w > MAX_PAUSE_WAIT && pauseEnd() > Date.now()) {
      // A long pause: tell the user now rather than keep the request hanging
      for (const job of queue.hi.splice(0).concat(queue.lo.splice(0))) job.reject(pauseError(w));
      break;
    }
    // Background work has the stricter limit, so when the head of the queue waits, everything does
    if (w > 0) { pumpTimer = setTimeout(pump, w + 50); pumpTimer.unref?.(); break; }
    const job = queue[prio].shift();
    sent.push(Date.now());
    running++;
    stats.active = running;
    onChange();
    job.run().finally(() => { running--; stats.active = running; onChange(); pump(); });
  }
  stats.queued = queue.hi.length + queue.lo.length;
}

function enqueue(fn, prio) {
  return new Promise((resolve, reject) => {
    queue[prio === "lo" ? "lo" : "hi"].push({ run: () => fn().then(resolve, reject), reject });
    pump();
  });
}

// A further request from inside a running job (a retry): waits for the limits like any other
async function slot() {
  for (;;) {
    const w = wait("hi");
    if (w <= 0) { sent.push(Date.now()); return; }
    if (w > MAX_PAUSE_WAIT) throw pauseError(w);
    await sleep(w + 50);
  }
}

export const _limitsForTests = { LIMIT, sent, queue, reset() { for (const job of queue.hi.splice(0).concat(queue.lo.splice(0))) job.reject(new VVError("reset", "test")); sent.length = 0; pausedUntil = 0; pauseReadAt = 0; try { unlinkSync(PAUSE_FILE()); } catch {} } };

// ——— Calls ———

export class VVError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function parseJSON(text, what) {
  try { return JSON.parse(text); } catch { throw new VVError(`ВкусВилл прислал некорректный ${what}`, "rpc"); }
}

async function post(body, token) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "User-Agent": USER_AGENT };
  if (token && OFFICIAL) headers.Authorization = `Bearer ${token}`;
  try {
    // No redirects: one would carry the bearer token elsewhere
    return await fetch(ENDPOINT, { method: "POST", headers, body, signal: AbortSignal.timeout(20e3), redirect: "error" });
  } catch (e) {
    if (e?.name === "TimeoutError") throw new VVError("ВкусВилл не ответил за 20 секунд", "net");
    throw new VVError("Нет связи с ВкусВиллом", "net");
  }
}

const signInHint = (e) => (e?.code === "invalid_grant" ? "Вход истек — vv login или Профиль → войти" : e?.message ?? "Нужен вход: vv login или Профиль → войти");

// Personal tools need a token; public ones use it when there is one (personalised results)
// and quietly fall back to anonymous access when signing in fails
async function tokenFor(tool) {
  if (!OFFICIAL) {
    if (PERSONAL.has(tool)) throw new VVError("Вход работает только с mcp.vkusvill.ru", "auth");
    return null;
  }
  try {
    // A token without the tool's scope is not sent: personal tools say so, public ones go anonymous
    if (TOOL_SCOPE[tool] && !auth.allows(TOOL_SCOPE[tool])) {
      if (PERSONAL.has(tool)) throw scopeError(tool);
      return null;
    }
    const token = await auth.accessToken();
    if (!token && PERSONAL.has(tool)) throw new VVError("Нужен вход: vv login или Профиль → войти", "auth");
    return token;
  } catch (e) {
    if (PERSONAL.has(tool)) throw e instanceof VVError ? e : new VVError(signInHint(e), "auth");
    return null;
  }
}

async function rawCall(tool, args) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: tool, arguments: args } });
  let token = await tokenFor(tool);
  let renewed = false;
  for (let attempt = 0, limited = 0; ; attempt++) {
    // The first request got its slot in the queue; every further one waits for the limits again
    if (attempt) await slot();
    stats.requests++;
    const res = await post(body, token);
    // Too many requests or the server is overloaded: everything pauses for as long as it asks.
    // A 429 is retried up to twice; a 503 is not retried at all
    if (res.status === 429 || res.status === 503) {
      pause(retryAfter(res, limited));
      if (res.status === 429 && ++limited <= 2) continue;
      throw new VVError("ВкусВилл перегружен — попробуйте чуть позже", "rate");
    }
    // Missing rights are not an expired token: no refresh, and public tools simply retry anonymously
    const insufficient = res.status === 403 || /insufficient_scope/i.test(res.headers.get("www-authenticate") ?? "");
    if (insufficient && token) {
      if (PERSONAL.has(tool)) throw scopeError(tool);
      token = null;
      continue;
    }
    if (res.status === 401) {
      // The token was refused: renew it once (another process may already have), then give up
      if (token && !renewed && !process.env.VV_TOKEN) {
        renewed = true;
        try { token = await auth.refresh({ rejected: token }); continue; } catch (e) {
          if (PERSONAL.has(tool)) throw new VVError(signInHint(e), "auth");
          token = null;
          continue;
        }
      }
      throw new VVError(token ? "ВкусВилл не принял вход — vv login" : "Нужен вход: vv login или Профиль → войти", "auth");
    }
    if (!res.ok) throw new VVError(`ВкусВилл ответил ${res.status}`, "http");
    const raw = await readCapped(res, MAX_RESPONSE);
    if (!raw) throw new VVError("Слишком большой ответ", "http");
    let text = raw.toString("utf8");
    // The server may answer with an SSE stream: take the last data event
    if (text.startsWith("event:") || text.startsWith("data:")) {
      const datas = text.split("\n").filter((l) => l.startsWith("data:"));
      text = datas.at(-1)?.slice(5) ?? "{}";
    }
    const env = parseJSON(text, "ответ");
    if (env.error) throw new VVError(clean(env.error.message).slice(0, 200), "rpc");
    const content = env.result?.content?.[0]?.text ?? "{}";
    const payload = parseJSON(content, "ответ инструмента");
    if (env.result?.isError || payload.ok === false) {
      const msg = clean(payload.error?.message ?? content).slice(0, 200);
      const code = String(payload.error?.code ?? "");
      if (token && /scope|forbidden|permission/i.test(`${code} ${msg}`)) {
        if (PERSONAL.has(tool)) throw scopeError(tool);
        token = null;
        continue;
      }
      throw new VVError(msg, /auth|token|jwt|unauthor/i.test(msg) ? "auth" : code || "rpc");
    }
    // Everything downstream — the UI, command output, the cache — gets strings with control characters removed.
    // `personal` says whether the token actually went out: that, not a guess made before queueing, decides the cache
    return { data: cleanDeep(payload.data ?? payload), personal: !!token };
  }
}

// LRU in memory: old responses are evicted
function remember(key, value) {
  mem.delete(key);
  mem.set(key, value);
  while (mem.size > MEM_LIMIT) mem.delete(mem.keys().next().value);
}

// Whether this call will carry the user's token: then the answer is personal (stock at the user's
// address, recommendations) and must not be mixed with anonymous answers in the cache
function personal(tool) {
  if (!OFFICIAL || PERSONAL.has(tool)) return OFFICIAL;
  const st = auth.cachedStatus();
  return st.signedIn && (!TOOL_SCOPE[tool] || auth.allows(TOOL_SCOPE[tool]));
}

const PERSONAL_TTL = 10 * 60e3; // stock changes quickly

export async function call(tool, args = {}, { prio = "hi", fresh = false } = {}) {
  const own = personal(tool);
  const key = JSON.stringify([tool, args, own ? "user" : "anon"]);
  const cacheable = !NO_CACHE.has(tool);
  if (cacheable && !fresh && mem.has(key)) {
    const v = mem.get(key);
    if (!own || Date.now() - v.at < PERSONAL_TTL) { stats.cacheHits++; remember(key, v); return v.data; }
  }
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    const ttl = TTL[tool] ?? TTL.default;
    // Personal answers live in memory only; the disk holds anonymous ones
    if (cacheable && !fresh && !own) {
      const hit = await diskGet("api", key, ttl);
      if (hit !== undefined) { stats.cacheHits++; remember(key, { data: hit, at: Date.now() }); return hit; }
    }
    const { data, personal: sent } = await enqueue(() => rawCall(tool, args), prio);
    if (cacheable) {
      // A sign-in or sign-out may have happened while the request waited in the queue
      const sentKey = JSON.stringify([tool, args, sent ? "user" : "anon"]);
      remember(sentKey, { data, at: Date.now() });
      if (!sent && !data?.meta?.personalized) diskPut("api", sentKey, data);
    }
    return data;
  })();
  inflight.set(key, p);
  p.then(() => { stats.lastError = null; }, (e) => { stats.lastError = e.message; }).finally(() => inflight.delete(key));
  return p;
}

// ——— Tool wrappers ———

export const search = (q, { page = 1, sort = "popularity", category = 0, vvonly = 1 } = {}, o) =>
  call("vkusvill_products_search", { q, page, limit: 10, sort, category_id: category, vvonly, mode: "full" }, o);

export const details = (id, o) => call("vkusvill_product_details", { id: +id }, o);
export const barcode = (code) => call("vkusvill_product_barcode", { barcode: code });
export const analogs = (id) => call("vkusvill_product_analogs", { id: +id });
export const discounts = ({ type = "card", page = 1, sort = "popularity", vvonly = 1 } = {}, o) =>
  call("vkusvill_products_discount", { type, page, sort, vvonly }, o);
// The link becomes a QR code that people scan to pay, is printed and copied: it must be a VkusVill
// address, checked here once for every way it is used
export async function cartLink(products) {
  const d = await call("vkusvill_cart_link_create", { products });
  const link = typeof (d?.link ?? d?.url) === "string" && (d.link ?? d.url).length <= 2000 ? safeUrl(d.link ?? d.url, "cart") : null;
  if (!link) throw new VVError("ВкусВилл вернул ссылку не на свой сайт — не показываю ее", "rpc");
  return { ...d, link };
}
export const shops = ({ page = 1, region = 0, city = 0, subway = 0, feature = 0 } = {}, o) =>
  call("vkusvill_shops", { page, id_region_filter: region, id_city_filter: city, id_subway_filter: subway, id_feature_filter: feature }, o);
export const recipes = ({ q = "", page = 1, sort = "popularity", feature = 0, time = 0, method = 0, complexity = 0, category = 0, allergens = [] } = {}, o) =>
  call("vkusvill_recipes", {
    q, page, sort,
    id_feature_filter: feature, id_cooking_time_filter: time, id_cooking_method_filter: method,
    id_complexity_filter: complexity, id_category_filter: category, id_exclude_allergens_filter: allergens,
  }, o);
export const orders = (page = 1) => call("vkusvill_orders_history", { page });
export const favoriteProduct = () => call("vkusvill_product_lp", {});
export const personalDiscounts = () => call("vkusvill_discounts_personal", {});
