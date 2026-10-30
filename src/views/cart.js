// Cart: lines with quantity steppers, the total in large digits, savings, calories and macros of the whole cart,
// a breakdown by category. Checkout is a VkusVill link plus a QR code right in the terminal.

import { T, mix, ramp } from "../ui/theme.js";
import { ListView, shadow } from "../ui/widgets.js";
import { G } from "../ui/draw.js";
import * as api from "../api.js";
import { normalize, rub, qtyText, qtyStep, lineTotal, lineGrams, plural } from "../product.js";
import { store, CART_MAX } from "../store.js";
import { productView } from "./product.js";
import { openUrl, copy } from "../sys.js";
import { strWidth, truncate } from "../term/width.js";

const STALE = 6 * 3600e3;

const CAT_COLORS = [T.green, T.lime, T.blue, T.orange, T.violet, T.yellow, T.pink, T.mint];

export function cartView(app) {
  return new CartView(app);
}

class CartView {
  constructor(app) {
    this.app = app;
    this.list = new ListView();
    this.confirmClear = false;
  }

  get lines() { return store.cart; }

  key(k) {
    if (k.type !== "key") return false;
    const lines = this.lines;
    // The checkout button is the zone below the last line: ↓ reaches it, ↑ comes back
    if (this.focus === "checkout") {
      if (k.name === "up" || k.name === "escape") { this.focus = "list"; return true; }
      if (k.name === "enter" || k.name === "space") { this.checkout(); return true; }
      if (k.name === "down") return true;
    } else if (k.name === "down" && lines.length && this.list.sel >= lines.length - 1) { this.focus = "checkout"; return true; }
    if (this.focus !== "checkout" && this.list.key(k, lines.length)) { this.confirmClear = false; return true; }
    const line = lines[this.list.sel];
    const h = k.hot ?? k.name;
    if (line && (h === "+" || h === "=" || k.name === "right")) { store.add(line.p, qtyStep(line.p)); return true; }
    if (line && (h === "-" || h === "_" || k.name === "left")) { store.add(line.p, -qtyStep(line.p)); return true; }
    if (line && (k.name === "delete" || k.name === "backspace" || h === "d")) { store.remove(line.p.id); this.app.toast(`Убрано: ${line.p.title}`, T.orange); return true; }
    if (line && k.name === "enter") { this.openLine(this.list.sel); return true; }
    // p — pay: checkout is where paying starts (the link opens VkusVill, which takes the payment)
    if (h === "o" || h === "p") { this.checkout(); return true; }
    if (h === "D") {
      if (!lines.length) return true;
      if (this.confirmClear) { store.clearCart(); this.confirmClear = false; this.app.toast("Корзина очищена", T.orange); }
      else { this.confirmClear = true; this.app.toast("Еще раз Shift+D — очистить корзину", T.red); }
      return true;
    }
    if (h === "u") { this.refresh(); return true; }
    return false;
  }

  hints() {
    if (!this.lines.length) return [["1", "в каталог"], ["2", "акции"], ["3", "рецепты"]];
    if (this.focus === "checkout") return [["⏎", "оформить: ссылка и QR"], ["↑", "к товарам"]];
    return [["↑↓", "выбор"], ["← →", "кол-во"], ["d", "убрать"], ["⏎", "товар"], ["p", "оформить и оплатить"], ["u", "обновить цены"], ["D", "очистить"]];
  }

  // A cart line opens with its neighbours, so [ and ] page through the cart
  openLine(i) {
    const lines = this.lines;
    if (lines[i]) this.app.push(productView(this.app, lines[i].p, { list: lines.map((l) => l.p), index: i }));
  }

  // Prices in the cart are snapshots: lines older than STALE are re-checked quietly in the background when the cart opens
  onShow() {
    if (!this.refreshing && store.stale(STALE).length) this.refresh({ quiet: true });
  }

  busy() { return this.refreshing; }

  async refresh({ quiet = false } = {}) {
    if (this.refreshing) return;
    const lines = quiet ? store.stale(STALE) : [...store.cart];
    if (!lines.length) return;
    this.refreshing = true;
    if (!quiet) this.app.toast("Сверяю цены…");
    let changed = 0, failed = 0;
    await Promise.all(lines.map(async (l) => {
      try {
        const p = normalize(await api.call("vkusvill_product_details", { id: l.p.id }, { prio: "lo", fresh: true }));
        if (store.refresh(l.p.id, p)) changed++;
      } catch { failed++; }
    }));
    this.refreshing = false;
    store.changed();
    if (changed) this.app.toast(`Цены изменились у ${changed} ${plural(changed, "товара", "товаров", "товаров")}`, T.orange);
    else if (!quiet) this.app.toast(failed ? `Не удалось сверить ${failed}` : "Цены актуальны", failed ? T.orange : T.lime);
  }

  checkout() {
    if (!store.cart.length) return this.app.toast("Корзина пуста", T.orange);
    this.app.overlay(new Checkout(this.app));
  }

  draw(g, r) {
    const app = this.app;
    g.fill(r.x, r.y, r.w, r.h, T.bg);
    const lines = this.lines;
    if (!lines.length) return this.drawEmpty(g, r);
    const sideW = r.w >= 100 ? Math.min(52, Math.floor(r.w * 0.38)) : 0;
    const lw = r.w - sideW - (sideW ? 1 : 0);
    g.fill(r.x, r.y, lw, r.h, T.panel);
    const n = lines.length;
    g.spans(r.x + 2, r.y, [["Корзина", { fg: T.lime, bold: true, bg: T.panel }], [`  ${n} ${plural(n, "позиция", "позиции", "позиций")} · до ${CART_MAX}`, { fg: T.dim, bg: T.panel }]]);
    g.hline(r.x, r.y + 1, lw, T.line);
    // Table: product | − qty + | sum
    // Wide enough: one line per item, the price details in a column of their own; otherwise two lines
    const right = 30, DETAILS = 30;
    const oneLine = lw - 4 - right - DETAILS >= 24;
    const rowH = oneLine ? 1 : 2;
    this.list.draw(g, app, r.x, r.y + 2, lw - 1, r.h - 2 - (sideW ? 0 : 1), lines, (l, _i, y, sel) => {
      const bg = sel ? (this.focus === "checkout" ? T.sel : T.selHi) : T.panel;
      g.fill(r.x, y, lw - 1, rowH, bg);
      for (let j = 0; j < rowH; j++) if (sel) g.text(r.x, y + j, "▌", { fg: T.lime, bg });
      const p = l.p;
      const details = [p.unit === "кг" ? `${rub(p.price)}/кг` : rub(p.price), p.old ? `было ${rub(p.old)}` : ""].filter(Boolean).join(" · ");
      // Stock at the user's address is known once prices were checked while signed in
      const stock = p.available === 0 ? ["нет в наличии", T.red] : p.available != null && p.available < l.q ? [`в наличии только ${p.available}`, T.orange] : null;
      if (oneLine) {
        const dx = r.x + lw - right - DETAILS;
        const tx = g.textW(r.x + 2, y, p.title, dx - r.x - 4, { fg: T.white, bold: sel, bg });
        if (p.pack) g.textW(tx + 1, y, p.pack, dx - tx - 2, { fg: T.dim, bg });
        g.textW(dx, y, stock ? stock[0] : details, DETAILS - 2, { fg: stock ? stock[1] : p.old ? T.orange : T.dim, bg });
      } else {
        g.textW(r.x + 2, y, p.title, lw - right - 4, { fg: T.white, bold: sel, bg });
        const sx2 = g.textW(r.x + 2, y + 1, [p.pack, details].filter(Boolean).join(" · "), lw - right - 4, { fg: p.old ? T.orange : T.dim, bg });
        if (stock) g.textW(sx2 + 2, y + 1, stock[0], Math.max(0, r.x + lw - right - 2 - sx2), { fg: stock[1], bg });
      }
      // Stepper
      const sx = r.x + lw - right;
      g.text(sx, y, " − ", { fg: T.white, bg: sel ? T.orange : T.raise, bold: true });
      app.hit(sx, y, 3, 1, { click: () => store.add(p, -qtyStep(p)) });
      const qt = qtyText(p, l.q);
      g.textC(sx + 3, 10, y, qt, { fg: T.white, bold: true, bg });
      g.text(sx + 13, y, " + ", { fg: T.bg, bg: sel ? T.lime : T.green, bold: true });
      app.hit(sx + 13, y, 3, 1, { click: () => store.add(p, qtyStep(p)) });
      // The remove cross sits under the total on two lines, after it on one
      g.textR(r.x + lw - (oneLine ? 4 : 2), y, rub(lineTotal(p, l.q)), { fg: T.lime, bold: true, bg });
      const xy = oneLine ? y : y + 1;
      g.text(r.x + lw - 3, xy, "×", { fg: T.mute, bg });
      app.hit(r.x + lw - 3, xy, 1, 1, { click: () => store.remove(p.id) });
    }, { rowH, onPick: (_l, i) => this.openLine(i) });
    if (sideW) this.drawSummary(g, { x: r.x + lw + 1, y: r.y, w: sideW - 1, h: r.h });
    else {
      const y = r.y + r.h - 1;
      g.fill(r.x, y, r.w, 1, T.panel2);
      g.spans(r.x + 2, y, [["Итого ", { fg: T.sub, bg: T.panel2 }], [rub(store.total), { fg: T.lime, bold: true, bg: T.panel2 }], [store.savings ? `  экономия ${rub(store.savings)}` : "", { fg: T.orange, bg: T.panel2 }]]);
      const label = " p  ОФОРМИТЬ ▶ ";
      g.textR(r.x + r.w - 1, y, label, { fg: T.bg, bg: T.lime, bold: true, underline: this.focus === "checkout" && !app.headerFocus });
      app.hit(r.x + r.w - 1 - strWidth(label), y, strWidth(label), 1, { click: () => this.checkout() });
    }
  }

  drawSummary(g, r) {
    const app = this.app;
    g.fill(r.x, r.y, r.w, r.h, T.panel2);
    let y = r.y + 1;
    const x = r.x + 2, w = r.w - 4;
    g.text(x, y++, "ИТОГО", { fg: T.dim, bold: true, bg: T.panel2 });
    g.bigPrice(x, y, store.total, T.lime);
    y += 6;
    const sav = store.savings;
    if (sav > 0) g.spans(x, y++, [["экономия по акциям ", { fg: T.sub, bg: T.panel2 }], [rub(sav), { fg: T.orange, bold: true, bg: T.panel2 }]]);
    y++;
    // Checkout button
    const label = "  ОФОРМИТЬ ВО ВКУСВИЛЛЕ  ▶ ";
    const bw = Math.min(w, strWidth(label));
    const onBtn = this.focus === "checkout" && !app.headerFocus;
    const pulse = onBtn ? T.lime : mix(T.green, T.lime, (Math.sin(app.frame / 4) + 1) / 4);
    g.fill(x, y, bw, 3, pulse);
    g.textC(x, bw, y + 1, label.trim(), { fg: T.bg, bg: pulse, bold: true, underline: onBtn });
    app.hit(x, y, bw, 3, { click: () => this.checkout() });
    this.animated = true;
    y += 4;
    g.textW(x, y++, "p — ссылка и QR-код, оплата у ВкусВилла", w, { fg: T.dim, bg: T.panel2 });
    y++;
    // Calories and macros of the cart
    const tot = { p: 0, f: 0, c: 0, kcal: 0, g: 0 };
    let known = 0;
    for (const l of store.cart) {
      const gr = lineGrams(l.p, l.q);
      if (!gr || l.p.kcal == null) continue;
      known++;
      tot.g += gr;
      for (const k of ["p", "f", "c", "kcal"]) tot[k] += ((l.p[k] ?? 0) * gr) / 100;
    }
    if (known && y + 6 < r.y + r.h) {
      g.text(x, y++, `В КОРЗИНЕ · ${(tot.g / 1000).toFixed(1).replace(".", ",")} кг продуктов`, { fg: T.dim, bold: true, bg: T.panel2 });
      const k = Math.round(tot.kcal).toLocaleString("ru-RU").replace(/\s/g, " ");
      g.spans(x, y++, [[k, { fg: T.lime, bold: true, bg: T.panel2 }], [" ккал", { fg: T.sub, bg: T.panel2 }], [`  ≈ ${Math.max(1, Math.round(tot.kcal / 2000))} ${plural(Math.max(1, Math.round(tot.kcal / 2000)), "день", "дня", "дней")} по 2000`, { fg: T.dim, bg: T.panel2 }]], w);
      const maxv = Math.max(tot.p, tot.f, tot.c, 1);
      for (const [name, v, col] of [["белки", tot.p, T.blue], ["жиры", tot.f, T.yellow], ["углев.", tot.c, T.orange]]) {
        g.text(x, y, name, { fg: T.sub, bg: T.panel2 });
        g.bar(x + 8, y, w - 17, v / maxv, col, T.raise);
        g.textR(x + w, y++, `${Math.round(v)} г`, { fg: T.text, bg: T.panel2 });
      }
      if (known < store.cart.length) g.text(x, y++, `без данных: ${store.cart.length - known}`, { fg: T.mute, bg: T.panel2 });
      y++;
    }
    // By category
    const byCat = new Map();
    for (const l of store.cart) {
      const c = l.p.category?.at(-1) ?? l.p.category?.[0] ?? "Другое";
      byCat.set(c, (byCat.get(c) ?? 0) + lineTotal(l.p, l.q));
    }
    const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
    if (cats.length && y + 3 < r.y + r.h) {
      g.text(x, y++, "КУДА УХОДЯТ ДЕНЬГИ", { fg: T.dim, bold: true, bg: T.panel2 });
      // Solid bar of shares
      let bx = 0;
      const total = store.total || 1;
      cats.forEach(([, v], i) => {
        const cw = i === cats.length - 1 ? w - bx : Math.round((v / total) * w);
        g.text(x + bx, y, " ".repeat(Math.max(0, cw)), { bg: CAT_COLORS[i % CAT_COLORS.length] });
        bx += cw;
      });
      y += 2;
      for (const [i, [name, v]] of cats.entries()) {
        if (y >= r.y + r.h - 1) break;
        g.text(x, y, "■", { fg: CAT_COLORS[i % CAT_COLORS.length], bg: T.panel2 });
        g.textW(x + 2, y, name, w - 14, { fg: T.sub, bg: T.panel2 });
        g.textR(x + w, y++, `${Math.round((v / total) * 100)}% ${rub(v)}`, { fg: T.text, bg: T.panel2 });
      }
    }
  }

  drawEmpty(g, r) {
    g.fill(r.x, r.y, r.w, r.h, T.bg);
    // Empty trolley in box-drawing art
    const art = [
      "   ┌─────────────────────┐",
      "───┤ ░░░░░░░░░░░░░░░░░░░ │",
      "   │ ░░░░░░░░░░░░░░░░░░░ │",
      "   │ ░░░░░░░░░░░░░░░░░░░ │",
      "   └──┬───────────────┬──┘",
      "      ◯               ◯",
    ];
    const ax = r.x + Math.floor((r.w - 26) / 2);
    const ay = r.y + Math.floor(r.h / 2) - 6;
    art.forEach((l, i) => g.text(ax, ay + i, l, { fg: i === 5 ? T.lime : T.green }));
    g.textC(r.x, r.w, ay + 8, "Корзина пуста", { fg: T.white, bold: true });
    g.textC(r.x, r.w, ay + 9, "найдите что-нибудь в каталоге (1) или загляните в акции (2)", { fg: T.dim });
    g.textC(r.x, r.w, ay + 10, "в рецептах (3) можно положить в корзину все ингредиенты разом", { fg: T.dim });
    this.animated = false;
  }
}

// Checkout: VkusVill link + QR code for the phone
class Checkout {
  constructor(app) {
    this.app = app;
    this.link = null;
    this.error = null;
    this.animated = true;
    this.make();
  }

  async make() {
    try {
      const products = store.cart.map((l) => ({ id: l.p.id, q: Math.round(l.q * 100) / 100 }));
      const d = await api.cartLink(products);
      this.link = d.link; // checked by api.cartLink: an https VkusVill address
    } catch (e) {
      this.error = e.message;
    }
    this.animated = false;
    this.app.invalidate();
  }

  key(k, app) {
    const h = k.hot ?? k.name;
    if (k.name === "escape" || h === "q") return app.closeOverlay(this);
    if (!this.link) return;
    if (h === "o" || h === "p" || k.name === "enter") { openUrl(this.link); app.toast("Открываю корзину ВкусВилла — оплата там"); }
    if (h === "y" || h === "c") copy(this.link).then(() => app.toast("Ссылка скопирована"));
    if (h === "z" && this.switch) { this.half = !this.half; app.invalidate(); }
  }

  hints() {
    if (!this.link) return [["esc", "закрыть"]];
    return [["p", "оплатить в браузере"], ["y", "скопировать"], ...(this.switch ? [["z", this.switch]] : []), ["esc", "закрыть"]];
  }

  // A dialog of w×h centred on the screen
  frame(g, app, w, h) {
    w = Math.min(g.w - 2, w);
    h = Math.min(g.h - 2, h);
    const x = Math.floor((g.w - w) / 2), y = Math.max(1, Math.floor((g.h - h) / 2));
    shadow(g, x, y, w, h);
    g.box(x, y, w, h, { fg: T.lineHi, bg: T.panel2, title: "Оформление", titleFg: T.lime, style: "round" });
    app.hit(x, y, w, h, { click: () => {} });
    return { x, y, w, h };
  }

  draw(g, app) {
    if (!this.link) {
      const { x, y, w, h } = this.frame(g, app, 64, 8);
      const my = y + Math.floor(h / 2);
      if (this.error) {
        g.textC(x, w, my - 1, "⚠ Не получилось создать корзину", { fg: T.red, bold: true, bg: T.panel2 });
        g.textC(x, w, my, this.error, { fg: T.sub, bg: T.panel2 });
        return;
      }
      g.textC(x, w, my - 1, "Собираю корзину…", { fg: T.sub, bg: T.panel2 });
      const n = 20;
      for (let i = 0; i < n; i++) g.text(x + Math.floor((w - n) / 2) + i, my + 1, " ", { bg: ramp([T.greenD, T.lime, T.greenD], ((i + app.frame) % n) / n) });
      return;
    }
    // The code of filled cells scans in any terminal, so it goes first: in a dialog, or alone with the link over the
    // whole screen. The half-size code of ▄ is for smaller windows, and `z` switches between the two when both fit.
    // When neither fits, the size the window needs.
    const qs = G.qrSize(this.link), hs = G.qrSize(this.link, true);
    const big = qs.w + 6 <= g.w - 2 && qs.h + 10 <= g.h - 2 ? "dialog" : qs.w <= g.w && qs.h + 1 <= g.h ? "screen" : null;
    const small = hs.w + 6 <= g.w - 2 && hs.h + 10 <= g.h - 2 ? "dialog" : hs.w + 4 <= g.w - 2 && hs.h + 4 <= g.h - 2 ? "compact" : null;
    const half = big && small ? !!this.half : !big;
    this.switch = big && small ? (half ? "крупнее" : "мельче") : null;
    const layout = half ? small : big;
    if (layout === "dialog") return this.drawDialog(g, app, half ? hs : qs, half);
    if (layout === "screen") {
      g.fill(0, 0, g.w, g.h, T.bg);
      app.hit(0, 0, g.w, g.h, { click: () => {} });
      const qy = Math.floor((g.h - qs.h - 1) / 2);
      g.qr(Math.floor((g.w - qs.w) / 2), qy, this.link);
      // The link, and the switch after it when the line has room
      const sw = this.switch && `z  ${this.switch}`;
      const link = truncate(this.link, g.w - 2), lw = strWidth(link);
      const both = sw && lw + 3 + strWidth(sw) <= g.w - 2;
      const lx = Math.floor((g.w - (both ? lw + 3 + strWidth(sw) : lw)) / 2);
      g.text(lx, qy + qs.h, link, { fg: T.lime, underline: true, bg: T.bg });
      app.hit(lx, qy + qs.h, lw, 1, { click: () => openUrl(this.link) });
      if (both) {
        g.text(lx + lw + 3, qy + qs.h, sw, { fg: T.dim, bg: T.bg });
        app.hit(lx + lw + 3, qy + qs.h, strWidth(sw), 1, { click: () => { this.half = !this.half; app.invalidate(); } });
      }
      return;
    }
    if (layout === "compact") {
      const { x, y, w, h } = this.frame(g, app, Math.max(hs.w + 6, 64), hs.h + 4);
      g.qr(x + Math.floor((w - hs.w) / 2), y + 1, this.link, true);
      g.textC(x, w, y + h - 3, truncate(this.link, w - 4), { fg: T.lime, underline: true, bg: T.panel2 });
      app.hit(x + 2, y + h - 3, w - 4, 1, { click: () => openUrl(this.link) });
      g.textC(x, w, y + h - 2, `${rub(store.total)} · камера телефона → приложение ВкусВилла`, { fg: T.dim, bg: T.panel2 });
      return;
    }
    const { x, y, w } = this.frame(g, app, 64, 7);
    g.textC(x, w, y + 2, `Окно мало для QR-кода: нужно ${hs.w + 6}×${hs.h + 6}, сейчас ${g.w}×${g.h}`, { fg: T.sub, bg: T.panel2 });
    g.textC(x, w, y + 3, truncate(this.link, w - 4), { fg: T.lime, underline: true, bg: T.panel2 });
    app.hit(x + 2, y + 3, w - 4, 1, { click: () => openUrl(this.link) });
    g.textC(x, w, y + 4, "p — открыть в браузере · y — скопировать ссылку", { fg: T.dim, bg: T.panel2 });
  }

  drawDialog(g, app, qs, half) {
    const { x, y, w, h } = this.frame(g, app, Math.max(qs.w + 6, 64), qs.h + 10);
    g.qr(x + Math.floor((w - qs.w) / 2), y + 2, this.link, half);
    g.textC(x, w, y + qs.h + 3, "наведите камеру телефона — откроется приложение ВкусВилла", { fg: T.sub, bg: T.panel2 });
    const ly = y + h - 4;
    g.textC(x, w, ly, truncate(this.link, w - 4), { fg: T.lime, underline: true, bg: T.panel2 });
    app.hit(x + 2, ly, w - 4, 1, { click: () => openUrl(this.link) });
    g.textC(x, w, ly + 1, `${store.count} ${plural(store.count, "позиция", "позиции", "позиций")} · ${rub(store.total)} · оплата и доставка — у ВкусВилла`, { fg: T.dim, bg: T.panel2 });
    const btns = [
      ["p  оплатить", () => openUrl(this.link), true],
      ["y  скопировать", () => copy(this.link).then(() => app.toast("Ссылка скопирована"))],
      ...(this.switch ? [[`z  ${this.switch}`, () => { this.half = !this.half; app.invalidate(); }]] : []),
      ["esc", () => app.closeOverlay(this)],
    ];
    let bx = x + Math.floor((w - btns.reduce((n, [label]) => n + strWidth(label) + 3, -1)) / 2);
    for (const [label, fn, prim] of btns) {
      g.pill(bx, ly + 2, label, { fg: prim ? T.bg : T.sub, bg: prim ? T.lime : T.raise, bold: prim });
      app.hit(bx, ly + 2, strWidth(label) + 2, 1, { click: fn });
      bx += strWidth(label) + 3;
    }
  }
}

