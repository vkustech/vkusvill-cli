// Product page: large photo with a gallery, price in a pixel font, energy donut of protein/fat/carbs,
// description, highlighted ingredients, all properties. [ and ] flip through neighbouring products of the list.

import { T } from "../ui/theme.js";
import { Braille } from "../ui/draw.js";
import { drawRich } from "../ui/widgets.js";
import { flagPills, drawPills, compositionLines, perKg, stock } from "../ui/product-ui.js";
import { image } from "../image.js";
import * as api from "../api.js";
import { normalize, rub, compactNum, qtyText, qtyStep } from "../product.js";
import { store } from "../store.js";
import { openUrl } from "../sys.js";
import { wrap, strWidth } from "../term/width.js";

const SKIP_PROPS = /Состав|ценность|Информация на этикетке/;

export function productView(app, p, ctx = {}) {
  return new ProductView(app, p, ctx);
}

class ProductView {
  constructor(app, p, { list = [], index = -1 } = {}) {
    this.app = app;
    this.p = p;
    this.list = list;
    this.index = index;
    this.photo = 0;
    this.scroll = 0;
    this.loading = false;
  }

  busy() { return this.loading; }

  onShow() { this.fetch(); }

  // Search results carry only a few properties; the details call brings the rest.
  // Only the latest request may touch the page: [ and ] can fire several in a row.
  async fetch() {
    const id = this.p.id;
    const req = (this.req = (this.req ?? 0) + 1);
    this.err = null;
    if (this.p.props?.length > 4) { this.loading = false; return; }
    this.loading = true;
    try {
      const d = normalize(await api.details(id));
      if (req === this.req) this.p = { ...this.p, ...d, flags: d.comp ? d.flags : this.p.flags, comp: d.comp || this.p.comp };
    } catch (e) {
      if (req === this.req) this.err = e.message;
    } finally {
      if (req === this.req) this.loading = false;
      this.app.invalidate();
    }
  }

  go(delta) {
    const i = this.index + delta;
    if (i < 0 || i >= this.list.length) return;
    this.index = i;
    this.p = this.list[i];
    this.photo = 0;
    this.scroll = 0;
    store.viewed(this.p);
    this.fetch();
  }

  cart(sign) {
    const p = this.p;
    store.add(p, sign * qtyStep(p));
    const q = store.qty(p.id);
    this.app.toast(q ? `В корзине ${qtyText(p, q)}` : "Убрано из корзины", sign > 0 ? T.lime : T.orange);
  }

  analogs() {
    this.app.views.analogs(this.app, this.p);
  }

  toggleFav() {
    this.app.toast(store.toggleFav(this.p) ? "♥ В избранном" : "Убрано из избранного", T.pink);
  }

  openSite() {
    if (openUrl(this.p.url)) this.app.toast("Открываю на сайте ВкусВилла");
  }

  key(k) {
    if (k.type !== "key") return false;
    const h = k.hot ?? k.name;
    const imgs = this.p.images?.length || 1;
    switch (true) {
      // ← on the first photo is "back": the app pops the page
      case k.name === "left": if (this.photo <= 0) return false; this.photo--; return true;
      case k.name === "right": this.photo = Math.min(imgs - 1, this.photo + 1); return true;
      case k.name === "up" || h === "k": if (this.scroll <= 0) return false; this.scroll--; return true;
      case k.name === "down" || h === "j": this.scroll++; return true;
      case k.name === "pageup": this.scroll = Math.max(0, this.scroll - 10); return true;
      case k.name === "pagedown" || k.name === "space": this.scroll += 10; return true;
      case k.name === "home": this.scroll = 0; return true;
      case h === "[" || h === "{": this.go(-1); return true;
      case h === "]" || h === "}": this.go(1); return true;
      case h === "+" || h === "=" || k.name === "enter": this.cart(1); return true;
      case h === "-" || h === "_": this.cart(-1); return true;
      case h === "*" || h === "l": this.toggleFav(); return true;
      case h === "a": this.analogs(); return true;
      case h === "o": this.openSite(); return true;
      case h === "x": this.app.toggleCompare(this.p); return true;
    }
    return false;
  }

  hints() {
    return [
      ["← esc", "назад"], ...((this.p.images?.length ?? 0) > 1 ? [["← →", "фото"]] : []), ["+ −", "корзина"],
      ...(this.list.length > 1 ? [["[ ]", "соседний"]] : []),
      ["a", "аналоги"], ["*", "избранное"], ["o", "на сайте"], ["x", "сравнить"],
    ];
  }

  draw(g, r) {
    const p = this.p;
    const app = this.app;
    g.fill(r.x, r.y, r.w, r.h, T.bg);
    // Breadcrumbs
    const cx = g.text(r.x + 1, r.y, "← ", { fg: T.lime });
    app.hit(r.x, r.y, 4, 1, { click: () => app.pop() });
    g.textW(cx, r.y, (p.category ?? []).join(" › ") || "Товар", r.w - 34, { fg: T.dim });
    let rx = r.x + r.w - 2;
    if (this.list.length > 1 && this.index >= 0) rx = g.textR(rx, r.y, `[ ${this.index + 1} из ${this.list.length} ]`, { fg: T.dim }) - 2;
    if (this.loading) g.textR(rx, r.y, "⠿ уточняю…", { fg: T.lime });
    const top = r.y + 1;
    const H = r.h - 1;
    const wide = r.w >= 100;
    const lw = wide ? Math.min(64, Math.floor(r.w * 0.44)) : r.w;
    // Left column: photo, price, cart
    g.fill(r.x, top, lw, H, T.panel);
    let y = top + 1;
    const photoH = wide ? Math.max(6, Math.min(Math.floor(H * 0.55), Math.round((lw - 4) * 0.42))) : Math.min(10, Math.floor(H * 0.3));
    const url = p.images?.[this.photo] ?? p.thumb;
    const img = image(url, lw - 4, photoH);
    if (img && !img.error) {
      g.photo(r.x + 2 + Math.floor((lw - 4 - img.w) / 2), y + Math.floor((photoH - Math.ceil(img.h / 2)) / 2), img);
    } else g.photoPlaceholder(r.x + 2, y, lw - 4, photoH, app.frame, img?.error ? "фото не загрузилось" : "проявляю фото…");
    app.hit(r.x, y, lw, photoH, { click: () => { this.photo = (this.photo + 1) % (p.images?.length || 1); } });
    y += photoH;
    const n = p.images?.length ?? 0;
    if (n > 1) {
      const dots = Array.from({ length: n }, (_, i) => (i === this.photo ? "●" : "○")).join(" ");
      g.textC(r.x, lw, y, dots, { fg: T.lime, bg: T.panel });
    }
    y += 2;
    if (!wide) {
      y -= 1;
      let cx = g.text(r.x + 2, y, rub(p.price) + (p.unit === "кг" ? "/кг" : ""), { fg: p.old ? T.orange : T.lime, bold: true, bg: T.panel });
      if (p.old) cx = g.text(cx + 1, y, rub(p.old), { fg: T.dim, strike: true, bg: T.panel });
      const q = store.qty(p.id);
      g.textR(r.x + r.w - 2, y, q ? `в корзине ${qtyText(p, q)} · + −` : "+ — в корзину", { fg: q ? T.lime : T.dim, bg: T.panel });
      return this.drawInfo(g, { x: r.x, y: y + 1, w: r.w, h: top + H - y - 1 });
    }
    // Price
    const pw = g.bigPrice(r.x + 3, y, p.price, p.old ? T.orange : T.lime);
    const tx = r.x + 3 + pw + 2;
    if (p.unit === "кг") g.text(tx, y + 4, "за кг", { fg: T.dim, bg: T.panel });
    if (p.old) {
      g.text(tx, y + 1, rub(p.old), { fg: T.dim, strike: true, bg: T.panel });
      g.pill(tx, y + 3, `−${p.off}%`, { fg: T.bg, bg: T.orange, bold: true });
    }
    y += 6;
    if (p.offInfo) g.textW(r.x + 3, y++, p.offInfo, lw - 6, { fg: T.orange, italic: true, bg: T.panel });
    const pk = perKg(p);
    g.textW(r.x + 3, y++, [p.pack, pk ? `${pk.toLocaleString("ru-RU").replace(/\s/g, " ")} ₽/кг` : ""].filter(Boolean).join(" · "), lw - 6, { fg: T.sub, bg: T.panel });
    const st = stock(p);
    if (st) g.text(r.x + 3, y++, `${st.out ? "○" : "●"} ${st.text}`, { fg: st.fg, bg: T.panel });
    y++;
    // Cart
    const q = store.qty(p.id);
    if (q) {
      let bx = r.x + 3;
      const minus = " − ", plus = " + ";
      g.text(bx, y, minus, { fg: T.bg, bg: T.orange, bold: true });
      app.hit(bx, y, 3, 1, { click: () => this.cart(-1) });
      bx += 4;
      bx = g.text(bx, y, ` ${qtyText(p, q)} `, { fg: T.white, bg: T.raise, bold: true }) + 1;
      g.text(bx, y, plus, { fg: T.bg, bg: T.lime, bold: true });
      app.hit(bx, y, 3, 1, { click: () => this.cart(1) });
      g.text(bx + 4, y, `= ${rub(p.price * q)}`, { fg: T.lime, bold: true, bg: T.panel });
    } else {
      const label = " ✚ В корзину ";
      g.text(r.x + 3, y, label, { fg: T.bg, bg: T.lime, bold: true });
      app.hit(r.x + 3, y, strWidth(label), 1, { click: () => this.cart(1) });
    }
    y += 2;
    // Buttons
    let bx = r.x + 3;
    const fav = store.isFav(p.id);
    const buttons = [
      [fav ? "♥ в избранном" : "♡ в избранное", fav ? T.pink : T.sub, () => this.toggleFav()],
      ["≈ аналоги", T.sub, () => this.analogs()],
      ["↗ на сайте", T.sub, () => this.openSite()],
      [app.compare.has(p.id) ? "⇄ в сравнении" : "⇄ сравнить", app.compare.has(p.id) ? T.violet : T.sub, () => app.toggleCompare(p)],
    ];
    for (const [label, fg, fn] of buttons) {
      const bw = strWidth(label) + 2;
      if (bx + bw > r.x + lw - 1) { bx = r.x + 3; y++; }
      g.pill(bx, y, label, { fg, bg: T.raise });
      app.hit(bx, y, bw, 1, { click: fn });
      bx += bw + 1;
    }
    this.drawInfo(g, { x: r.x + lw + 1, y: top, w: r.w - lw - 1, h: H });
  }

  // Right column: scrollable text
  drawInfo(g, r) {
    const p = this.p;
    const app = this.app;
    const w = r.w - 4;
    const lines = []; // (g, x, y) draw functions, one per line
    const blank = () => lines.push(null);
    const text = (s, st) => wrap(s, w).forEach((l) => lines.push((g, x, y) => g.text(x, y, l, st)));
    const head = (s) => { blank(); lines.push((g, x, y) => { g.text(x, y, s, { fg: T.lime, bold: true }); }); };

    wrap(p.title, w).forEach((l) => lines.push((g, x, y) => g.text(x, y, l, { fg: T.white, bold: true })));
    if (p.pack) lines.push((g, x, y) => g.text(x, y, p.pack, { fg: T.dim }));
    blank();
    if (p.rating) lines.push((g, x, y) => {
      let cx = g.stars(x, y, p.rating);
      cx = g.text(cx + 1, y, p.rating.toFixed(1).replace(".", ","), { fg: T.yellow, bold: true });
      g.text(cx + 1, y, `${compactNum(p.votes)} оценок`, { fg: T.dim });
    });
    const pills = flagPills(p);
    if (pills.length) { blank(); lines.push((g, x, y) => drawPills(g, x, y, w, pills)); }

    if (p.kcal != null || p.p != null) {
      head("ПИЩЕВАЯ ЦЕННОСТЬ · на 100 г");
      blank();
      const donut = energyDonut(p);
      const rows = donut ? donut.h : 0;
      const legend = [
        ["Белки", p.p, T.blue, 4], ["Жиры", p.f, T.yellow, 9], ["Углеводы", p.c, T.orange, 4],
      ];
      const esum = legend.reduce((s, [, v, , k]) => s + (v ?? 0) * k, 0);
      for (let i = 0; i < Math.max(rows, 6); i++) {
        lines.push((g, x, y) => {
          if (donut && i < rows) donut.draw(g, x, y, i);
          const lx = x + (donut ? donut.w + 3 : 0);
          if (i === 0) g.spans(lx, y, [[p.kcal != null ? `${Math.round(p.kcal)}` : "—", { fg: T.lime, bold: true }], [" ккал", { fg: T.sub }]]);
          const li = i - 2;
          if (li >= 0 && li < 3) {
            const [name, v, col, kk] = legend[li];
            const share = esum ? Math.round(((v ?? 0) * kk * 100) / esum) : 0;
            g.text(lx, y, "■ ", { fg: col });
            g.text(lx + 2, y, name, { fg: T.text });
            g.text(lx + 12, y, v == null ? "—" : `${String(v).replace(".", ",")} г`, { fg: T.white, bold: true });
            g.text(lx + 21, y, `${share}%`, { fg: T.dim });
          }
          if (i === 5 && p.sugars != null) g.text(lx, y, `в т. ч. сахара ${String(p.sugars).replace(".", ",")} г`, { fg: T.dim });
        });
      }
    }

    if (p.description) { head("ОПИСАНИЕ"); text(p.description, { fg: T.sub }); }
    if (p.comp) {
      head("СОСТАВ");
      compositionLines(p.comp, w).forEach((ln) => lines.push((g, x, y) => drawRich(g, x, y, w, 1, [ln], { fg: T.sub })));
      if (p.additiveList?.length) {
        blank();
        text(`Добавки: ${p.additiveList.join(", ")}`, { fg: T.orange });
      }
    }
    for (const pr of p.props ?? []) {
      if (SKIP_PROPS.test(pr.name) || !pr.value) continue;
      head(pr.name.toUpperCase());
      text(pr.value.replace(/\n+/g, " · "), { fg: T.sub });
    }
    if (this.loading && !p.props?.length) { blank(); lines.push((g, x, y) => g.text(x, y, "загружаю подробности…", { fg: T.dim, italic: true })); }
    if (this.err && !p.props?.length) { blank(); text(`⚠ Подробности не загрузились: ${this.err}`, { fg: T.red }); }

    // Scrolling
    const maxScroll = Math.max(0, lines.length - r.h + 1);
    this.scroll = Math.min(this.scroll, maxScroll);
    g.s.pushClip(r.x, r.y, r.w, r.h);
    for (let i = 0; i < r.h - 1; i++) {
      const fn = lines[this.scroll + i];
      if (fn) fn(g, r.x + 2, r.y + 1 + i);
    }
    g.s.popClip();
    g.scrollbar(r.x + r.w - 1, r.y + 1, r.h - 1, this.scroll, r.h - 1, lines.length);
    app.hit(r.x, r.y, r.w, r.h, { wheel: (d) => { this.scroll = Math.max(0, Math.min(maxScroll, this.scroll + d * 3)); }, passive: true });
  }
}

// Energy donut: share of calories from protein, fat and carbs
export function energyDonut(p, cw = 12, ch = 6) {
  const e = [(p.p ?? 0) * 4, (p.f ?? 0) * 9, (p.c ?? 0) * 4];
  const sum = e[0] + e[1] + e[2];
  if (!sum) return null;
  const cols = [T.blue, T.yellow, T.orange];
  const b = new Braille(cw, ch);
  const cxp = b.pw / 2, cyp = b.ph / 2;
  const R = Math.min(cxp, cyp) - 0.5, r0 = R * 0.55;
  for (let py = 0; py < b.ph; py++) for (let px = 0; px < b.pw; px++) {
    const dx = px + 0.5 - cxp, dy = py + 0.5 - cyp;
    const d = Math.hypot(dx, dy);
    if (d > R || d < r0) continue;
    let a = Math.atan2(dx, -dy) / (2 * Math.PI);
    if (a < 0) a += 1;
    const t = a * sum;
    const k = t < e[0] ? 0 : t < e[0] + e[1] ? 1 : 2;
    b.set(px, py, cols[k]);
  }
  return { w: cw, h: ch, draw: (g, x, y, row) => b.drawRow(g, x, y, row) };
}

