// The application: tabs with page stacks, overlays, mouse routing, toasts and the render loop.

import { appendFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { Screen } from "./term/screen.js";
import { Input } from "./term/input.js";
import { G, SPIN } from "./ui/draw.js";
import { T, mix } from "./ui/theme.js";
import { strWidth, truncate } from "./term/width.js";
import { stats, onActivity, pruneCache, CACHE_DIR } from "./api.js";
import { onImageLoad } from "./image.js";
import { onUrlBlocked } from "./sys.js";
import { ownDir } from "./paths.js";
import { clean } from "./safe.js";
import { store } from "./store.js";
import * as auth from "./auth.js";
import { rub } from "./product.js";

export const TABS = [
  { id: "catalog", label: "Каталог" },
  { id: "deals", label: "Акции" },
  { id: "recipes", label: "Рецепты" },
  { id: "shops", label: "Магазины" },
  { id: "cart", label: "Корзина" },
  { id: "profile", label: "Профиль" },
];

const MIN_W = 64, MIN_H = 18;
export const LOG_FILE = path.join(CACHE_DIR, "vv-cli.log");

function log(e) {
  try {
    // Only into a folder of this user; a planted symlink in place of the log is not followed
    ownDir(CACHE_DIR);
    try { if (lstatSync(LOG_FILE).isSymbolicLink()) return; } catch {}
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${e?.stack ?? e}\n`, { mode: 0o600 });
  } catch {}
}

export class App {
  constructor({ views, headless = false, size } = {}) {
    this.headless = headless;
    this.screen = new Screen(headless ? { columns: size?.[0] ?? 120, rows: size?.[1] ?? 36, write() {} } : process.stdout);
    this.g = new G(this.screen, this);
    this.views = views;
    this.stacks = {};
    this.overlays = [];
    this.hits = [];
    this.overlayHits = 0;
    this.frame = 0;
    this.toastMsg = null;
    this.lastClick = { t: 0, x: -1, y: -1 };
    this.compare = new Map();
    // Keyboard focus on the header: ↑ from the top of any page lands here, ← → walk the tabs
    this.headerFocus = false;
    this.headerSel = 0;
    for (const t of TABS) this.stacks[t.id] = [views[t.id](this)];
    const saved = store.pref("tab");
    this.tab = TABS.some((t) => t.id === saved) ? saved : "catalog";
    onActivity(() => this.invalidate());
    onImageLoad(() => this.invalidate());
    onUrlBlocked(() => this.toast("Это не ссылка ВкусВилла — не открываю", T.red));
    store.listeners.add(() => this.invalidate());
  }

  get page() { const s = this.stacks[this.tab]; return s[s.length - 1]; }

  start() {
    const s = this.screen;
    let restored = false;
    const restore = () => {
      if (restored) return;
      restored = true;
      try { s.leave(); this.input?.stop(); } catch {}
    };
    this.restore = restore;
    s.enter();
    process.on("exit", restore);
    for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"]) process.on(sig, () => this.quit());
    // A stray rejection must not kill the session: log it and say so
    process.on("unhandledRejection", (e) => { log(e); this.toast(`⚠ ${e?.message ?? e}`, T.red); });
    process.on("uncaughtException", (e) => {
      log(e);
      store.saveNow();
      restore();
      console.error(`vkusvill упал: ${clean(e?.message ?? e)}\nподробности: ${LOG_FILE}`);
      process.exit(1);
    });
    process.stdout.on("resize", () => { s.resize(process.stdout.columns, process.stdout.rows); this.render(); });
    this.input = new Input(process.stdin, (ev) => this.onEvent(ev));
    this.input.start();
    store.watch();
    if (store.warning) this.toast(store.warning, T.orange);
    this.ticker = setInterval(() => this.tick(), 90);
    setTimeout(() => pruneCache().catch(log), 4000).unref();
    this.page.onShow?.();
    this.render();
  }

  quit() {
    store.saveNow();
    store.unwatch();
    clearInterval(this.ticker);
    this.restore?.();
    process.exit(0);
  }

  tick() { this.guard(() => this.step()); }

  step() {
    this.frame++;
    // Said once: a locked keychain made the last refresh keep the secrets in auth.json
    if (!this.storeWarned && auth.cachedStatus().storeRefused) {
      this.storeWarned = true;
      this.toast("Связка ключей не ответила — секреты пока в auth.json, переедут при следующем обновлении", T.orange);
    }
    // Pages load more data here, never from draw(): rendering stays free of side effects
    this.page.tick?.();
    const top = this.overlays.at(-1);
    if (stats.active || stats.queued || this.page.busy?.() || top?.animated || this.toastMsg || this.page.animated) this.invalidate();
    if (this.toastMsg && Date.now() > this.toastMsg.until) { this.toastMsg = null; this.invalidate(); }
  }

  // Coalesces redraws to at most one per ~16 ms
  invalidate() {
    if (this.pending) return;
    this.pending = true;
    const since = Date.now() - (this.lastRender ?? 0);
    setTimeout(() => { this.pending = false; this.render(); }, Math.max(0, 16 - since));
  }

  // Clickable area registered during render; handlers: click(ev), wheel(dir), passive
  hit(x, y, w, h, handlers) { this.hits.push({ x, y, w, h, ...handlers }); }

  toast(msg, color = T.lime) {
    this.toastMsg = { msg: String(msg), color, until: Date.now() + 2600 };
    this.invalidate();
  }

  // ——— Navigation ———

  switchTab(id) {
    // Menus, the palette and dialogs belong to the tab they were opened on
    this.closeOverlays();
    if (this.tab === id) return;
    this.tab = id;
    store.setPref("tab", id);
    this.page.onShow?.();
    this.invalidate();
  }

  push(view) {
    this.stacks[this.tab].push(view);
    view.onShow?.();
    this.invalidate();
  }

  pop() {
    const s = this.stacks[this.tab];
    if (s.length < 2) return false;
    s.pop()?.onHide?.();
    this.page.onShow?.();
    this.invalidate();
    return true;
  }

  toggleCompare(p) {
    if (this.compare.has(p.id)) {
      this.compare.delete(p.id);
      return this.toast(`Убрано из сравнения · ${this.compare.size}`, T.violet);
    }
    if (this.compare.size >= 4) return this.toast("Сравнивать можно до 4 товаров", T.orange);
    this.compare.set(p.id, p);
    this.toast(`⇄ В сравнении ${this.compare.size} · X — сравнить`, T.violet);
  }

  openCompare() {
    if (this.compare.size < 2) return this.toast("Отметьте хотя бы 2 товара клавишей x", T.violet);
    this.views.compare(this);
  }

  overlay(o) {
    this.overlays.push(o);
    this.invalidate();
    return o;
  }

  closeOverlay(o) {
    this.overlays = this.overlays.filter((x) => x !== o);
    this.invalidate();
  }

  closeOverlays() {
    for (const o of this.overlays) if (!o.persistent) o.onClose?.();
    this.overlays = this.overlays.filter((o) => o.persistent);
    this.invalidate();
  }

  // ——— Header focus ———

  // Header items: the tabs, then the sign-in/sign-out button when there is one
  headerItems() {
    const st = auth.cachedStatus();
    return [...TABS.map((t) => t.id), ...(st.viaEnv ? [] : ["auth"])];
  }

  focusHeader() {
    this.headerFocus = true;
    this.headerSel = TABS.findIndex((t) => t.id === this.tab);
    this.invalidate();
  }

  leaveHeader() {
    this.headerFocus = false;
    this.page.focusTop?.();
    this.invalidate();
  }

  headerKey(ev) {
    const items = this.headerItems();
    const k = ev.hot ?? ev.name;
    const move = (d) => {
      this.headerSel = (this.headerSel + d + items.length) % items.length;
      const id = items[this.headerSel];
      if (id !== "auth") this.switchTab(id);
      this.invalidate();
    };
    if (ev.name === "left" || (k === "h" && !ev.ctrl)) return move(-1), true;
    if (ev.name === "right" || (k === "l" && !ev.ctrl)) return move(1), true;
    if (ev.name === "up") return true;
    // Digits and Tab switch tabs as everywhere, staying in the header
    const n = Number(ev.ch);
    if (ev.ch && n >= 1 && n <= TABS.length) return move(n - 1 - this.headerSel), true;
    if (ev.name === "tab" || ev.name === "backtab") return move(ev.name === "tab" ? 1 : -1), true;
    if (ev.name === "enter" && items[this.headerSel] === "auth") {
      this.headerFocus = false;
      auth.cachedStatus().signedIn ? this.views.signOut(this) : this.views.signIn(this);
      return true;
    }
    if (ev.name === "down" || ev.name === "enter" || ev.name === "escape") return this.leaveHeader(), true;
    // Anything else leaves the header and goes to the page as usual (typing straight into a search)
    this.headerFocus = false;
    return false;
  }

  // ——— Events ———

  // Odd data from the server can trip a page's code: one broken page must not end the session.
  // The error is logged and shown; the page underneath stays usable
  guard(fn) {
    try { return fn(); } catch (e) { log(e); this.toast(`⚠ ${clean(e?.message ?? e).slice(0, 120)}`, T.red); return undefined; }
  }

  onEvent(ev) { return this.guard(() => this.handle(ev)); }

  handle(ev) {
    if (ev.type === "key" && ev.ctrl && ev.name === "c") return this.quit();
    if (ev.type === "key" && ev.ctrl && ev.name === "l") { this.screen.invalidateAll(); return this.render(); }
    if (ev.type === "mouse") { if (ev.action === "down") this.headerFocus = false; return this.onMouse(ev); }
    const top = this.overlays.at(-1);
    if (top) { top.key(ev, this); return this.invalidate(); }
    if (ev.type === "key" && ev.ctrl && ev.name === "k") return this.views.palette(this);
    if (this.headerFocus && ev.type === "key" && this.headerKey(ev)) return this.invalidate();
    if (this.page.key?.(ev)) return this.invalidate();
    if (ev.type !== "key") return;
    // ↑ that the page did not use means it is at its top edge: go up to the header
    if (ev.name === "up") return this.focusHeader();
    // → opens things, so ← that the page did not use goes back out, like esc
    if (ev.name === "left" && this.stacks[this.tab].length > 1) return this.pop();
    if (ev.name === "escape") return this.pop();
    const k = ev.hot ?? ev.name;
    const n = Number(ev.ch);
    if (ev.ch && n >= 1 && n <= TABS.length) return this.switchTab(TABS[n - 1].id);
    if (ev.name === "tab" || ev.name === "backtab") {
      const i = TABS.findIndex((t) => t.id === this.tab);
      return this.switchTab(TABS[(i + (ev.name === "tab" ? 1 : TABS.length - 1)) % TABS.length].id);
    }
    if (k === "q") return this.quit();
    if (k === "?" || k === "&" || ev.name === "f1") return this.views.help(this);
    if (k === ":" || k === "^") return this.views.palette(this);
    if (k === "b") return this.views.barcode(this);
    if (k === "c" && !ev.shift) return this.switchTab("cart");
  }

  onMouse(ev) {
    const inside = (h) => ev.x >= h.x && ev.x < h.x + h.w && ev.y >= h.y && ev.y < h.y + h.h;
    // An open overlay is modal: the mouse only sees its areas
    const modal = this.overlays.length > 0;
    const from = modal ? this.overlayHits : 0;
    if (ev.action === "wheelup" || ev.action === "wheeldown") {
      const dir = ev.action === "wheelup" ? -1 : 1;
      for (let i = this.hits.length - 1; i >= from; i--) if (this.hits[i].wheel && inside(this.hits[i])) { this.hits[i].wheel(dir); break; }
      return this.invalidate();
    }
    if (ev.action !== "down" || ev.button !== 0) return;
    const now = Date.now();
    ev.double = now - this.lastClick.t < 400 && this.lastClick.x === ev.x && this.lastClick.y === ev.y;
    this.lastClick = { t: now, x: ev.x, y: ev.y };
    let handled = false;
    for (let i = this.hits.length - 1; i >= from; i--) {
      const h = this.hits[i];
      if (h.click && !h.passive && inside(h)) { h.click(ev); handled = true; break; }
    }
    // A click outside the overlay closes it; a click on the header also goes through (switching tabs)
    if (modal && !handled && !this.overlays.at(-1)?.persistent) {
      this.closeOverlays();
      if (ev.y === 0) {
        for (let i = from - 1; i >= 0; i--) {
          const h = this.hits[i];
          if (h.click && inside(h)) { h.click(ev); break; }
        }
      }
    }
    this.invalidate();
  }

  // ——— Rendering ———

  render() {
    this.lastRender = Date.now();
    const g = this.g, s = this.screen;
    this.hits = [];
    s.clear(T.bg);
    if (s.w < MIN_W || s.h < MIN_H) {
      g.textC(0, s.w, Math.floor(s.h / 2) - 1, "ВкусВилл не помещается", { fg: T.lime, bold: true });
      g.textC(0, s.w, Math.floor(s.h / 2) + 1, `нужно хотя бы ${MIN_W}×${MIN_H}, сейчас ${s.w}×${s.h}`, { fg: T.dim });
      this.overlayHits = 0;
      return s.flush();
    }
    this.drawHeader(g);
    const body = { x: 0, y: 1, w: s.w, h: s.h - 2 };
    s.pushClip(body.x, body.y, body.w, body.h);
    try { this.page.draw(g, body); } catch (e) { this.drawFailure(g, body, e); }
    s.popClip();
    this.drawStatus(g);
    this.overlayHits = this.hits.length;
    for (const o of this.overlays) { try { o.draw(g, this); } catch (e) { this.drawFailure(g, body, e); } }
    s.flush();
  }

  // Instead of a page that cannot be drawn: what happened and the way back. Logged once per message
  drawFailure(g, r, e) {
    const msg = clean(e?.message ?? e).slice(0, 200);
    if (this.lastFailure !== msg) { this.lastFailure = msg; log(e); }
    g.fill(r.x, r.y, r.w, r.h, T.bg);
    g.textC(r.x, r.w, r.y + Math.floor(r.h / 2) - 1, "Не получилось показать эту страницу", { fg: T.orange, bold: true });
    g.textC(r.x, r.w, r.y + Math.floor(r.h / 2) + 1, `${msg} · esc — назад`, { fg: T.dim });
  }

  drawHeader(g) {
    const w = g.w;
    g.fill(0, 0, w, 1, T.header);
    let labels = TABS.map((t, i) => ` ${i + 1} ${t.label}${t.id === "cart" && store.count ? ` ${store.count}` : ""} `);
    // Signing in and out is one click away from anywhere (a ready-made VV_TOKEN is not ours to drop)
    const st = auth.cachedStatus();
    const signInLabel = st.viaEnv ? null : st.signedIn ? " выйти " : " войти ";
    const cartW = (store.count ? strWidth(` ▣ ${rub(store.total)} `) + 1 : 0) + (signInLabel ? strWidth(signInLabel) + 1 : 0);
    let tabsW = labels.reduce((sum, l) => sum + strWidth(l), 0);
    // Too narrow: drop the leading space of every tab, then the wordmark
    if (4 + tabsW + cartW > w) { labels = labels.map((l) => l.slice(1)); tabsW -= labels.length; }
    const full = 15 + tabsW + cartW <= w;
    let x = g.text(0, 0, " ◆ ", { fg: T.lime, bg: T.greenD, bold: true });
    if (full) {
      x = g.text(x, 0, "Вкус", { fg: T.white, bg: T.greenD, bold: true });
      x = g.text(x, 0, "Вилл ", { fg: T.lime, bg: T.greenD, bold: true });
    }
    x = g.text(x, 0, "▶", { fg: T.greenD, bg: T.header });
    if (full) x += 1;
    const focusId = this.headerFocus ? this.headerItems()[this.headerSel] : null;
    TABS.forEach((t, i) => {
      const active = t.id === this.tab;
      const label = labels[i];
      if (x + strWidth(label) > w - cartW) return;
      const x0 = x;
      // A focused tab is brighter and underlined, so keyboard focus is visible at a glance
      const focused = focusId === t.id;
      x = g.text(x, 0, label, { fg: active ? T.bg : T.sub, bg: focused ? T.lime : active ? T.green : T.header, bold: active, underline: focused });
      this.hit(x0, 0, x - x0, 1, { click: () => this.switchTab(t.id) });
    });
    // Right side: network activity, sign-in and the cart total
    let rx = w - 1;
    if (store.count) {
      const t = ` ▣ ${rub(store.total)} `;
      rx = g.textR(rx + 1, 0, t, { fg: T.bg, bg: T.lime, bold: true }) - 1;
      this.hit(rx + 1, 0, strWidth(t), 1, { click: () => this.switchTab("cart") });
    }
    if (signInLabel) {
      const focused = focusId === "auth";
      rx = g.textR(rx + 1, 0, signInLabel, { fg: focused ? T.bg : st.signedIn ? T.sub : T.lime, bg: focused ? T.lime : T.raise, bold: !st.signedIn || focused, underline: focused }) - 2;
      this.hit(rx + 2, 0, strWidth(signInLabel), 1, { click: () => (st.signedIn ? this.views.signOut(this) : this.views.signIn(this)) });
    }
    const room = Math.max(0, rx - x - 1);
    if (stats.active || stats.queued || this.page.busy?.()) {
      g.textR(rx, 0, truncate(`${SPIN[this.frame % SPIN.length]} ${stats.queued ? `очередь ${stats.queued}` : "загрузка"}`, room), { fg: T.lime, bg: T.header });
    } else if (store.saveError) {
      g.textR(rx, 0, truncate(`⚠ не сохранилось: ${store.saveError}`, Math.min(room, 50)), { fg: T.red, bg: T.header });
    } else if (stats.lastError) {
      g.textR(rx, 0, truncate(`⚠ ${stats.lastError}`, Math.min(room, 44)), { fg: T.red, bg: T.header });
    }
  }

  drawStatus(g) {
    const y = g.h - 1;
    g.fill(0, y, g.w, 1, T.header);
    const top = this.overlays.at(-1);
    const headerHints = [["← →", "вкладки"], ["↓ ⏎", "в раздел"]];
    const hints = top?.hints?.() ?? (this.headerFocus ? headerHints : this.page.hints?.() ?? []);
    const all = [...hints, ...(top ? [] : [["?", "помощь"], ["^K", "команды"]])];
    // A toast takes the right end of the line; hints never run under it
    let toastW = 0;
    if (this.toastMsg) {
      const m = truncate(` ${this.toastMsg.msg} `, Math.max(10, Math.floor(g.w * 0.6)));
      toastW = strWidth(m);
      const bg = mix(this.toastMsg.color, T.bg, 0.15);
      g.text(g.w - toastW, y, m, { fg: T.bg, bg, bold: true });
    }
    let x = 1;
    for (const [k, label] of all) {
      const need = strWidth(k) + strWidth(label) + 4;
      if (x + need > g.w - toastW - 1) break;
      x = g.key(x, y, k, label);
    }
  }
}
