// Splash screen, help, command palette, barcode lookup, analogs and product comparison.

import { T, mix, ramp, BRAND } from "../ui/theme.js";
import { TextInput, ListView, shadow } from "../ui/widgets.js";
import { LEAF, LOGO_GLYPH } from "../ui/draw.js";
import { ProductBrowser } from "./browser.js";
import { productView } from "./product.js";
import { perKg, flagPills } from "../ui/product-ui.js";
import { image } from "../image.js";
import * as api from "../api.js";
import * as auth from "../auth.js";
import { normalize, rub, compactNum } from "../product.js";
import { store } from "../store.js";
import { TABS } from "../app.js";
import { truncate } from "../term/width.js";

// ——— Splash ———
export class Splash {
  constructor(app, { duration = 1900 } = {}) {
    this.app = app;
    this.t0 = Date.now();
    this.duration = duration;
    this.animated = true;
    this.leaves = Array.from({ length: 26 }, () => ({ x: Math.random(), y: Math.random() * -1, v: 0.004 + Math.random() * 0.01, s: Math.random() * 6, ch: "⠁⠂⠄⡀⢀⠠⠐⠈❖◆✦·"[Math.floor(Math.random() * 12)] }));
    this.timer = setTimeout(() => this.close(), duration);
  }
  close() { clearTimeout(this.timer); this.app.closeOverlay(this); }
  key() { this.close(); }
  hints() { return [["любая клавиша", "войти"]]; }
  draw(g, app) {
    const now = Date.now();
    const t = (now - this.t0) / this.duration;
    // Leaves move by elapsed time, not per frame: the same speed at any redraw rate
    const dt = Math.min(5, (now - (this.last ?? now)) / 90);
    this.last = now;
    g.fill(0, 0, g.w, g.h, T.bg);
    // Falling leaves and dots
    for (const l of this.leaves) {
      l.y += l.v * dt;
      if (l.y > 1) { l.y = -0.05; l.x = Math.random(); }
      const x = Math.floor((l.x + Math.sin(l.y * 6 + l.s) * 0.02) * g.w), y = Math.floor(l.y * g.h);
      if (y >= 0 && y < g.h) g.text(x, y, l.ch, { fg: mix(T.greenDD, T.green, Math.max(0, Math.min(1, l.y))) });
    }
    const big = g.w >= 110 && g.h >= 26;
    const word = "ВКУСВИЛЛ";
    const scale = big ? 2 : 1;
    const ww = g.logoWidth(word) * scale;
    const leafW = 10 * scale;
    const total = leafW + 3 * scale + ww;
    const x0 = Math.floor((g.w - total) / 2);
    const y0 = Math.max(1, Math.floor(g.h / 2) - (big ? 9 : 6));
    const sweep = (px, py, w) => ramp(BRAND, ((px / (w || 1)) * 0.6 + t * 1.6 + py * 0.02) % 1);
    // Leaf
    g.bitmap(x0, y0, leafW, 7 * scale, (px, py) => (LEAF[Math.floor(py / scale)]?.[Math.floor(px / scale)] === "#" ? ramp([T.lime, T.green, T.greenD], py / (7 * scale)) : -1));
    // Letters: a pixel-font mask scaled up by `scale`, with a moving gradient
    const mask = logoMask(word);
    const mw = mask[0].length;
    g.bitmap(x0 + leafW + 3 * scale, y0, mw * scale, 7 * scale, (px, py) => (mask[Math.floor(py / scale)]?.[Math.floor(px / scale)] ? sweep(px, py, mw * scale) : -1));
    const ty = y0 + (big ? 8 : 5);
    g.textC(0, g.w, ty, "в  т е р м и н а л е", { fg: T.lime, bold: true });
    g.textC(0, g.w, ty + 2, "каталог · акции · рецепты · магазины · корзина с QR-кодом", { fg: T.sub });
    // Progress bar
    const bw = Math.min(40, g.w - 10);
    g.gradBar(Math.floor((g.w - bw) / 2), ty + 4, bw, Math.min(1, t * 1.1), [T.greenD, T.green, T.lime], T.panel);
    g.textC(0, g.w, ty + 6, "данные: официальный MCP ВкусВилла · mcp.vkusvill.ru", { fg: T.mute });
    app.hit(0, 0, g.w, g.h, { click: () => this.close() });
  }
}

function logoMask(word) {
  const rows = Array.from({ length: 7 }, () => []);
  for (const c of word) {
    const glyph = LOGO_GLYPH(c);
    for (let py = 0; py < 7; py++) rows[py].push(...[...glyph[py]].map((ch) => ch === "#"), false);
  }
  rows.forEach((r) => r.pop());
  return rows;
}

// ——— Help ———
export class Help {
  constructor() { this.scroll = 0; this.maxScroll = 0; }
  key(k, app) {
    if (k.name === "down") this.scroll = Math.min(this.maxScroll, this.scroll + 1);
    else if (k.name === "up") this.scroll = Math.max(0, this.scroll - 1);
    else app.closeOverlay(this);
  }
  hints() { return [["любая клавиша", "закрыть"]]; }
  draw(g, app) {
    const cols = [
      ["ВЕЗДЕ", [["↑ ↓", "по строкам экрана: поиск, фильтры, список"], ["← → ⏎", "внутри строки: чипы, кнопки"], ["↑ у края", "в шапку: ← → вкладки, ↓ обратно"], ["1…6 / Tab", "вкладки"], ["^K или :", "палитра команд"], ["b", "товар по штрихкоду"], ["c", "корзина"], ["esc", "назад"], ["?", "эта справка"], ["q / ^C", "выход"], ["мышь", "клик, двойной клик, колесо"]]],
      ["ТОВАРЫ", [["/ или .", "поиск"], ["↑↓ j k", "выбор"], ["⏎ →", "карточка товара"], ["+ −", "в корзину / убрать"], ["*", "в избранное"], ["s", "сортировка"], ["f", "фильтры состава"], ["g", "категория (каталог)"], ["x / X", "отметить / сравнить"], ["o", "открыть на сайте"]]],
      ["КАРТОЧКА", [["→ ⏎", "открыть из списка"], ["← esc", "назад к списку"], ["← →", "листать фото"], ["[ ]", "соседний товар"], ["a", "аналоги"], ["PgUp PgDn", "прокрутка"]]],
      ["КОРЗИНА", [["← → + −", "количество"], ["d / Del", "убрать"], ["p", "оформить и оплатить: ссылка и QR"], ["u", "сверить цены"], ["D D", "очистить"]]],
      ["РЕЦЕПТЫ", [["f", "фильтры, аллергены"], ["␣", "отметить ингредиент"], ["a", "отметить все"], ["+", "ингредиенты в корзину"], ["s", "шаги на узком экране"]]],
      ["ПРОФИЛЬ", [["⏎", "войти во ВкусВилл"], ["c", "сменить client_id"], ["v", "вставить ссылку после входа"], ["L", "выйти и отозвать токены"]]],
      ["МАГАЗИНЫ", [["/", "поиск по адресу"], ["r g m f", "регион, город, метро, особ."], ["z ⏎", "приблизить карту"], ["L", "загрузить все на карту"], ["v", "карта на узком экране"], ["p", "Яндекс Карты"], ["y", "скопировать адрес"]]],
    ];
    const w = Math.min(g.w - 4, 104), h = Math.min(g.h - 2, 30);
    const x = Math.floor((g.w - w) / 2), y = Math.floor((g.h - h) / 2);
    shadow(g, x, y, w, h);
    g.box(x, y, w, h, { fg: T.lineHi, bg: T.panel2, title: "Клавиши", titleFg: T.lime, right: "горячие клавиши работают и в русской раскладке" });
    const cw = Math.floor((w - 4) / 2);
    const colY = [y + 2, y + 2];
    cols.forEach(([title, rows]) => {
      const c = colY[0] <= colY[1] ? 0 : 1;
      let cy = colY[c] - this.scroll;
      const cx = x + 2 + c * cw;
      if (cy >= y + 1 && cy < y + h - 1) g.text(cx, cy, title, { fg: T.lime, bold: true, bg: T.panel2 });
      cy++;
      for (const [k, d] of rows) {
        if (cy >= y + 1 && cy < y + h - 1) {
          g.text(cx, cy, truncate(k, 12), { fg: T.yellow, bold: true, bg: T.panel2 });
          g.textW(cx + 13, cy, d, cw - 15, { fg: T.text, bg: T.panel2 });
        }
        cy++;
      }
      colY[c] = cy + 1 + this.scroll;
    });
    this.maxScroll = Math.max(0, Math.max(...colY) - (y + h - 2));
    g.textC(x, w, y + h - 2, `кэш: ${api.CACHE_DIR}`, { fg: T.mute, bg: T.panel2 });
    app.hit(x, y, w, h, { click: () => app.closeOverlay(this) });
  }
}

// ——— Command palette ———
export class Palette {
  constructor(app) {
    this.app = app;
    this.input = new TextInput({ placeholder: "команда или что найти…", onChange: () => { this.list.sel = 0; } });
    this.list = new ListView();
    this.animated = true; // blinking cursor
  }

  commands() {
    const app = this.app;
    const q = this.input.value.trim();
    const cmds = [];
    if (q) {
      cmds.push({ label: `Искать «${q}» в каталоге`, hint: "⏎", run: () => app.views.searchCatalog(app, q) });
      cmds.push({ label: `Искать рецепты «${q}»`, run: () => app.views.searchRecipes(app, q) });
      if (/^\d{13}$/.test(q)) cmds.push({ label: `Штрихкод ${q}`, run: () => openBarcode(app, q) });
    }
    const st = auth.cachedStatus();
    if (!st.signedIn) cmds.push({ label: "Войти", hint: "ВкусВилл", run: () => app.views.signIn(app) });
    else if (!st.viaEnv) cmds.push({ label: "Выйти", hint: "ВкусВилл", run: () => app.views.signOut(app) });
    TABS.forEach((t, i) => cmds.push({ label: `Перейти: ${t.label}`, hint: String(i + 1), run: () => app.switchTab(t.id) }));
    cmds.push({ label: "Оформить корзину — ссылка и QR", hint: rub(store.total), run: () => { app.switchTab("cart"); app.page.checkout?.(); } });
    cmds.push({ label: "Товар по штрихкоду", hint: "b", run: () => app.views.barcode(app) });
    cmds.push({ label: `Сравнить отмеченные (${app.compare.size})`, hint: "X", run: () => app.openCompare() });
    cmds.push({ label: "Очистить сравнение", run: () => { app.compare.clear(); app.toast("Сравнение очищено"); } });
    cmds.push({ label: "Очистить корзину", run: () => { store.clearCart(); app.toast("Корзина очищена", T.orange); } });
    cmds.push({ label: "Справка по клавишам", hint: "?", run: () => app.views.help(app) });
    for (const r of store.queries.slice(0, 8)) cmds.push({ label: `Недавний поиск: ${r}`, run: () => app.views.searchCatalog(app, r) });
    cmds.push({ label: "Выход", hint: "q", run: () => app.quit() });
    if (!q) return cmds;
    const ql = q.toLowerCase();
    const fuzzy = (s) => { let i = 0; for (const c of s.toLowerCase()) if (c === ql[i]) i++; return i === ql.length; };
    return cmds.filter((c, i) => i < 2 || c.label.toLowerCase().includes(ql) || fuzzy(c.label));
  }

  key(k, app) {
    const cmds = this.commands();
    if (k.name === "escape") return app.closeOverlay(this);
    if (k.name === "enter") { const c = cmds[this.list.sel]; app.closeOverlay(this); c?.run(); return; }
    if (["up", "down", "pageup", "pagedown"].includes(k.name)) return this.list.key(k, cmds.length);
    this.input.key(k);
  }

  hints() { return [["↑↓", "выбор"], ["⏎", "выполнить"], ["esc", "закрыть"]]; }

  draw(g, app) {
    const cmds = this.commands();
    const w = Math.min(g.w - 4, 72), rows = Math.min(cmds.length, g.h - 10, 14);
    const h = rows + 4;
    const x = Math.floor((g.w - w) / 2), y = Math.max(2, Math.floor(g.h / 5));
    shadow(g, x, y, w, h);
    g.box(x, y, w, h, { fg: T.lineHi, bg: T.panel2, title: "Команды", titleFg: T.lime, right: "Ctrl+K" });
    g.text(x + 2, y + 1, "›", { fg: T.lime, bold: true, bg: T.panel2 });
    this.input.draw(g, x + 4, y + 1, w - 6, { bg: T.panel2, blink: app.frame % 10 < 7 });
    g.hline(x + 1, y + 2, w - 2, T.line);
    this.list.draw(g, app, x + 1, y + 3, w - 3, rows, cmds, (c, _i, ry, sel) => {
      const bg = sel ? T.selHi : T.panel2;
      g.fill(x + 1, ry, w - 3, 1, bg);
      g.text(x + 2, ry, sel ? "▸" : " ", { fg: T.lime, bg });
      g.textW(x + 4, ry, c.label, w - 16, { fg: sel ? T.white : T.text, bold: sel, bg });
      if (c.hint) g.textR(x + w - 3, ry, c.hint, { fg: T.dim, bg });
    }, { onPick: (c) => { app.closeOverlay(this); c.run(); } });
  }
}

// ——— Barcode ———
export class Barcode {
  constructor(app) {
    this.app = app;
    this.input = new TextInput({ placeholder: "13 цифр EAN-13", filter: (c) => /\d/.test(c) });
    this.animated = true;
  }
  key(k, app) {
    if (k.name === "escape") return app.closeOverlay(this);
    if (k.name === "enter") {
      const v = this.input.value;
      if (!/^\d{13}$/.test(v)) { this.error = "нужно ровно 13 цифр"; return; }
      app.closeOverlay(this);
      openBarcode(app, v);
      return;
    }
    this.error = null;
    this.input.key(k);
  }
  hints() { return [["⏎", "найти"], ["esc", "отмена"]]; }
  draw(g, app) {
    const w = 52, h = 9;
    const x = Math.floor((g.w - w) / 2), y = Math.floor((g.h - h) / 2);
    shadow(g, x, y, w, h);
    g.box(x, y, w, h, { fg: T.lineHi, bg: T.panel2, title: "Товар по штрихкоду", titleFg: T.lime });
    // A pseudo barcode drawn from the digits typed so far
    const digits = this.input.value.padEnd(13, "0");
    let bars = "";
    for (const d of digits) bars += ["▌▏▍", "▏▌▎", "▎▍▏", "▍▏▌", "▏▎▍", "▌▍▏", "▎▏▌", "▍▌▏", "▏▍▎", "▌▎▏"][+d];
    g.textC(x, w, y + 2, bars, { fg: this.input.value ? T.white : T.mute, bg: T.panel2 });
    g.textC(x, w, y + 3, bars, { fg: this.input.value ? T.white : T.mute, bg: T.panel2 });
    g.fill(x + 13, y + 5, 26, 1, T.raise);
    this.input.draw(g, x + 14, y + 5, 24, { bg: T.raise, blink: app.frame % 10 < 7 });
    g.textR(x + 39, y + 5, `${this.input.value.length}/13`, { fg: T.dim, bg: T.raise });
    if (this.error) g.textC(x, w, y + 7, this.error, { fg: T.red, bg: T.panel2 });
    else g.textC(x, w, y + 7, "цифры под полосками на упаковке", { fg: T.dim, bg: T.panel2 });
  }
}

export async function openBarcode(app, code) {
  app.toast(`Ищу штрихкод ${code}…`, T.dim);
  try {
    const p = normalize(await api.barcode(code));
    if (!p?.id) throw new Error("Товар не найден");
    store.viewed(p);
    app.push(productView(app, p));
  } catch (e) {
    app.toast(`⚠ ${e.message}`, T.red);
  }
}

// ——— Analogs ———
export function analogsView(app, p) {
  const b = new ProductBrowser(app, {
    title: `Аналоги: ${p.title}`,
    serverSort: false,
    autoLoad: false,
    emptyText: "ВкусВилл не знает аналогов этого товара",
    loader: async () => {
      const d = await api.analogs(p.id);
      const items = d.products ?? d.items ?? [];
      return { items, total: items.length, hasMore: false };
    },
  });
  const base = b.hints.bind(b);
  b.hints = () => [["← esc", "назад"], ...base()];
  app.push(b);
}

// ——— Comparison ———
export class CompareView {
  constructor(app) {
    this.app = app;
    this.scroll = 0;
  }
  key(k) {
    const h = k.hot ?? k.name;
    if (h === "x" || h === "D") { this.app.compare.clear(); this.app.pop(); this.app.toast("Сравнение очищено"); return true; }
    return false;
  }
  hints() { return [["← esc", "назад"], ["x", "очистить сравнение"]]; }
  draw(g, r) {
    const app = this.app;
    const ps = [...app.compare.values()];
    g.fill(r.x, r.y, r.w, r.h, T.bg);
    g.text(r.x + 2, r.y, `СРАВНЕНИЕ · ${ps.length}`, { fg: T.lime, bold: true });
    if (!ps.length) { g.textC(r.x, r.w, r.y + Math.floor(r.h / 2), "Отметьте товары клавишей x в любом списке", { fg: T.dim }); return; }
    const labelW = 16;
    const cw = Math.floor((r.w - labelW - 2) / ps.length);
    const rows = [
      ["Цена", (p) => p.price, rub, "min"],
      ["За кг", (p) => perKg(p) ?? (p.unit === "кг" ? p.price : null), (v) => (v == null ? "—" : `${rub(v)}/кг`), "min"],
      ["Рейтинг", (p) => p.rating || null, (v, p) => (v ? `★ ${v.toFixed(1).replace(".", ",")} · ${compactNum(p.votes)}` : "—"), "max"],
      ["Белки", (p) => p.p, (v) => (v == null ? "—" : `${String(v).replace(".", ",")} г`), "max", T.blue],
      ["Жиры", (p) => p.f, (v) => (v == null ? "—" : `${String(v).replace(".", ",")} г`), null, T.yellow],
      ["Углеводы", (p) => p.c, (v) => (v == null ? "—" : `${String(v).replace(".", ",")} г`), null, T.orange],
      ["Калории", (p) => p.kcal, (v) => (v == null ? "—" : `${Math.round(v)} ккал`), null, T.lime],
      ["Добавки", (p) => (p.comp ? p.flags.additives : null), (v) => (v == null ? "—" : v ? `${v}` : "нет"), "min"],
    ];
    let y = r.y + 2;
    const ph = Math.min(8, Math.floor(r.h * 0.28));
    ps.forEach((p, i) => {
      const x = r.x + labelW + i * cw;
      g.fill(x, y, cw - 1, r.h - 2, i % 2 ? T.panel : T.panel2);
      const img = image(p.thumb ?? p.images?.[0], cw - 3, ph);
      if (img && !img.error) g.photo(x + 1 + Math.floor((cw - 3 - img.w) / 2), y, img);
      g.para(x + 1, y + ph + 1, cw - 3, 2, p.title, { fg: T.white, bold: true });
      app.hit(x, y, cw - 1, ph + 3, { click: () => app.push(productView(app, p)) });
    });
    y += ph + 4;
    for (const [label, get, fmt, best, color] of rows) {
      if (y >= r.y + r.h - 1) break;
      g.text(r.x + 2, y, label, { fg: T.dim, bold: true });
      const vals = ps.map(get);
      const nums = vals.filter((v) => v != null);
      const target = best === "min" ? Math.min(...nums) : best === "max" ? Math.max(...nums) : null;
      const maxv = Math.max(...nums, 0);
      ps.forEach((p, i) => {
        const x = r.x + labelW + i * cw;
        const v = vals[i];
        const isBest = target != null && v === target && nums.length > 1;
        g.textW(x + 1, y, fmt(v, p), cw - 5, { fg: isBest ? T.lime : T.text, bold: isBest });
        if (isBest) g.text(x + cw - 4, y, "▲", { fg: T.lime });
        if (color && v != null && maxv) g.bar(x + 1, y + 1, cw - 4, v / maxv, color, T.raise);
      });
      y += color ? 3 : 2;
    }
    if (y < r.y + r.h - 1) {
      g.text(r.x + 2, y, "Состав", { fg: T.dim, bold: true });
      ps.forEach((p, i) => {
        const x = r.x + labelW + i * cw;
        let cy = y;
        for (const [label, col] of flagPills(p)) { if (cy >= r.y + r.h) break; g.pill(x + 1, cy++, label, { fg: col, bg: mix(col, T.panel, 0.82) }); }
      });
    }
  }
}

