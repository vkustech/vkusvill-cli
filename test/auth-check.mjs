// Sign-in against a local mock of VkusVill's OAuth server (Ory Hydra semantics) and MCP endpoint:
// PKCE, loopback and pasted redirects, refresh rotation, reuse detection, cross-process refresh,
// 401 recovery in the API client, revocation. No real network.
// node test/auth-check.mjs

import assert from "node:assert/strict";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const tmp = mkdtempSync(path.join(tmpdir(), "vv-auth-"));
process.env.VV_CONFIG_DIR = path.join(tmp, "config");
// Never touch the real credential store from tests
process.env.VV_SECRETS = "file";
process.env.VV_CACHE_DIR = path.join(tmp, "cache");
delete process.env.VV_TOKEN;

// ——— Mock server ———

const S = { codes: new Map(), access: new Map(), refresh: new Map(), revoked: [], refreshCalls: 0, mcpCalls: 0, denyOffline: false, allowed: null, opens: 0, lastScope: "" };
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const issue = (family, scope) => {
  const at = "at_" + randomBytes(6).toString("hex"), rt = scope.includes("offline_access") ? "rt_" + randomBytes(6).toString("hex") : null;
  S.access.set(at, { family, valid: true, scope });
  if (rt) S.refresh.set(rt, { family, used: false, scope });
  return { access_token: at, refresh_token: rt ?? undefined, expires_in: 3600, scope, token_type: "bearer" };
};
const revokeFamily = (family) => {
  for (const v of S.access.values()) if (v.family === family) v.valid = false;
  for (const v of S.refresh.values()) if (v.family === family) v.used = true;
};

const agents = new Set();
const server = http.createServer(async (req, res) => {
  agents.add(`${req.url.split("?")[0]} ${req.headers["user-agent"]}`);
  const url = new URL(req.url, base);
  let body = "";
  for await (const c of req) body += c;
  const form = new URLSearchParams(body);
  const json = (code, data) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
  if (url.pathname === "/oauth2/token") {
    if (form.get("client_id") !== "client-1") return json(401, { error: "invalid_client" });
    if (form.get("grant_type") === "authorization_code") {
      const c = S.codes.get(form.get("code"));
      S.codes.delete(form.get("code"));
      if (!c || c.redirect !== form.get("redirect_uri")) return json(400, { error: "invalid_grant" });
      if (b64url(createHash("sha256").update(form.get("code_verifier") ?? "").digest()) !== c.challenge) return json(400, { error: "invalid_grant" });
      return json(200, issue(randomBytes(4).toString("hex"), c.scope));
    }
    if (form.get("grant_type") === "refresh_token") {
      S.refreshCalls++;
      await new Promise((r) => setTimeout(r, 150)); // widen the race window
      const r = S.refresh.get(form.get("refresh_token"));
      if (!r) return json(400, { error: "invalid_grant" });
      // Hydra: reusing a rotated refresh token revokes the whole family
      if (r.used) { revokeFamily(r.family); return json(400, { error: "invalid_grant" }); }
      r.used = true;
      return json(200, issue(r.family, r.scope));
    }
    return json(400, { error: "unsupported_grant_type" });
  }
  if (url.pathname === "/oauth2/revoke") {
    S.revoked.push(form.get("token_type_hint"));
    const a = S.access.get(form.get("token")); if (a) a.valid = false;
    const r = S.refresh.get(form.get("token")); if (r) revokeFamily(r.family);
    res.writeHead(200).end();
    return;
  }
  if (url.pathname === "/mcp") {
    S.mcpCalls++;
    const msg = JSON.parse(body);
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const ok = S.access.get(token)?.valid;
    const personal = msg.params.name === "vkusvill_orders_history";
    if (token && !ok) return json(401, { error: "invalid_token" });
    if (personal && !ok) return json(401, { error: "missing" });
    // The favourite product needs a right the token may lack: RFC 6750 insufficient_scope
    if (msg.params.name === "vkusvill_product_lp" && !S.access.get(token)?.scope.includes("recommendations.personalized")) {
      res.writeHead(403, { "WWW-Authenticate": 'Bearer error="insufficient_scope"' });
      return res.end();
    }
    const data = personal ? { items: [{ id: 1, id_general: "A-1", price: 100, products: [] }] } : { items: [], meta: { personalized: !!ok } };
    return json(200, { jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify({ ok: true, data }) }] } });
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;
const META = {
  issuer: base + "/",
  authorization_endpoint: base + "/oauth2/auth",
  token_endpoint: base + "/oauth2/token",
  revocation_endpoint: base + "/oauth2/revoke",
  scopes: ["catalog.search", "purchase_history.read", "discounts.view", "recommendations.personalized"],
};

const freePort = () => new Promise((r) => { const s = http.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const redirect = `http://127.0.0.1:${await freePort()}/callback`;

const auth = await import("../src/auth.js");
const api = await import("../src/api.js");
auth._setMetadataForTests(META);
api._setEndpointForTests(base + "/mcp");
const FILE = path.join(process.env.VV_CONFIG_DIR, "auth.json");

// The "browser": takes the authorization URL, approves, and follows the redirect
function browser({ deny, wrongState, tamper } = {}) {
  return async (href) => {
    const u = new URL(href);
    const p = u.searchParams;
    const scope = p.get("scope");
    S.opens++;
    S.lastScope = scope;
    const back = new URL(p.get("redirect_uri"));
    const refused = S.allowed && scope.split(" ").find((x) => !S.allowed.has(x));
    if (deny) back.searchParams.set("error", "access_denied");
    else if (refused) {
      // Hydra's wording
      back.searchParams.set("error", "invalid_scope");
      back.searchParams.set("error_description", `The requested scope is invalid. The OAuth 2.0 Client is not allowed to request scope "${refused}".`);
    } else if (S.denyOffline && scope.includes("offline_access")) back.searchParams.set("error", "invalid_scope");
    else {
      const code = "code_" + randomBytes(6).toString("hex");
      S.codes.set(code, { challenge: tamper ? "x" : p.get("code_challenge"), redirect: p.get("redirect_uri"), scope });
      back.searchParams.set("code", code);
    }
    back.searchParams.set("state", wrongState ? "nope" : p.get("state"));
    browser.last = back.href;
    if (back.hostname === "127.0.0.1") await fetch(back).catch(() => {});
  };
}

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.log(`  ✗ ${name}\n    ${e.stack?.split("\n").slice(0, 3).join("\n    ")}`); process.exitCode = 1; }
};

console.log("sign-in");
await test("no client id: sign-in asks for one first", async () => {
  await assert.rejects(auth.login({ open: () => {} }), (e) => e.code === "no_client");
  assert.throws(() => auth.setClient({ clientId: "a b" }), /client_id/);
});
await test("loopback redirect with PKCE gives tokens, stored privately", async () => {
  auth.setClient({ clientId: "client-1", redirectUri: redirect });
  const rec = await auth.login({ open: browser() });
  assert.match(rec.accessToken, /^at_/);
  assert.match(rec.refreshToken, /^rt_/);
  assert.ok(rec.scope.includes("offline_access"));
  if (process.platform !== "win32") assert.equal(statSync(FILE).mode & 0o777, 0o600);
  assert.equal(auth.status().signedIn, true);
  assert.equal(await auth.accessToken(), rec.accessToken);
});
await test("a forged state or a wrong verifier is refused", async () => {
  await assert.rejects(auth.login({ open: browser({ tamper: true }) }), (e) => e.code === "invalid_grant");
  // A pasted redirect from another attempt is refused outright
  await assert.rejects(auth.login({ open: browser({ wrongState: true }), paste: async () => { await new Promise((r) => setTimeout(r, 200)); return browser.last; } }), (e) => e.code === "state_mismatch");
});
await test("a web page poking the loopback address cannot cancel the sign-in or strip rights", async () => {
  const pokes = [];
  const open = async (href) => {
    const back = new URL(new URL(href).searchParams.get("redirect_uri"));
    // What any page in the browser could fire at 127.0.0.1 while the user signs in
    for (const q of ["error=access_denied", "error=invalid_scope&error_description=scope+%22purchase_history.read%22", "error=access_denied&state=nope", "code=forged&state=nope"]) {
      pokes.push((await fetch(`${back.origin}${back.pathname}?${q}`).catch(() => ({ status: 0 }))).status);
    }
    await browser()(href);
  };
  const before = S.opens;
  const rec = await auth.login({ open });
  assert.deepEqual(pokes, [400, 400, 400, 400]);
  assert.match(rec.accessToken, /^at_/);
  assert.equal(S.opens - before, 1, "no extra rounds of narrowing the rights");
  assert.ok(rec.scopes == null || rec.scopes.includes("purchase_history.read"));
});
await test("a malformed request to the loopback address does not stop the sign-in", async () => {
  const net = await import("node:net");
  const open = async (href) => {
    const back = new URL(new URL(href).searchParams.get("redirect_uri"));
    // What a page can send with fetch("http://127.0.0.1:3000//"): a target URL() cannot parse
    await new Promise((resolve) => {
      const sock = net.connect(+back.port, back.hostname, () => sock.end("GET // HTTP/1.1\r\nHost: x\r\n\r\n"));
      sock.on("data", () => {}).on("close", resolve).on("error", resolve);
    });
    await browser()(href);
  };
  const rec = await auth.login({ open });
  assert.match(rec.accessToken, /^at_/);
});
await test("denied in the browser: a clear error", async () => {
  await assert.rejects(auth.login({ open: browser({ deny: true }) }), (e) => e.code === "access_denied");
});
await test("pasted redirect for clients without a loopback URI", async () => {
  auth.setClient({ clientId: "client-1", redirectUri: "https://vkusvill.ru/oauth/no-uri" });
  // The user pastes after the page has opened
  let opened;
  const ready = new Promise((r) => (opened = r));
  const open = async (href) => { await browser()(href); opened(); };
  try {
    const rec = await auth.login({ open, paste: async () => { await ready; return browser.last; } });
    assert.match(rec.accessToken, /^at_/);
  } finally {
    auth.setClient({ clientId: "client-1", redirectUri: redirect });
  }
});
await test("VkusVill's no-public-URI redirect (localhost) is caught on IPv4 and IPv6", async () => {
  const port = await freePort();
  auth.setClient({ clientId: "client-1", redirectUri: `http://localhost:${port}/callback` });
  try {
    for (const host of ["127.0.0.1", "[::1]"]) {
      const rec = await auth.login({
        open: async (href) => {
          // The mock browser follows "localhost" itself; then hit each address family explicitly
          await browser()(href);
          await fetch(browser.last.replace("localhost", host)).catch(() => {});
        },
      });
      assert.match(rec.accessToken, /^at_/, host);
    }
  } finally {
    auth.setClient({ clientId: "client-1", redirectUri: redirect });
  }
});
await test("a port held by another program: no half-listening, the paste finishes", async () => {
  const busy = http.createServer((_q, r) => r.end("dev server")).listen(0, "127.0.0.1");
  await new Promise((r) => busy.once("listening", r));
  auth.setClient({ clientId: "client-1", redirectUri: `http://localhost:${busy.address().port}/callback` });
  let notice = null, opened;
  const ready = new Promise((r) => (opened = r));
  try {
    const rec = await auth.login({
      notice: (t) => { notice = t; },
      open: async (href) => {
        const p = new URL(href).searchParams;
        const code = "code_" + randomBytes(6).toString("hex");
        S.codes.set(code, { challenge: p.get("code_challenge"), redirect: p.get("redirect_uri"), scope: p.get("scope") });
        browser.last = `${p.get("redirect_uri")}?code=${code}&state=${p.get("state")}`;
        opened();
      },
      paste: async () => { await ready; await new Promise((r) => setTimeout(r, 100)); return browser.last; },
    });
    assert.match(rec.accessToken, /^at_/);
    assert.match(notice ?? "", /занят/);
  } finally {
    busy.close();
    auth.setClient({ clientId: "client-1", redirectUri: redirect });
  }
});
await test("a client without offline_access still signs in, without refresh", async () => {
  S.denyOffline = true;
  const rec = await auth.login({ open: browser() });
  S.denyOffline = false;
  assert.ok(!rec.scope.includes("offline_access"));
  assert.equal(auth.status().refreshable, false, "a new sign-in does not keep the previous grant's refresh token");
  await auth.login({ open: browser() });
});

console.log("refresh");
const expire = () => { const r = JSON.parse(readFileSync(FILE, "utf8")); r.expiresAt = Date.now() - 1000; writeFileSync(FILE, JSON.stringify(r)); };
await test("an expired access token is refreshed and the refresh token rotates", async () => {
  const before = auth.read();
  expire();
  const t = await auth.accessToken();
  const after = auth.read();
  assert.notEqual(t, before.accessToken);
  assert.notEqual(after.refreshToken, before.refreshToken);
});
await test("parallel callers in one process share a single refresh", async () => {
  expire();
  const calls = S.refreshCalls;
  const [a, b, c] = await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]);
  assert.equal(a, b); assert.equal(b, c);
  assert.equal(S.refreshCalls - calls, 1);
});
await test("two processes refreshing at once do not trip reuse detection", async () => {
  expire();
  const calls = S.refreshCalls;
  const child = `
    const auth = await import(${JSON.stringify(new URL("../src/auth.js", import.meta.url).href)});
    auth._setMetadataForTests(${JSON.stringify(META)});
    process.stdout.write(await auth.accessToken());`;
  const run = () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", child], { env: process.env });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code ? reject(new Error(err)) : resolve(out)));
  });
  const [x, y] = await Promise.all([run(), run()]);
  assert.equal(x, y);
  assert.equal(S.refreshCalls - calls, 1);
  assert.equal(S.access.get(x)?.valid, true, "the chain was not revoked");
});

console.log("api");
await test("a refused token is renewed once and the call goes through", async () => {
  const rec = auth.read();
  S.access.get(rec.accessToken).valid = false; // revoked server-side, still "fresh" locally
  const d = await api.orders(1);
  assert.equal(d.items[0].id_general, "A-1");
  assert.notEqual(auth.read().accessToken, rec.accessToken);
});
await test("a dead refresh chain: personal tools ask to sign in, public ones go anonymous", async () => {
  const rec = auth.read();
  revokeFamily(S.refresh.get(rec.refreshToken).family);
  expire();
  await assert.rejects(api.call("vkusvill_orders_history", { page: 2 }), (e) => e.code === "auth" && /войдите|vv login/.test(e.message));
  assert.equal(auth.read().refreshToken, null, "dead tokens are forgotten");
  assert.equal(auth.read().clientId, "client-1", "the client is kept");
  const pub = await api.call("vkusvill_products_search", { q: "x" }, { fresh: true });
  assert.equal(pub.meta.personalized, false);
});

console.log("partial rights");
await test("a client with fewer rights signs in without them, and remembers that", async () => {
  S.allowed = new Set(["offline_access", "catalog.search", "discounts.view"]);
  auth.setClient({ clientId: "client-1", scopes: null });
  const notices = [];
  const opens = S.opens;
  const rec = await auth.login({ open: browser(), notice: (t) => notices.push(t) });
  assert.deepEqual(rec.scope.split(" ").sort(), ["catalog.search", "discounts.view", "offline_access"]);
  assert.deepEqual(auth.read().scopes.sort(), ["catalog.search", "discounts.view"]);
  assert.equal(notices.length, 2);
  assert.ok(notices.some((t) => t.includes("История покупок")));
  assert.equal(S.opens - opens, 3);
  const again = S.opens;
  await auth.login({ open: browser() });
  assert.equal(S.opens - again, 1, "the next sign-in asks only for what the client has");
});
await test("orders without the right: a clear message, no request, no refresh", async () => {
  const calls = S.mcpCalls, refreshes = S.refreshCalls;
  await assert.rejects(api.orders(1), (e) => e.code === "scope" && e.message.includes("История покупок"));
  assert.equal(S.mcpCalls, calls);
  assert.equal(S.refreshCalls, refreshes);
});
await test("insufficient_scope from the server is not treated as an expired token", async () => {
  const refreshes = S.refreshCalls, token = auth.read().accessToken;
  await assert.rejects(api.favoriteProduct(), (e) => e.code === "scope");
  assert.equal(S.refreshCalls, refreshes);
  assert.equal(auth.read().accessToken, token, "the token is kept");
});
await test("search goes anonymous when the catalog right is missing", async () => {
  S.allowed = new Set(["offline_access", "discounts.view"]);
  auth.setClient({ clientId: "client-1", scopes: null });
  await auth.login({ open: browser() });
  const d = await api.call("vkusvill_products_search", { q: "y" }, { fresh: true });
  assert.equal(d.meta.personalized, false);
});
await test("--scope all asks for every right again after the site settings change", async () => {
  S.allowed = null;
  auth.setClient({ clientId: "client-1", scopes: null });
  const rec = await auth.login({ open: browser() });
  assert.ok(S.lastScope.includes("purchase_history.read"));
  assert.ok(rec.scope.includes("purchase_history.read"));
  const d = await api.orders(1);
  assert.equal(d.items[0].id_general, "A-1");
});

console.log("identity");
await test("every request introduces itself as VkusVill-CLI with its version", () => {
  assert.ok(agents.size > 0);
  for (const a of agents) assert.match(a, / VkusVill-CLI\/\d+\.\d+\.\d+[\w.-]* \((macOS|Windows|Linux|\w+) \w+; Node\.js [\d.]+\)$/, a);
  assert.ok([...agents].some((a) => a.startsWith("/mcp ")) && [...agents].some((a) => a.startsWith("/oauth2/token ")));
});

console.log("sign-out");
await test("logout revokes both tokens and keeps the client", async () => {
  await auth.login({ open: browser() });
  const n = S.revoked.length;
  assert.deepEqual(await auth.logout(), { revoked: true });
  assert.equal(await auth.logout(), null, "nothing left to sign out of");
  assert.deepEqual(S.revoked.slice(n), ["refresh_token", "access_token"]);
  assert.equal(auth.status().signedIn, false);
  assert.equal(auth.status().configured, true);
});

server.close();
console.log(`\n${passed} passed${process.exitCode ? ", some failed" : ""}`);
process.exit(process.exitCode ?? 0);
