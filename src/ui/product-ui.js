// Product rendering: list row, side card, composition flags, macro energy split, ingredient highlighting.

import { T, mix } from "./theme.js";
import { RX, rub, compactNum, qtyText } from "../product.js";
import { strWidth, truncate } from "../term/width.js";
import { image } from "../image.js";
import { richWrap, drawRich } from "./widgets.js";
import { store } from "../store.js";

// Stock at the signed-in user's address; null when unknown (signed out, or the tool did not say)
export function stock(p) {
  if (p.available == null) return null;
  if (p.available <= 0) return { text: "нет в наличии", fg: T.red, out: true };
  const n = p.unit === "кг" ? `${+Number(p.available).toFixed(1)} кг` : `${p.available} шт`;
  return { text: `в наличии ${n}`, fg: T.green, out: false };
}

export const perKg = (p) => (p.unit === "кг" ? null : p.grams ? Math.round((p.price / p.grams) * 1000) : null);

// Composition flags → pills
export function flagPills(p) {
  if (!p.comp) return [];
  const f = p.flags ?? {};
  const out = [];
  out.push(f.sugar ? ["сахар", T.red] : ["без сахара", T.green]);
  if (f.gluten) out.push(["глютен", T.yellow]);
  if (f.lactose) out.push(["лактоза", T.yellow]);
  if (f.additives) out.push([`добавки ×${f.additives}`, T.orange]);
  if (f.palm) out.push(["пальм. масло", T.red]);
  if (!f.sugar && !f.additives && !f.palm && !f.gluten && !f.lactose) out.push(["чистый состав", T.lime]);
  return out;
}

export function drawPills(g, x, y, w, pills) {
  let cx = x;
  let row = 0;
  for (const [label, color] of pills) {
    const pw = strWidth(label) + 2;
    if (cx + pw > x + w) { row++; cx = x; }
    g.pill(cx, y + row, label, { fg: color, bg: mix(color, T.panel, 0.82) });
    cx += pw + 1;
  }
  return row + 1;
}

// Share of energy from protein, fat and carbs, as a single bar
export function energyBar(g, x, y, w, p, bg = T.panel) {
  const e = [(p.p ?? 0) * 4, (p.f ?? 0) * 9, (p.c ?? 0) * 4];
  const sum = e[0] + e[1] + e[2];
  if (!sum) { g.text(x, y, "нет данных о КБЖУ", { fg: T.dim, bg }); return; }
  const cols = [T.blue, T.yellow, T.orange];
  // Background fill rather than █: solid at any line spacing
  for (let i = 0; i < w; i++) {
    const t = ((i + 0.5) / w) * sum;
    const k = t > e[0] + e[1] ? 2 : t > e[0] ? 1 : 0;
    g.text(x + i, y, " ", { bg: cols[k] });
  }
}

export function kbjuLine(g, x, y, w, p, bg) {
  const n = (v) => (v == null ? "—" : String(Math.round(v * 10) / 10).replace(".", ","));
  return g.spans(x, y, [
    ["Б ", { fg: T.blue, bold: true, bg }], [n(p.p) + "  ", { fg: T.text, bg }],
    ["Ж ", { fg: T.yellow, bold: true, bg }], [n(p.f) + "  ", { fg: T.text, bg }],
    ["У ", { fg: T.orange, bold: true, bg }], [n(p.c) + "  ", { fg: T.text, bg }],
    [p.kcal != null ? `${Math.round(p.kcal)} ккал` : "", { fg: T.lime, bold: true, bg }],
  ], w);
}

// Ingredient highlighting: sugar and palm oil in red, additives in orange, gluten and lactose in yellow
export function compositionLines(comp, w) {
  const ranges = [];
  const scan = (re, color) => {
    const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m;
    while ((m = r.exec(comp))) { ranges.push([m.index, m.index + m[0].length, color]); if (!m[0].length) r.lastIndex++; }
  };
  scan(RX.sugar, T.red); scan(RX.additives, T.orange); scan(RX.palm, T.red);
  scan(RX.gluten, T.yellow); scan(RX.lactose, T.yellow);
  return richWrap(comp, w, (i, s) => {
    const hit = ranges.find(([a, b]) => a < i + s.length && b > i);
    return hit ? { fg: hit[2], bold: true } : null;
  });
}

// Product list row
export function productRow(g, p, x, y, w, { selected, focused = true, mark, bg: rowBg } = {}) {
  const bg = selected ? (focused ? T.selHi : T.sel) : rowBg ?? T.panel;
  g.fill(x, y, w, 1, bg);
  if (selected) g.text(x, y, "▌", { fg: focused ? T.lime : T.green, bg });
  const q = store.qty(p.id);
  const fav = store.isFav(p.id);
  // Columns, right to left
  let rx = x + w - 1;
  const cartW = 6;
  const st = stock(p);
  if (q) g.textR(rx, y, p.unit === "кг" ? `${+q.toFixed(1)}кг` : `×${q}`, { fg: T.lime, bg, bold: true });
  else if (mark) g.textR(rx, y, mark, { fg: T.violet, bg, bold: true });
  else if (st?.out) g.textR(rx, y, "нет", { fg: T.red, bg });
  rx -= cartW;
  g.textR(rx, y, rub(p.price) + (p.unit === "кг" ? "/кг" : ""), { fg: p.old ? T.orange : T.white, bg, bold: true });
  rx -= 12;
  if (w > 54) {
    if (p.off) g.textR(rx, y, `−${p.off}%`, { fg: T.orange, bg, bold: true });
    rx -= 6;
  }
  if (w > 74) {
    const pk = perKg(p);
    if (pk) g.textR(rx, y, `${pk.toLocaleString("ru-RU").replace(/\s/g, " ")} ₽/кг`, { fg: T.dim, bg });
    rx -= 12;
  }
  if (w > 64) {
    if (p.rating) g.spans(rx - 6, y, [["★ ", { fg: T.yellow, bg }], [p.rating.toFixed(1).replace(".", ","), { fg: T.sub, bg }]]);
    rx -= 7;
  }
  let cx = x + 2;
  if (fav) cx = g.text(cx, y, "♥ ", { fg: T.pink, bg });
  const nameW = rx - cx;
  if (nameW > 4) {
    const t = truncate(p.title, nameW);
    cx = g.text(cx, y, t, { fg: st?.out ? T.dim : selected ? T.white : T.text, bg, bold: selected });
    if (p.pack && strWidth(t) < nameW - 2 && t === p.title) g.textW(cx + 1, y, p.pack, nameW - strWidth(t) - 1, { fg: T.dim, bg });
  }
}

// Side product card
export function productPane(g, app, p, x, y, w, h, { compact = false } = {}) {
  g.fill(x, y, w, h, T.panel);
  if (!p) { g.textC(x, w, y + Math.floor(h / 2), "выберите товар", { fg: T.dim, bg: T.panel }); return; }
  let cy = y;
  const iw = w - 2;
  const photoH = compact ? 0 : Math.max(0, Math.min(Math.floor(h * 0.36), Math.round(iw * 0.3)));
  if (photoH >= 4) {
    const img = image(p.thumb ?? p.images?.[0], iw, photoH);
    if (img && !img.error) {
      const ox = x + 1 + Math.floor((iw - img.w) / 2);
      g.photo(ox, cy, img);
      cy += Math.ceil(img.h / 2);
    } else {
      g.photoPlaceholder(x + 1, cy, iw, photoH, app.frame, img?.error ? "без фото" : "загружаю фото…");
      cy += photoH;
    }
    cy++;
  }
  const end = y + h;
  const left = () => end - cy;
  // Title
  cy += g.para(x + 1, cy, iw, 2, p.title, { fg: T.white, bold: true, bg: T.panel });
  const meta = [p.pack, p.category?.at(-1)].filter(Boolean).join(" · ");
  if (meta && left() > 0) g.textW(x + 1, cy++, meta, iw, { fg: T.dim, bg: T.panel });
  const st = stock(p);
  if (st && left() > 0) g.text(x + 1, cy++, `${st.out ? "○" : "●"} ${st.text}`, { fg: st.fg, bg: T.panel });
  cy++;
  // Big price
  if (left() > 7) {
    const pw = g.bigPrice(x + 1, cy, p.price, p.old ? T.orange : T.lime);
    const tx = x + 2 + pw + 1;
    if (p.old && tx + 8 < x + w) {
      g.text(tx, cy + 1, rub(p.old), { fg: T.dim, strike: true, bg: T.panel });
      g.pill(tx, cy + 3, `−${p.off}%`, { fg: T.bg, bg: T.orange, bold: true });
    } else if (p.unit === "кг" && tx + 6 < x + w) g.text(tx, cy + 4, "за кг", { fg: T.dim, bg: T.panel });
    cy += 6;
    if (p.offInfo && left() > 0) g.textW(x + 1, cy++, p.offInfo, iw, { fg: T.orange, bg: T.panel, italic: true });
  } else {
    g.text(x + 1, cy++, rub(p.price), { fg: T.lime, bold: true });
  }
  // Rating and price per kg
  if (left() > 0) {
    let cx = x + 1;
    if (p.rating) {
      cx = g.stars(cx, cy, p.rating, { bg: T.panel });
      cx = g.text(cx + 1, cy, p.rating.toFixed(1).replace(".", ","), { fg: T.yellow, bold: true, bg: T.panel });
      cx = g.text(cx + 1, cy, `· ${compactNum(p.votes)}`, { fg: T.dim, bg: T.panel });
    }
    const pk = perKg(p);
    if (pk) g.textR(x + w - 1, cy, `${pk.toLocaleString("ru-RU").replace(/\s/g, " ")} ₽/кг`, { fg: T.sub, bg: T.panel });
    cy += 2;
  }
  // Kcal and macros
  if (left() > 2 && (p.kcal != null || p.p != null)) {
    g.text(x + 1, cy, "на 100 г", { fg: T.dim, bg: T.panel });
    kbjuLine(g, x + 10, cy++, iw - 9, p, T.panel);
    energyBar(g, x + 1, cy++, iw, p);
    cy++;
  }
  // Composition flags
  const pills = flagPills(p);
  if (pills.length && left() > 1) { cy += drawPills(g, x + 1, cy, iw, pills); cy++; }
  // Ingredients
  if (p.comp && left() > 1) {
    g.text(x + 1, cy++, "СОСТАВ", { fg: T.dim, bold: true, bg: T.panel });
    const lines = compositionLines(p.comp, iw);
    const n = drawRich(g, x + 1, cy, iw, left(), lines, { fg: T.sub, bg: T.panel });
    if (lines.length > n && n > 0) g.textR(x + w - 1, cy + n - 1, " …", { fg: T.dim, bg: T.panel });
    cy += n;
  } else if (p.description && left() > 1) {
    cy += g.para(x + 1, cy, iw, left(), p.description, { fg: T.sub, bg: T.panel });
  }
  const q = store.qty(p.id);
  if (q && h > 6) {
    const label = ` в корзине: ${qtyText(p, q)} `;
    g.textR(x + w - 1, y, label, { fg: T.bg, bg: T.lime, bold: true });
  }
}
