// Signing in to VkusVill: OAuth 2.0 authorization code + PKCE, refresh, revocation.
//
// VkusVill has no dynamic client registration: every user registers a personal client
// (vkusvill.ru/oauth/registration/) and gets its credentials by email. So the client id comes
// from the user once, and is kept next to the tokens.
//
// - The authorization server is discovered from the MCP server (RFC 9728 → RFC 8414) and must be
//   an https VkusVill host; nothing is ever sent elsewhere.
// - The code comes back to a one-shot loopback listener on 127.0.0.1, or is pasted by hand
//   (for clients registered without a redirect URI).
// - Access tokens live 24 h. Refresh tokens rotate on every use and reusing an old one revokes the
//   whole chain, so refreshes are serialised across processes (the TUI and `vv` in another
//   terminal) with a lock file, and the token file is re-read under the lock.
// - The client secret and the tokens go to the OS credential store (secrets.js): the macOS Keychain
//   or the Linux Secret Service. auth.json (owner-only) keeps the rest and a revision number, so
//   other processes know when to read the store again. Without a store, the secrets stay in auth.json.

import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync, chmodSync } from "node:fs";
import path from "node:path";
import { CONFIG_DIR, writePrivate } from "./paths.js";
import { clean, readCapped } from "./safe.js";
import * as secrets from "./secrets.js";
import { USER_AGENT } from "./version.js";

// What VkusVill's registration form assigns when "my service has no public URI" is ticked
export const DEFAULT_REDIRECT = "http://localhost:3000/callback";
export const REGISTRATION_URL = "https://vkusvill.ru/oauth/registration/";
const MCP_ORIGIN = "https://mcp.vkusvill.ru";
const FILE = path.join(CONFIG_DIR, "auth.json");
const LOCK = path.join(CONFIG_DIR, "auth.lock");
const EARLY = 120e3;          // refresh this long before expiry
const LOGIN_TIMEOUT = 5 * 60e3;

// Known-good metadata, used when discovery is unreachable
const FALLBACK = {
  issuer: "https://oauth.vkusvill.ru/",
  authorization_endpoint: "https://oauth.vkusvill.ru/oauth2/auth",
  token_endpoint: "https://oauth.vkusvill.ru/oauth2/token",
  revocation_endpoint: "https://oauth.vkusvill.ru/oauth2/revoke",
  scopes: ["catalog.search", "purchase_history.read", "discounts.view", "recommendations.personalized"],
};

// Rights a client can be given, named as in VkusVill's registration form
export const SCOPE_LABELS = {
  "catalog.search": "Каталог: поиск с учетом адреса и рекомендаций",
  "purchase_history.read": "История покупок",
  "discounts.view": "Лояльность и скидки",
  "recommendations.personalized": "Персональные рекомендации",
  offline_access: "Продление входа",
};
export const scopeLabel = (s) => SCOPE_LABELS[s] ?? s;

export class AuthError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const isVkusvillHttps = (u) => { try { const x = new URL(u); return x.protocol === "https:" && (x.hostname === "vkusvill.ru" || x.hostname.endsWith(".vkusvill.ru")); } catch { return false; } };

// ——— Discovery ———

let metaOverride = null;
let metaCache = null;

// For tests only: point the flow at a local mock server
export function _setMetadataForTests(meta) { metaOverride = meta; metaCache = null; }

const JSON_MAX = 256 * 1024;
// JSON from VkusVill's auth servers: no redirects (one could lead to plain http), size capped
async function getJSON(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10e3), headers: { Accept: "application/json", "User-Agent": USER_AGENT }, redirect: "error" });
  if (!res.ok) throw new Error(`${res.status}`);
  const raw = await readCapped(res, JSON_MAX);
  if (!raw) throw new Error("too large");
  return JSON.parse(raw.toString("utf8"));
}

export async function metadata() {
  if (metaOverride) return metaOverride;
  if (metaCache) return metaCache;
  try {
    const pr = await getJSON(`${MCP_ORIGIN}/.well-known/oauth-protected-resource`);
    const issuer = pr.authorization_servers?.[0];
    if (!isVkusvillHttps(issuer)) throw new Error("issuer");
    const as = await getJSON(new URL(".well-known/oauth-authorization-server", issuer.endsWith("/") ? issuer : issuer + "/"));
    // Endpoints must live on the issuer's own host: the secret is sent there, and any other
    // subdomain of vkusvill.ru is not trusted with it
    const endpoints = [as.authorization_endpoint, as.token_endpoint, as.revocation_endpoint].filter(Boolean);
    const sameOrigin = (u) => { try { return new URL(u).origin === new URL(issuer).origin; } catch { return false; } };
    if (as.issuer !== issuer || !as.authorization_endpoint || !as.token_endpoint || !endpoints.every((u) => isVkusvillHttps(u) && sameOrigin(u))) throw new Error("metadata");
    const scopes = Array.isArray(pr.scopes_supported) ? pr.scopes_supported.filter(isScope) : [];
    metaCache = { issuer, authorization_endpoint: as.authorization_endpoint, token_endpoint: as.token_endpoint, revocation_endpoint: as.revocation_endpoint, scopes: scopes.length ? scopes : FALLBACK.scopes };
  } catch {
    metaCache = FALLBACK;
  }
  return metaCache;
}

// ——— Storage ———

const SECRET_FIELDS = ["clientSecret", "accessToken", "refreshToken"];
let vaultMemo = null; // { rev, data }: the store is asked again only when auth.json changes

const isScope = (s) => typeof s === "string" && /^[\w.:-]{1,64}$/.test(s);
const scopeList = (s) => (typeof s === "string" ? s.split(/\s+/).filter(isScope).join(" ") : "");
// A redirect is either https or plain http to this very machine
const isRedirect = (u) => { try { const x = new URL(u); return x.protocol === "https:" || (x.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(x.hostname)); } catch { return false; } };

// auth.json is ours, but it may be damaged or hand-edited: every field is checked before use
function sane(r) {
  if (!r || typeof r !== "object" || typeof r.clientId !== "string" || !/^[\w.:-]{4,200}$/.test(r.clientId)) return null;
  const out = { ...r };
  for (const k of SECRET_FIELDS) if (typeof out[k] !== "string" || !out[k]) out[k] = null;
  out.expiresAt = Number.isFinite(out.expiresAt) ? out.expiresAt : 0;
  out.scope = scopeList(out.scope);
  if (out.scopes != null && !(Array.isArray(out.scopes) && out.scopes.every(isScope))) out.scopes = null;
  if (!isRedirect(out.redirectUri)) out.redirectUri = DEFAULT_REDIRECT;
  if (typeof out.rev !== "string") out.rev = "";
  return out;
}

export function read() {
  let r;
  try { r = sane(JSON.parse(readFileSync(FILE, "utf8"))); } catch { return null; }
  if (!r) return null;
  if (r.secrets !== "store") {
    // A file from before the store existed: move its secrets over once. A file marked "file" already
    // tried; the next write (sign-in, refresh) tries the store again, so a store set up later is picked up
    if (r.secrets === undefined && SECRET_FIELDS.some((k) => r[k])) { const moved = write(r); if (moved.secrets === "store") return { ...moved, ...pickSecrets(r) }; }
    return r;
  }
  if (!vaultMemo || vaultMemo.rev !== r.rev) vaultMemo = { rev: r.rev, data: secrets.load() ?? {} };
  return { ...r, ...pickSecrets(vaultMemo.data) };
}

const pickSecrets = (o) => Object.fromEntries(SECRET_FIELDS.map((k) => [k, typeof o?.[k] === "string" && o[k] ? o[k] : null]));

// Writes metadata to auth.json and the secrets to the store when it takes them; returns what is in the file
function write(rec) {
  memo = null;
  const meta = Object.fromEntries(Object.entries(rec).filter(([k]) => !SECRET_FIELDS.includes(k) && k !== "secrets" && k !== "rev"));
  const rev = `${Date.now().toString(36)}.${randomBytes(4).toString("hex")}`;
  const secretPart = pickSecrets(rec);
  let file;
  if (secrets.save(secretPart)) {
    file = { ...meta, secrets: "store", rev };
    vaultMemo = { rev, data: secretPart };
  } else {
    file = { ...meta, ...secretPart, secrets: "file" };
  }
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writePrivate(tmp, JSON.stringify(file, null, 2) + "\n");
  renameSync(tmp, FILE);
  try { chmodSync(FILE, 0o600); chmodSync(CONFIG_DIR, 0o700); } catch {}
  return file;
}

// Cross-process lock: exclusive create, holding "pid token". It is taken over only from a process
// that is gone, or after 2 minutes (longer than any refresh: discovery, token request, keychain).
// Taking it from a live, slow refresh would reuse its refresh token, and VkusVill would revoke the chain
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

async function withLock(fn) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const mine = `${process.pid} ${randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + 15e3;
  for (;;) {
    try {
      const fd = openSync(LOCK, "wx", 0o600);
      writeFileSync(fd, mine);
      closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const pid = parseInt(readFileSync(LOCK, "utf8"), 10);
        if ((pid > 0 && !alive(pid)) || Date.now() - statSync(LOCK).mtimeMs > 120e3) unlinkSync(LOCK);
      } catch {}
      if (Date.now() > deadline) throw new AuthError("Вход занят другим процессом vkusvill", "lock");
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  try { return await fn(); } finally {
    try { if (readFileSync(LOCK, "utf8") === mine) unlinkSync(LOCK); } catch {}
  }
}

// ——— Token endpoint ———

async function tokenRequest(meta, rec, params) {
  const body = new URLSearchParams({ ...params, client_id: rec.clientId });
  if (rec.clientSecret) body.set("client_secret", rec.clientSecret);
  let res;
  try {
    res = await fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": USER_AGENT },
      body,
      signal: AbortSignal.timeout(20e3),
      // A redirect would resend the client secret to wherever it points
      redirect: "error",
    });
  } catch {
    throw new AuthError("Нет связи с сервером входа ВкусВилла", "net");
  }
  let data = {};
  try { const raw = await readCapped(res, JSON_MAX); if (raw) data = JSON.parse(raw.toString("utf8")) ?? {}; } catch {}
  if (!res.ok || !data.access_token) {
    const code = typeof data.error === "string" && /^[a-z_]{1,64}$/.test(data.error) ? data.error : `http_${res.status}`;
    throw new AuthError(describe(code), code);
  }
  return data;
}

function describe(code) {
  return {
    invalid_grant: "Вход истек — войдите заново",
    invalid_client: "ВкусВилл не узнал клиента — проверьте client_id и секрет",
    unauthorized_client: "Клиенту не разрешен этот способ входа",
    invalid_scope: "Клиенту не выданы запрошенные права",
    access_denied: "Вход отменен",
  }[code] ?? `Сервер входа ответил: ${code}`;
}

// `fresh`: a new sign-in replaces the whole grant; a refresh without a new refresh token keeps the old one
function store(rec, data, { fresh = false } = {}) {
  const out = {
    ...rec,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? (fresh ? null : rec.refreshToken ?? null),
    expiresAt: Date.now() + (Number(data.expires_in) > 0 ? Number(data.expires_in) * 1000 : 24 * 3600e3),
    scope: typeof data.scope === "string" ? scopeList(data.scope) : rec.scope ?? "",
  };
  write(out);
  return out;
}

// ——— Public API ———

// For the UI, which asks on every frame: re-read at most once a second (other processes may sign in)
let memo = null;
export function cachedStatus() {
  if (!memo || Date.now() - memo.at > 1000) memo = { at: Date.now(), value: status() };
  return memo.value;
}

export function status() {
  if (process.env.VV_TOKEN) return { signedIn: true, viaEnv: true };
  const rec = read();
  if (!rec) return { signedIn: false, configured: false };
  const live = !!rec.accessToken && rec.expiresAt > Date.now();
  return {
    signedIn: live || !!rec.refreshToken,
    configured: true,
    clientId: rec.clientId,
    expiresAt: rec.expiresAt ?? null,
    refreshable: !!rec.refreshToken,
    scope: rec.scope ?? "",
    storage: rec.secrets === "store" ? secrets.storageLabel() : "файл auth.json (только для вас)",
    storageHint: rec.secrets === "store" ? null : secrets.refused() ? "хранилище не ответило (заблокировано?) — секреты пока в auth.json, переедут при следующем обновлении" : secrets.fileHint(),
    // Where to look: the store's item or file for the secrets, auth.json for everything else
    secretsAt: rec.secrets === "store" ? secrets.location() : FILE,
    metaAt: FILE,
    granted: granted(rec),
    // The store exists but refused the last write: the secrets sit in auth.json for now
    storeRefused: rec.secrets !== "store" && secrets.refused(),
  };
}

// Scopes the current token was granted; null when unknown (a ready-made VV_TOKEN, or not said)
export function granted(rec = read()) {
  if (process.env.VV_TOKEN || !rec?.accessToken && !rec?.refreshToken) return null;
  const s = (rec.scope ?? "").trim();
  return s ? s.split(/\s+/) : null;
}

// Whether the signed-in token may use `scope`; unknown grants are given the benefit of the doubt
export function allows(scope) {
  const g = granted();
  return !g || g.includes(scope);
}

// Saves (or replaces) the client the user registered at VkusVill; signs out of the previous one
export function setClient({ clientId, clientSecret, redirectUri, scopes }) {
  if (!/^[\w.:-]{4,200}$/.test(clientId ?? "")) throw new AuthError("client_id выглядит неправильно", "input");
  if (redirectUri && !isRedirect(redirectUri)) throw new AuthError("Адрес возврата — https или http://localhost", "input");
  if (scopes != null && !(Array.isArray(scopes) && scopes.every(isScope))) throw new AuthError("Права указаны неправильно", "input");
  const prev = read();
  const same = prev?.clientId === clientId;
  write({
    v: 1,
    clientId,
    clientSecret: clientSecret || (same ? prev.clientSecret : null) || null,
    redirectUri: redirectUri || (same ? prev.redirectUri : null) || DEFAULT_REDIRECT,
    // Scopes to ask for; null means everything the server offers, trimmed on the first refusal
    scopes: scopes !== undefined ? scopes : same ? prev.scopes ?? null : null,
    ...(same ? { accessToken: prev.accessToken, refreshToken: prev.refreshToken, expiresAt: prev.expiresAt, scope: prev.scope } : {}),
  });
}

let inflight = null;

// A valid access token, refreshed if needed; null when not signed in
export async function accessToken() {
  if (process.env.VV_TOKEN) return process.env.VV_TOKEN;
  const rec = read();
  if (!rec?.accessToken && !rec?.refreshToken) return null;
  if (rec.accessToken && rec.expiresAt - EARLY > Date.now()) return rec.accessToken;
  if (!rec.refreshToken) return null;
  return refresh();
}

// `rejected` is a token the server just refused: refresh even if it looks fresh,
// unless another process has already replaced it
export function refresh({ rejected } = {}) {
  inflight ??= withLock(async () => {
    const rec = read();
    if (!rec?.refreshToken) throw new AuthError("Вход истек — войдите заново", "invalid_grant");
    const fresh = rec.accessToken && rec.expiresAt - EARLY > Date.now();
    if (fresh && rec.accessToken !== rejected) return rec.accessToken;
    const meta = await metadata();
    try {
      return store(rec, await tokenRequest(meta, rec, { grant_type: "refresh_token", refresh_token: rec.refreshToken })).accessToken;
    } catch (e) {
      // A dead refresh token stays dead: forget the tokens, keep the client for the next sign-in
      if (e.code === "invalid_grant" || e.code === "invalid_client") write({ ...rec, accessToken: null, refreshToken: null, expiresAt: null });
      throw e;
    }
  }).finally(() => { inflight = null; });
  return inflight;
}

// Parses what the user pasted: the whole redirect URL, a query string, or the bare code.
// A URL or a query must carry our state, errors included: any web page can call the loopback
// address, and without the check it could cancel the sign-in or strip rights from it
function parsePasted(text, state) {
  const t = String(text).trim();
  if (!t) return null;
  let params;
  try { params = new URL(t).searchParams; } catch {
    if (!t.includes("=")) return { code: t };
    params = new URLSearchParams(t.replace(/^[?#]/, ""));
  }
  if (params.get("state") !== state) return { error: "state_mismatch" };
  const error = params.get("error");
  if (error) return { error: /^[a-z_]{1,64}$/.test(error) ? error : "server_error", description: clean(params.get("error_description") ?? "").slice(0, 500) };
  const code = params.get("code");
  return code ? { code } : null;
}

const PAGE = (title, text) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font:18px/1.5 system-ui,sans-serif;background:#0b130e;color:#e4eee6;display:grid;place-items:center;height:100vh;margin:0}
main{max-width:28rem;padding:2rem;text-align:center}b{color:#b5e853}</style><main><b>ВкусВилл в терминале</b><h1>${title}</h1><p>${text}</p></main>`;

// One-shot loopback listener for the redirect; resolves with { code } or { error }.
// "localhost" is served on both 127.0.0.1 and ::1: browsers may try either.
function listen(redirectUri, state, signal) {
  const u = new URL(redirectUri);
  const hosts = u.hostname === "localhost" ? ["127.0.0.1", "::1"] : [u.hostname.replace(/^\[|\]$/g, "")];
  const port = Number(u.port) || 80;
  return new Promise((resolve, reject) => {
    const servers = [];
    let listening = 0, failed = 0, lastError = null;
    const closeAll = () => servers.forEach((s) => s.close());
    const handler = (req, res) => {
      // Any page in the browser can send anything here: a target such as "//" must not throw
      let url;
      try { url = new URL(req.url, "http://127.0.0.1"); } catch { res.writeHead(400).end(); return; }
      if (req.method !== "GET" || url.pathname !== u.pathname) { res.writeHead(404).end(); return; }
      const got = parsePasted(url.href, state);
      // Not our redirect (no state, someone else's): refuse it and keep waiting for the real one
      if (!got || got.error === "state_mismatch") { res.writeHead(400).end(); return; }
      const ok = !!got.code;
      res.writeHead(ok || got.error === "invalid_scope" ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(ok ? PAGE("Готово", "Можно закрыть вкладку и вернуться в терминал.")
        : got.error === "invalid_scope" ? PAGE("Еще секунду", "Уточняю права клиента — откроется еще одна вкладка. Эту можно закрыть.")
        : PAGE("Вход не удался", "Вернитесь в терминал — там подробности."));
      closeAll();
      resolve(got);
    };
    for (const host of hosts) {
      const server = http.createServer(handler);
      servers.push(server);
      server.on("listening", () => { listening++; });
      // A missing address family (no IPv6) is fine while another one listens. A taken port is not:
      // half-listening would let whatever holds the other half (a dev server on :3000) receive the code
      server.on("error", (e) => {
        failed++;
        lastError = e;
        const fatal = e.code === "EADDRINUSE" || e.code === "EACCES";
        if (fatal || (failed === hosts.length && !listening)) {
          closeAll();
          reject(new AuthError(e.code === "EADDRINUSE" ? `Порт ${port} занят другой программой`
            : e.code === "EACCES" ? `Порт ${port} нельзя занять без прав администратора` : lastError.message, "listen"));
        }
      });
      server.listen(port, host);
    }
    signal?.addEventListener("abort", closeAll);
  });
}

const isLoopback = (uri) => { try { const u = new URL(uri); return u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname); } catch { return false; } };

// Full sign-in. `open(url)` shows the authorization page; `paste()` (optional) resolves with text
// the user pasted; `notice(text)` reports that the loopback receiver is unavailable. Retries once without offline_access if the client may not have refresh tokens.
// Hydra names the refused scope: …not allowed to request scope "purchase_history.read".
// A quoted name wins; otherwise any requested scope the description mentions.
function refusedScope(description, wanted) {
  const d = description ?? "";
  const quoted = /scope\s+["'“«]([\w.:-]+)["'”»]/i.exec(d)?.[1];
  if (quoted && wanted.includes(quoted)) return quoted;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return wanted.filter(isScope).find((s) => new RegExp(`(^|[^\\w.])${esc(s)}([^\\w.]|$)`).test(d)) ?? null;
}

export async function login({ open, paste, signal, scope, notice = () => {} } = {}) {
  const rec = read();
  if (!rec?.clientId) throw new AuthError("Сначала укажите client_id своего клиента ВкусВилла", "no_client");
  const meta = await metadata();
  // Rights differ per client: start from what was asked last time (or everything) and drop
  // each scope the server refuses, so a client with fewer boxes ticked still signs in
  let wanted = scope ? scope.split(/\s+/) : ["offline_access", ...(rec.scopes ?? meta.scopes)];
  for (let attempt = 0; attempt <= wanted.length + 1; attempt++) {
    const verifier = b64url(randomBytes(48));
    const state = b64url(randomBytes(16));
    const auth = new URL(meta.authorization_endpoint);
    auth.search = new URLSearchParams({
      response_type: "code",
      client_id: rec.clientId,
      redirect_uri: rec.redirectUri,
      scope: wanted.join(" "),
      state,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
    }).toString();

    const ctl = new AbortController();
    const stop = () => ctl.abort();
    signal?.addEventListener("abort", stop);
    // Losers of the race reject after the abort below; mark them handled
    const waiters = [];
    const wait = (p) => { p.catch(() => {}); waiters.push(p); };
    // If the port can't be taken, a paste still finishes the sign-in
    if (isLoopback(rec.redirectUri)) {
      wait(listen(rec.redirectUri, state, ctl.signal).catch((e) => {
        if (!paste) throw e;
        notice(`${e.message} — после входа вставьте адрес из строки браузера`);
        return new Promise(() => {});
      }));
    }
    if (paste) wait(paste(ctl.signal).then((text) => parsePasted(text, state) ?? { error: "no_code" }));
    if (!waiters.length) throw new AuthError("Redirect URI не локальный — нужна вставка ссылки", "no_receiver");
    wait(new Promise((_, reject) => {
      const t = setTimeout(() => reject(new AuthError("Не дождался входа за 5 минут", "timeout")), LOGIN_TIMEOUT);
      ctl.signal.addEventListener("abort", () => { clearTimeout(t); reject(new AuthError("Вход отменен", "access_denied")); });
    }));
    open(auth.href);
    let got;
    try { got = await Promise.race(waiters); } finally { ctl.abort(); signal?.removeEventListener("abort", stop); }

    if (got.error === "invalid_scope") {
      const refused = refusedScope(got.description, wanted);
      // Unnamed refusal: refresh rights are the usual suspect, then give up
      const drop = refused && wanted.includes(refused) ? refused : wanted.includes("offline_access") ? "offline_access" : null;
      if (!drop) throw new AuthError(describe("invalid_scope"), "invalid_scope");
      wanted = wanted.filter((s) => s !== drop);
      if (!wanted.some((s) => s !== "offline_access")) throw new AuthError("Клиенту не выдано ни одного права — отметьте действия в настройках клиента на vkusvill.ru", "invalid_scope");
      notice(`Клиенту не выдано «${scopeLabel(drop)}» — продолжаю без этого`);
      continue;
    }
    if (got.error) throw new AuthError(got.error === "state_mismatch" ? "Ответ не от этой попытки входа" : describe(got.error), got.error);
    const data = await tokenRequest(meta, rec, { grant_type: "authorization_code", code: got.code, redirect_uri: rec.redirectUri, code_verifier: verifier });
    const scopes = wanted.filter((s) => s !== "offline_access");
    // The server says what it granted; without that, assume what was asked
    if (typeof data.scope !== "string") data.scope = wanted.join(" ");
    return withLock(async () => store({ ...(read() ?? rec), scopes }, data, { fresh: true }));
  }
  throw new AuthError(describe("invalid_scope"), "invalid_scope");
}

// Signs out and removes every trace of the client: tokens, secret, auth.json
export async function forget() {
  const r = await logout().catch(() => null);
  secrets.remove();
  vaultMemo = null;
  memo = null;
  try { unlinkSync(FILE); } catch {}
  return r;
}

// Revokes both tokens at VkusVill (best effort) and forgets them locally either way; the client stays.
// Returns null when there was nothing to sign out of, otherwise { revoked } — whether VkusVill confirmed.
// Under the lock: a refresh in another process must not write tokens back after the sign-out
export async function logout() {
  return withLock(async () => {
    const rec = read();
    if (!rec?.accessToken && !rec?.refreshToken) return null;
    const meta = await metadata();
    let revoked = !!meta.revocation_endpoint;
    if (meta.revocation_endpoint) {
      for (const [token, hint] of [[rec.refreshToken, "refresh_token"], [rec.accessToken, "access_token"]]) {
        if (!token) continue;
        const body = new URLSearchParams({ token, token_type_hint: hint, client_id: rec.clientId });
        if (rec.clientSecret) body.set("client_secret", rec.clientSecret);
        try {
          const res = await fetch(meta.revocation_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT }, body, signal: AbortSignal.timeout(10e3), redirect: "error" });
          if (!res.ok) revoked = false;
        } catch { revoked = false; }
      }
    }
    write({ ...rec, accessToken: null, refreshToken: null, expiresAt: null, scope: "" });
    memo = null;
    return { revoked };
  });
}
