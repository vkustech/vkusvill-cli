// Profile: favourites and history are local; orders, favourite product and "6 discounts" need
// the user signed in to VkusVill. Signing in happens right here: register a client, paste its id,
// confirm in the browser.

import { T } from "../ui/theme.js";
import { ListView, Prompt } from "../ui/widgets.js";
import { ProductBrowser } from "./browser.js";
import * as api from "../api.js";
import * as auth from "../auth.js";
import { normalize, rub, plural, qtyStep } from "../product.js";
import { store } from "../store.js";
import { openUrl, copy } from "../sys.js";
import { strWidth, truncate } from "../term/width.js";

const SECTIONS = [
  { id: "account", label: "Войти", icon: "◉" }, // "Аккаунт" once signed in
  { id: "favs", label: "Избранное", icon: "♥" },
  { id: "history", label: "Недавно смотрели", icon: "◷" },
  { id: "orders", label: "Мои заказы", icon: "▤", auth: true, scope: "purchase_history.read" },
  { id: "lp", label: "Любимый продукт", icon: "★", auth: true },
  { id: "personal", label: "6 скидок для меня", icon: "%", auth: true },
];

const time = (t) => new Date(t).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

export function profileView(app) {
  return new ProfileView(app);
}

class ProfileView {
  constructor(app) {
    this.app = app;
    this.nav = new ListView();
    this.focus = "nav";
    this.subs = {};
    this.signing = null;     // sign-in in progress: { ctl, url, paste }
    this.authError = null;
    this.accountSel = 0;     // account page: 0 — sign in again, 1 — sign out
  }

  get section() { return SECTIONS[this.nav.sel]; }

  // auth.json is shared with `vv login` in other terminals: re-read, but at most once a second
  get auth() { return auth.cachedStatus(); }

  label(s) { return s.id === "account" ? (this.auth.signedIn ? "Аккаунт" : "Войти") : s.label; }

  locked(s = this.section) { return s.auth && (!this.auth.signedIn || this.missing(s)); }

  // The section needs a right this client was not given
  missing(s = this.section) {
    const g = this.auth.granted;
    return !!(s.scope && this.auth.signedIn && g && !g.includes(s.scope));
  }

  sub(id) {
    if (this.subs[id]) return this.subs[id];
    const app = this.app;
    const local = (title, arr, empty) => new ProductBrowser(app, {
      title, serverSort: false, autoLoad: false, emptyText: empty,
      loader: async () => ({ items: arr(), total: arr().length, hasMore: false }),
    });
    let v;
    if (id === "favs") v = local("Избранное", () => store.favs, "Пусто. Нажмите * на любом товаре");
    else if (id === "history") v = local("Недавно смотрели", () => store.history, "Вы еще ничего не открывали");
    else if (id === "personal") {
      v = new ProductBrowser(app, {
        title: "6 скидок для меня", serverSort: false, autoLoad: false,
        emptyText: "ВкусВилл пока не подобрал персональных скидок",
        loader: async () => { const d = await api.personalDiscounts(); const items = d.items ?? d.products ?? []; return { items, total: items.length, hasMore: false }; },
      });
    } else if (id === "lp") {
      v = new ProductBrowser(app, {
        title: "Любимый продукт", serverSort: false, autoLoad: false,
        emptyText: "Любимый продукт еще не выбран — это делается в приложении ВкусВилла",
        loader: async () => {
          const d = await api.favoriteProduct();
          const items = Array.isArray(d) ? d : d.items ?? d.products ?? (d.id ? [d] : d.product ? [d.product] : []);
          return { items, total: items.length, hasMore: false };
        },
      });
    } else if (id === "orders") v = new OrdersView(app);
    return (this.subs[id] = v);
  }

  onShow() {
    // Re-read local lists every time the view is shown
    for (const id of ["favs", "history"]) if (this.subs[id]) this.subs[id].reload();
    this.activate();
  }

  activate() {
    if (this.section.id !== "account" && !this.locked()) this.sub(this.section.id).onShow?.();
  }

  busy() { return !!this.signing || this.subs[this.section.id]?.busy?.(); }
  get animated() { return !!this.signing; }

  tick() {
    // A section loads whenever it becomes visible: chosen by mouse or keys, or unlocked by a sign-in
    // that happened elsewhere (`vv login` in another terminal)
    const key = `${this.section.id}:${this.locked()}`;
    if (key !== this.activeKey) { this.activeKey = key; this.activate(); }
    if (this.section.id !== "account" && !this.locked()) this.subs[this.section.id]?.tick?.();
  }

  focusTop() { this.focus = "nav"; }

  // Entry point from the header button and the palette: straight to signing in
  openSignIn() {
    this.nav.sel = 0;
    this.focus = "nav";
    this.signIn();
  }

  // ——— Signing in ———

  askClient() {
    this.app.overlay(new Prompt({
      title: "Данные клиента",
      note: ["client_id и client_secret пришли письмом после регистрации персонального агента."],
      fields: [
        { label: "client_id", placeholder: "из письма ВкусВилла", value: this.auth.clientId ?? "" },
        { label: "client_secret", placeholder: "из того же письма", hidden: true },
      ],
      onSubmit: ([clientId, clientSecret]) => {
        // VkusVill issues a secret with every personal client; an empty field only keeps the stored one
        const stored = auth.read();
        if (!clientSecret && !(stored?.clientId === clientId && stored?.clientSecret)) return "Нужен client_secret из письма ВкусВилла";
        try { auth.setClient({ clientId, clientSecret: clientSecret || undefined }); } catch (e) { return e.message; }
        this.signIn();
        return null;
      },
    }));
  }

  signIn({ allScopes = false } = {}) {
    if (this.signing) return;
    if (!this.auth.configured) return this.askClient();
    // After rights were added on the site, ask for everything again
    if (allScopes) auth.setClient({ clientId: this.auth.clientId, scopes: null });
    const ctl = new AbortController();
    const signing = { ctl, url: null, paste: null, notice: null };
    this.signing = signing;
    this.authError = null;
    auth.login({
      signal: ctl.signal,
      notice: (text) => { signing.notice = text; this.app.invalidate(); },
      open: (url) => { signing.url = url; openUrl(url); this.app.invalidate(); },
      paste: (signal) => new Promise((resolve, reject) => {
        signing.paste = resolve;
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    }).then(
      (rec) => {
        this.app.toast(`✓ Вход выполнен · до ${time(rec.expiresAt)}`);
        // Personal sections load afresh with the new token
        for (const id of ["orders", "lp", "personal"]) delete this.subs[id];
        this.activate();
      },
      (e) => { if (e.code !== "access_denied") this.authError = e.message; },
    ).finally(() => {
      if (this.signing === signing) this.signing = null;
      this.app.invalidate();
    });
  }

  pasteLink() {
    const signing = this.signing;
    if (!signing?.paste) return;
    this.app.overlay(new Prompt({
      title: "Ссылка после входа",
      note: ["Скопируйте адрес из строки браузера после подтверждения входа."],
      fields: [{ label: "адрес или код", placeholder: "http://…?code=…" }],
      onSubmit: ([text]) => { if (!text) return "Вставьте адрес"; signing.paste(text); return null; },
    }));
  }

  async signOut() {
    if (this.signingOut) return;
    this.signingOut = true;
    let r;
    try { r = await auth.logout(); } finally { this.signingOut = false; }
    for (const id of ["orders", "lp", "personal"]) delete this.subs[id];
    if (r) this.app.toast(r.revoked ? "Вышли: токены отозваны" : "Вышли: токены удалены с этого компьютера", T.orange);
  }

  // ——— Keys ———

  key(k) {
    const h = k.hot ?? k.name;
    if (this.signing && k.type === "key") {
      if (k.name === "escape") { this.signing.ctl.abort(); return true; }
      if (h === "v") { this.pasteLink(); return true; }
      if (h === "o" && this.signing.url) { openUrl(this.signing.url); return true; }
      if (h === "y" && this.signing.url) { copy(this.signing.url).then(() => this.app.toast("Ссылка скопирована")); return true; }
      // Everything else waits for the browser, except switching tabs
      return !(k.name === "tab" || k.name === "backtab" || /^[1-6]$/.test(k.ch ?? ""));
    }
    if (k.type === "key" && h === "L" && this.auth.signedIn && !this.auth.viaEnv) { this.signOut(); return true; }
    // Sign-in is one key away from the section list: no need to step into the content first
    const s0 = this.section;
    const wantsSignIn = (s0.id === "account" && !this.auth.signedIn) || this.locked(s0);
    if (k.type === "key" && k.name === "enter" && wantsSignIn) { this.signIn({ allScopes: this.missing(s0) }); return true; }
    if (k.type === "key" && s0.id === "account") {
      // Signed in, the account page has two buttons: ↑↓ choose, Enter presses
      if (this.focus === "content" && this.auth.signedIn && !this.auth.viaEnv) {
        if (k.name === "down" && this.accountSel === 0) { this.accountSel = 1; return true; }
        if (k.name === "up" && this.accountSel === 1) { this.accountSel = 0; return true; }
        if (k.name === "enter") { if (this.accountSel === 1) this.signOut(); else this.signIn({ allScopes: true }); return true; }
      }
      if (h === "c") { this.askClient(); return true; }
      if (h === "o" && !this.auth.configured) { openUrl(auth.REGISTRATION_URL); return true; }
      if (k.name === "enter" && this.auth.signedIn) { this.signIn({ allScopes: true }); return true; }
    }
    if (this.focus === "content") {
      const s = this.section;
      if (s.id === "account") {
        if (k.type === "key" && (k.name === "escape" || k.name === "left")) { this.focus = "nav"; return true; }
        return false;
      }
      if (this.locked(s) && k.type === "key") {
        if (k.name === "enter") { this.signIn({ allScopes: this.missing(s) }); return true; }
        if (h === "c") { this.askClient(); return true; }
        if (h === "o") { openUrl(auth.REGISTRATION_URL); return true; }
      }
      // The section gets the key first; ← and esc that it doesn't use go back to the section list
      if (!this.locked(s) && this.sub(s.id).key?.(k)) return true;
      if (k.type === "key" && (k.name === "escape" || k.name === "left")) { this.focus = "nav"; return true; }
      return false;
    }
    if (k.type !== "key") return false;
    if (this.nav.key(k, SECTIONS.length)) { this.activate(); return true; }
    if (k.name === "enter" || k.name === "right") { this.focus = "content"; this.activate(); return true; }
    return false;
  }

  hints() {
    if (this.signing) return [["esc", "отменить вход"], ["v", "вставить ссылку"], ["o", "открыть снова"], ["y", "скопировать ссылку"]];
    const out = [];
    const a = this.auth;
    if (this.section.id === "account") {
      if (!a.signedIn) out.push(["⏎", "войти"], ...(a.configured ? [["c", "сменить client_id"]] : [["o", "регистрация клиента"]]));
      else out.push(["⏎", "войти заново с новыми правами"], ["c", "сменить client_id"]);
      out.push(["↑↓", "раздел"]);
    } else if (this.locked()) {
      out.push(["⏎", "войти"], ["↑↓", "раздел"]);
    } else if (this.focus === "content") out.push(["esc", "к разделам"], ...(this.sub(this.section.id).hints?.() ?? []));
    else out.push(["↑↓", "раздел"], ["⏎ →", "открыть"]);
    if (this.auth.signedIn && !this.auth.viaEnv) out.push(["L", "выйти"]);
    return out;
  }

  // ——— Drawing ———

  draw(g, r) {
    const app = this.app;
    const a = this.auth;
    g.fill(r.x, r.y, r.w, r.h, T.bg);
    const nw = 28;
    g.fill(r.x, r.y, nw, r.h, T.panel2);
    g.text(r.x + 2, r.y + 1, "Профиль", { fg: T.lime, bold: true, bg: T.panel2 });
    // Fits the 24-cell column: rights as "n из m", the expiry only when it will not renew itself
    const all = Object.keys(auth.SCOPE_LABELS).filter((s) => s !== "offline_access").length;
    const rights = a.granted ? a.granted.filter((s) => s in auth.SCOPE_LABELS && s !== "offline_access").length : null;
    const who = a.viaEnv ? "вход по VV_TOKEN"
      : a.signedIn ? `${a.refreshable ? "вход" : `вход до ${time(a.expiresAt)}`}${rights != null ? ` · права ${rights} из ${all}` : ""}`
      : a.configured ? "вход истек" : "без входа";
    g.text(r.x + 2, r.y + 2, who, { fg: a.signedIn ? T.green : a.configured ? T.orange : T.dim, bg: T.panel2 });
    g.hline(r.x, r.y + 3, nw, T.line);
    this.nav.draw(g, app, r.x, r.y + 4, nw, SECTIONS.length, SECTIONS, (s, _i, y, sel) => {
      const bg = sel ? (this.focus === "nav" ? T.selHi : T.sel) : T.panel2;
      g.fill(r.x, y, nw, 1, bg);
      if (sel) g.text(r.x, y, "▌", { fg: T.lime, bg });
      g.text(r.x + 2, y, s.icon, { fg: s.id === "favs" ? T.pink : T.lime, bg });
      const signInItem = s.id === "account" && !this.auth.signedIn;
      g.text(r.x + 4, y, this.label(s), { fg: signInItem ? T.lime : sel ? T.white : T.text, bold: sel || signInItem, bg });
      const n = s.id === "favs" ? store.favs.length : s.id === "history" ? store.history.length : null;
      if (n) g.textR(r.x + nw - 2, y, String(n), { fg: T.dim, bg });
      if (this.locked(s)) g.textR(r.x + nw - 2, y, "⊘", { fg: T.mute, bg });
    }, { scrollbar: false, onPick: (s) => {
      if (s.id === "account" && !this.auth.signedIn || this.locked(s)) return this.signIn({ allScopes: this.missing(s) });
      this.focus = "content";
      this.activate();
    } });
    // Counters
    let y = r.y + 5 + SECTIONS.length;
    g.hline(r.x, y++, nw, T.line);
    for (const [label, v] of [["в корзине", `${store.count} · ${rub(store.total)}`], ["избранное", store.favs.length], ["запросов в истории", store.queries.length]]) {
      g.text(r.x + 2, ++y, label, { fg: T.dim, bg: T.panel2 });
      g.textR(r.x + nw - 2, y, String(v), { fg: T.sub, bg: T.panel2 });
    }
    const cr = { x: r.x + nw + 1, y: r.y, w: r.w - nw - 1, h: r.h };
    const s = this.section;
    app.hit(cr.x, cr.y, cr.w, cr.h, { click: () => { this.focus = "content"; }, passive: false });
    if (this.signing) return this.drawSigning(g, cr);
    if (s.id === "account") return a.signedIn ? this.drawAccount(g, cr) : this.drawLocked(g, cr, s);
    if (this.locked(s)) return this.drawLocked(g, cr, s);
    this.sub(s.id).draw(g, cr);
    if (this.focus !== "content") g.tint(cr.x, cr.y, 1, cr.h, T.bg);
  }

  drawLocked(g, r, s) {
    const app = this.app;
    const a = this.auth;
    g.fill(r.x, r.y, r.w, r.h, T.panel);
    const art = [
      "   ╭───────╮   ",
      "   │ ╭───╮ │   ",
      "   │ │   │ │   ",
      " ╭─┴─┴───┴─┴─╮ ",
      " │     ◉     │ ",
      " │     ┃     │ ",
      " ╰───────────╯ ",
    ];
    const ax = r.x + Math.floor((r.w - 15) / 2);
    let y = r.y + Math.max(1, Math.floor(r.h / 2) - 11);
    art.forEach((l, i) => g.text(ax, y + i, l, { fg: i >= 3 ? T.lime : T.green, bg: T.panel }));
    y += art.length + 1;
    const c = (t, st) => g.textC(r.x, r.w, y++, t, { bg: T.panel, ...st });
    const button = (label, fn) => {
      const w = strWidth(label) + 2;
      const bx = r.x + Math.floor((r.w - w) / 2);
      g.pill(bx, y, label, { fg: T.bg, bg: T.lime, bold: true });
      app.hit(bx, y, w, 1, { click: fn });
      y++;
    };
    if (this.missing(s)) {
      c(`«${s.label}» — этому клиенту не выдано «${auth.scopeLabel(s.scope)}»`, { fg: T.white, bold: true });
      y++;
      // Rights as a left-aligned list, like the registration steps
      const have = a.granted.filter((x) => x !== "offline_access").map((x) => `✓ ${auth.scopeLabel(x)}`);
      const lx = r.x + Math.max(2, Math.floor((r.w - Math.max(15, ...have.map(strWidth))) / 2));
      g.text(lx, y++, "Выданные права:", { fg: T.dim, bg: T.panel });
      for (const line of have) g.text(lx, y++, line, { fg: T.sub, bg: T.panel });
      y++;
      c("Отметьте это действие в настройках клиента на vkusvill.ru и войдите заново:", { fg: T.sub });
      y++;
      button("⏎  войти с новыми правами", () => this.signIn({ allScopes: true }));
      return;
    }
    c(s.id === "account" ? "Вход во ВкусВилл — для заказов, любимого продукта и личных скидок" : `«${s.label}» — после входа`, { fg: T.white, bold: true });
    y++;
    if (this.authError) { c(`⚠ ${this.authError}`, { fg: T.red }); y++; }
    if (a.configured) {
      c(a.clientId ? `Клиент ${a.clientId} · ${a.signedIn ? "" : "вход истек"}`.replace(/ · $/, "") : "", { fg: T.dim });
      y++;
      button("⏎  войти", () => this.signIn());
      y++;
      c("c — сменить client_id", { fg: T.dim });
      return;
    }
    c("ВкусВилл пускает к личным данным только через вашего персонального агента:", { fg: T.sub });
    y++;
    // Steps share one left edge
    const steps = [
      ["1. Зарегистрируйте его на vkusvill.ru/oauth/registration/", "o — открыть", T.text],
      ["2. Отметьте «У моего сервиса нет публичного URI»", "", T.text],
      [`   ВкусВилл подставит ${auth.DEFAULT_REDIRECT} — его ловит приложение`, "", T.dim],
      ["3. client_id придет на почту — введите его здесь", "", T.text],
    ];
    const sw = Math.max(...steps.map(([t, k]) => strWidth(t) + (k ? strWidth(k) + 3 : 0)));
    const sx = r.x + Math.max(2, Math.floor((r.w - sw) / 2));
    for (const [t, k, fg] of steps) {
      const ex = g.text(sx, y, t, { fg, bg: T.panel });
      if (k) g.text(ex + 3, y, k, { fg: T.lime, bg: T.panel });
      y++;
    }
    y++;
    button("⏎  войти", () => this.askClient());
    y++;
    c("Каталог, акции, рецепты, магазины и корзина работают без входа.", { fg: T.dim });
  }

  drawAccount(g, r) {
    const app = this.app;
    const a = this.auth;
    g.fill(r.x, r.y, r.w, r.h, T.panel);
    const x = r.x + 4;
    let y = r.y + 2;
    g.text(x, y++, "Аккаунт ВкусВилла", { fg: T.white, bold: true, bg: T.panel });
    y++;
    if (a.viaEnv) {
      g.text(x, y++, "Вход по готовому токену из VV_TOKEN.", { fg: T.sub, bg: T.panel });
      return;
    }
    const row = (k, v, fg = T.text) => { g.text(x, y, k, { fg: T.dim, bg: T.panel }); g.text(x + 12, y++, v, { fg, bg: T.panel }); };
    row("клиент", a.clientId ?? "—");
    row("секреты", a.storage ?? "—", T.text);
    if (a.secretsAt) row("", truncate(a.secretsAt, r.w - 20), T.dim);
    row("вход", a.refreshable ? "продлевается сам" : `до ${time(a.expiresAt)}, потом войти заново`, a.refreshable ? T.green : T.orange);
    y++;
    g.text(x, y++, "Права", { fg: T.dim, bg: T.panel });
    const granted = a.granted;
    for (const sc of Object.keys(auth.SCOPE_LABELS).filter((s) => s !== "offline_access")) {
      const has = !granted || granted.includes(sc);
      g.text(x, y, has ? "✓" : "·", { fg: has ? T.lime : T.mute, bg: T.panel });
      g.text(x + 2, y++, auth.scopeLabel(sc) + (has ? "" : " — не выдано"), { fg: has ? T.text : T.dim, bg: T.panel });
    }
    y++;
    if (granted && Object.keys(auth.SCOPE_LABELS).some((s) => s !== "offline_access" && !granted.includes(s))) {
      g.text(x, y++, "Отметили на vkusvill.ru новые действия? Войдите заново:", { fg: T.sub, bg: T.panel });
      y++;
    }
    const btn = (label, fn, prim) => {
      // The pill's own padding sits left of the text column
      g.pill(x - 1, y, label, { fg: prim ? T.bg : T.sub, bg: prim ? T.lime : T.raise, bold: prim });
      app.hit(x - 1, y, strWidth(label) + 2, 1, { click: fn });
      y += 2;
    };
    const sel = this.focus === "content" && !app.headerFocus ? this.accountSel ?? 0 : -1;
    btn(`${sel === 0 ? "▸ " : ""}войти заново`, () => this.signIn({ allScopes: true }), sel === 0 || sel === -1);
    btn(`${sel === 1 ? "▸ " : ""}выйти`, () => this.signOut(), sel === 1);
  }

  drawSigning(g, r) {
    const app = this.app;
    g.fill(r.x, r.y, r.w, r.h, T.panel);
    let y = r.y + Math.max(1, Math.floor(r.h / 2) - 5);
    const c = (t, st) => g.textC(r.x, r.w, y++, t, { bg: T.panel, ...st });
    c(`${"⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[app.frame % 10]}  Жду подтверждения входа в браузере`, { fg: T.lime, bold: true });
    y++;
    c("Страница ВкусВилла открылась в браузере. После подтверждения все продолжится само.", { fg: T.sub });
    if (this.signing.notice) c(`${this.signing.notice} — v`, { fg: T.orange });
    else c("Если браузер ушел на адрес, который не открылся, — v и вставьте его.", { fg: T.dim });
    y++;
    if (this.signing.url) c(this.signing.url, { fg: T.mute });
    y++;
    c("esc — отменить", { fg: T.dim });
  }
}

class OrdersView {
  constructor(app) {
    this.app = app;
    this.list = new ListView();
    this.items = [];
    this.page = 0;
    this.loading = false;
  }
  busy() { return this.loading; }
  onShow() { if (!this.page && !this.loading) this.load(); }

  // Ten orders per page; the next page loads when the selection nears the end
  tick() {
    if (this.hasMore && !this.loading && !this.error && this.page && this.list.sel >= this.items.length - 3) this.load();
  }

  async load() {
    this.loading = true;
    this.error = null;
    try {
      const d = await api.orders(this.page + 1);
      const items = d.items ?? d.orders ?? [];
      this.items.push(...items);
      this.page++;
      this.hasMore = items.length > 0 && (d.meta?.has_more ?? items.length >= 10);
    } catch (e) { this.error = e.message; }
    this.loading = false;
    this.app.invalidate();
  }
  async repeat(o) {
    const prods = o?.products ?? [];
    if (!prods.length) return;
    this.app.toast(`Повторяю заказ: ${prods.length} ${plural(prods.length, "товар", "товара", "товаров")}…`);
    let ok = 0;
    await Promise.all(prods.map(async (pr) => {
      try { const p = normalize(await api.details(pr.id)); store.add(p, (pr.q ?? pr.quantity ?? qtyStep(p))); ok++; } catch {}
    }));
    this.app.toast(`Добавлено в корзину: ${ok} из ${prods.length}`);
  }
  key(k) {
    if (k.type !== "key") return false;
    if (this.list.key(k, this.items.length)) return true;
    if (k.name === "enter" || k.name === "right") { this.openOrder(this.items[this.list.sel]); return true; }
    if ((k.hot ?? k.name) === "+") { this.repeat(this.items[this.list.sel]); return true; }
    if ((k.hot ?? k.name) === "R" && this.error) { this.page = 0; this.items = []; this.load(); return true; }
    return false;
  }
  hints() { return [["↑↓", "заказ"], ["⏎", "состав"], ["+", "повторить заказ"]]; }

  // An order opens as a regular product list: photos, prices, single items to the cart
  openOrder(o) {
    const prods = o?.products ?? [];
    if (!prods.length) return;
    const b = new ProductBrowser(this.app, {
      title: `Заказ № ${o.id_general ?? o.id}`,
      serverSort: false, autoLoad: false,
      emptyText: "Товаров этого заказа больше нет в каталоге",
      hintsExtra: [["P", "повторить весь заказ"]],
      keyHook: (k) => ((k.hot ?? k.name) === "P" ? (this.repeat(o), true) : false),
      loader: async () => {
        const items = (await Promise.all(prods.map((p) => api.details(p.id).catch(() => null)))).filter(Boolean);
        return { items, total: items.length, hasMore: false };
      },
    });
    const base = b.hints.bind(b);
    b.hints = () => [["← esc", "к заказам"], ...base()];
    this.app.push(b);
  }
  draw(g, r) {
    g.fill(r.x, r.y, r.w, r.h, T.panel);
    g.text(r.x + 2, r.y, "Заказы за 30 дней", { fg: T.lime, bold: true, bg: T.panel });
    if (!this.items.length) { g.textC(r.x, r.w, r.y + Math.floor(r.h / 2), this.error ? `⚠ ${this.error}` : this.loading || !this.page ? "Загружаю заказы…" : "Заказов нет", { fg: this.error ? T.red : T.dim, bg: T.panel }); return; }
    this.list.draw(g, this.app, r.x, r.y + 2, r.w - 1, r.h - 2, this.items, (o, _i, y, sel) => {
      const bg = sel ? T.selHi : T.panel;
      g.fill(r.x, y, r.w - 1, 3, bg);
      const date = o.created_at ? new Date(o.created_at * (o.created_at < 1e12 ? 1000 : 1)).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) : "";
      g.spans(r.x + 2, y, [[`№ ${o.id_general ?? o.id}`, { fg: T.white, bold: true, bg }], [`  ${date} · ${o.service ?? ""}`, { fg: T.sub, bg }]]);
      if (o.status_name) g.pill(r.x + r.w - 16 - strWidth(o.status_name), y, o.status_name, { fg: T.bg, bg: T.green });
      g.textR(r.x + r.w - 3, y, rub(typeof o.price === "object" ? o.price?.price : o.price), { fg: T.lime, bold: true, bg });
      g.textW(r.x + 2, y + 1, (o.products ?? []).map((p) => p.name).join(" · "), r.w - 6, { fg: T.dim, bg });
    }, { rowH: 3, onPick: (o) => this.openOrder(o) });
  }
}

