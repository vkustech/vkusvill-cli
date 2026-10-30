// Drawing on top of Screen: boxes, wrapped text, bars, stars, pills, pixel fonts,
// half-block photos, a braille canvas and QR codes.

import qrcode from "qrcode-generator";
import { T, mix, ramp } from "./theme.js";
import { strWidth, truncate, wrap } from "../term/width.js";

const BOX = {
  round: ["╭", "╮", "╰", "╯", "─", "│"],
  sharp: ["┌", "┐", "└", "┘", "─", "│"],
  heavy: ["┏", "┓", "┗", "┛", "━", "┃"],
  double: ["╔", "╗", "╚", "╝", "═", "║"],
};

const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
export const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Big digits in the style of the postal code on a Russian envelope: a 5×5 grid of two squares with diagonals.
// t m b are horizontals; lu ld ru rd are vertical halves; du, dd are the diagonals of the upper and lower square
const POSTAL = {
  "0": "t b lu ld ru rd", "1": "du ru rd", "2": "t ru dd b", "3": "t du m rd b", "4": "lu m ru rd",
  "5": "t lu m rd b", "6": "du ld m rd b", "7": "t du ld", "8": "t m b lu ld ru rd", "9": "t lu ru m dd",
};
const POSTAL_RUB = [".####", ".#..#", "####.", ".#...", ".#..."];

function postalGlyph(c, W = 5, H = 5) {
  if (c === "₽") return POSTAL_RUB.map((r) => [...r].map((ch) => ch === "#"));
  const g = Array.from({ length: H }, () => Array(W).fill(false));
  const M = (H - 1) / 2;
  const P = { TL: [0, 0], TR: [W - 1, 0], ML: [0, M], MR: [W - 1, M], BL: [0, H - 1], BR: [W - 1, H - 1] };
  const SEG = { t: ["TL", "TR"], m: ["ML", "MR"], b: ["BL", "BR"], lu: ["TL", "ML"], ld: ["ML", "BL"], ru: ["TR", "MR"], rd: ["MR", "BR"], du: ["TR", "ML"], dd: ["MR", "BL"] };
  for (const seg of POSTAL[c].split(" ")) {
    const [[x0, y0], [x1, y1]] = SEG[seg].map((k) => P[k]);
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= n; i++) g[Math.round(y0 + ((y1 - y0) * i) / n)][Math.round(x0 + ((x1 - x0) * i) / n)] = true;
  }
  return g;
}
const POSTAL_CACHE = new Map();

// 5×7 pixel font for the logo
const LOGO = {
  "В": ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  "К": ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  "У": ["#...#", "#...#", "#...#", ".####", "....#", "#...#", ".###."],
  "С": [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  "И": ["#...#", "#...#", "#..##", "#.#.#", "##..#", "#...#", "#...#"],
  "Л": ["..###", ".#..#", ".#..#", ".#..#", ".#..#", ".#..#", "##..#"],
  "Д": ["..##.", ".#.#.", ".#.#.", ".#.#.", "#..#.", "#####", "#...#"],
  "Е": ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  " ": ["...", "...", "...", "...", "...", "...", "..."],
};

export const LOGO_GLYPH = (c) => LOGO[c] ?? LOGO[" "];

// VkusVill leaf, 10×7
export const LEAF = [
  ".......###",
  ".....#####",
  "...###.###",
  "..###.####",
  ".###.####.",
  ".#.#####..",
  "#.........",
];

export class G {
  constructor(screen, app) {
    this.s = screen;
    this.app = app;
  }

  get w() { return this.s.w; }
  get h() { return this.s.h; }

  bgAt(x, y) {
    if (x < 0 || y < 0 || x >= this.s.w || y >= this.s.h) return T.bg;
    return this.s.bg[y * this.s.w + x];
  }

  text(x, y, str, st = {}) { return this.s.put(x, y, str, st); }

  // Text truncated to width, ending with "…"
  textW(x, y, str, w, st = {}) { return this.s.put(x, y, truncate(String(str), w), st); }

  textR(xr, y, str, st = {}) { const w = strWidth(str); this.s.put(xr - w, y, str, st); return xr - w; }

  textC(x, w, y, str, st = {}) { const t = truncate(str, w); this.s.put(x + Math.floor((w - strWidth(t)) / 2), y, t, st); }

  fill(x, y, w, h, bg) { this.s.fill(x, y, w, h, bg); }
  tint(x, y, w, h, bg) { this.s.tint(x, y, w, h, bg); }

  // Differently styled runs in a row: [[text, style], …]
  spans(x, y, parts, maxW = Infinity) {
    const end = x + maxW;
    for (const [t, st] of parts) {
      if (x >= end) break;
      x = this.s.put(x, y, truncate(String(t), end - x), st ?? {});
    }
    return x;
  }

  para(x, y, w, h, str, st = {}) {
    const lines = wrap(str, w);
    lines.slice(0, h).forEach((l, i) => this.s.put(x, y + i, i === h - 1 && lines.length > h ? truncate(l + " …", w) : l, st));
    return Math.min(lines.length, h);
  }

  hline(x, y, w, fg = T.line, ch = "─") { this.s.put(x, y, ch.repeat(Math.max(0, w)), { fg }); }
  vline(x, y, h, fg = T.line, ch = "│") { for (let i = 0; i < h; i++) this.s.put(x, y + i, ch, { fg }); }

  box(x, y, w, h, { fg = T.line, bg, style = "round", title, titleFg = T.sub, right, rightFg = T.dim } = {}) {
    if (w < 2 || h < 2) return;
    const [tl, tr, bl, br, hz, vt] = BOX[style];
    if (bg !== undefined) this.s.fill(x, y, w, h, bg);
    this.s.put(x, y, tl + hz.repeat(w - 2) + tr, { fg });
    for (let j = 1; j < h - 1; j++) { this.s.put(x, y + j, vt, { fg }); this.s.put(x + w - 1, y + j, vt, { fg }); }
    this.s.put(x, y + h - 1, bl + hz.repeat(w - 2) + br, { fg });
    if (title) this.s.put(x + 2, y, truncate(` ${title} `, w - 4), { fg: titleFg, bold: true });
    if (right) { const r = truncate(` ${right} `, Math.max(0, w - 8 - (title ? strWidth(title) : 0))); this.s.put(x + w - 2 - strWidth(r), y, r, { fg: rightFg }); }
  }

  // Horizontal bar with 1/8-cell precision
  // Full cells are background fill, solid at any line spacing; only the fractional tip is a ▏…▉ glyph
  bar(x, y, w, frac, fg, bg = T.raise) {
    frac = Math.max(0, Math.min(1, frac || 0));
    const total = frac * w;
    let full = Math.floor(total);
    let rem = Math.round((total - full) * 8);
    if (rem === 8) { full++; rem = 0; }
    this.s.put(x, y, " ".repeat(w), { bg });
    if (full) this.s.put(x, y, " ".repeat(full), { bg: fg });
    if (rem && full < w) this.s.put(x + full, y, EIGHTHS[rem], { fg, bg });
  }

  // Gradient bar, same construction
  gradBar(x, y, w, frac, stops, bg = T.raise) {
    const total = Math.max(0, Math.min(1, frac)) * w;
    for (let i = 0; i < w; i++) {
      const c = ramp(stops, w > 1 ? i / (w - 1) : 0);
      const rem = Math.round((total - i) * 8);
      if (i + 1 <= total || rem >= 8) this.s.put(x + i, y, " ", { bg: c });
      else if (i < total && rem > 0) this.s.put(x + i, y, EIGHTHS[rem], { fg: c, bg });
      else this.s.put(x + i, y, " ", { bg });
    }
  }

  stars(x, y, rating, { bg } = {}) {
    return this.s.put(x, y, "★", { fg: rating ? T.yellow : T.mute, bg });
  }

  // Pill: a label on a fill, padded with spaces. Half-block rounded ends ▐▌ don't work:
  // in some fonts they are wider than a cell and eat the last letter
  pill(x, y, label, { fg = T.text, bg = T.raise, bold = false } = {}) {
    return this.s.put(x, y, ` ${label} `, { fg, bg, bold });
  }

  // A key in the hint bar
  key(x, y, k, label, { active = false } = {}) {
    x = this.s.put(x, y, ` ${k} `, { fg: active ? T.bg : T.lime, bg: active ? T.lime : T.raise, bold: true });
    return this.s.put(x, y, ` ${label} `, { fg: T.sub });
  }

  // Bitmap drawn with half blocks: px(x, y) → color or -1 (transparent)
  bitmap(x, y, pw, ph, px) {
    for (let cy = 0; cy < Math.ceil(ph / 2); cy++) {
      for (let cx = 0; cx < pw; cx++) {
        const top = px(cx, cy * 2);
        const bot = cy * 2 + 1 < ph ? px(cx, cy * 2 + 1) : -1;
        if (top < 0 && bot < 0) continue;
        const under = this.bgAt(x + cx, y + cy);
        if (top >= 0 && bot >= 0) this.s.cell(x + cx, y + cy, top === bot ? " " : "▀", top, bot, 0);
        else if (top >= 0) this.s.cell(x + cx, y + cy, "▀", top, under, 0);
        else this.s.cell(x + cx, y + cy, "▄", bot, under, 0);
      }
    }
  }

  // Photo from image.js
  photo(x, y, img) {
    if (!img || img.error) return;
    this.bitmap(x, y, img.w, img.h, (px, py) => img.px[py * img.w + px]);
  }

  // Placeholder while the photo loads: shimmering "dust"
  photoPlaceholder(x, y, w, h, t = 0, label = "") {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const v = (Math.sin(i * 0.35 + j * 0.6 + t * 0.12) + 1) / 2;
      this.s.cell(x + i, y + j, "▒░·"[Math.floor(v * 2.99)], mix(T.panel2, T.line, v), T.panel, 0);
    }
    if (label && h > 0) this.textC(x, w, y + Math.floor(h / 2), ` ${label} `, { fg: T.dim, bg: T.panel });
  }

  // Width of a word in the logo pixel font
  logoWidth(str, gap = 1) {
    return [...str].reduce((s, c) => s + LOGO_GLYPH(c)[0].length + gap, 0) - gap;
  }

  // Big price "1 245 ₽" in postal-code digits, 5 rows. A pixel is a cell filled with background:
  // the fill also covers the line spacing, so no terminal shows gaps
  bigPrice(x, y, n, color = T.lime) {
    const s = `${Math.round(n).toLocaleString("ru-RU").replace(/\s|\u00a0|\u202f/g, " ")} ₽`;
    let cx = x;
    for (const c of s) {
      if (c === " ") { cx += 2; continue; }
      if (!POSTAL_CACHE.has(c)) POSTAL_CACHE.set(c, postalGlyph(c));
      const g = POSTAL_CACHE.get(c);
      g.forEach((row, py) => row.forEach((on, px) => { if (on) this.s.cell(cx + px, y + py, " ", -1, color, 0); }));
      cx += g[0].length + 1;
    }
    return cx - x - 1;
  }

  static bigPriceH = 5;

  qr(x, y, text) {
    const q = qrcode(0, "L");
    q.addData(text);
    q.make();
    const n = q.getModuleCount();
    const quiet = 2;
    const size = n + quiet * 2;
    this.bitmap(x, y, size, size + (size % 2), (px, py) => {
      const r = py - quiet, c = px - quiet;
      if (r < 0 || c < 0 || r >= n || c >= n) return T.white;
      return q.isDark(r, c) ? T.black : T.white;
    });
    return { w: size, h: Math.ceil(size / 2) };
  }

  static qrSize(text) {
    const q = qrcode(0, "L");
    q.addData(text);
    q.make();
    const size = q.getModuleCount() + 4;
    return { w: size, h: Math.ceil(size / 2) };
  }

  // Scrollbar to the right of a list
  scrollbar(x, y, h, top, visible, total) {
    if (total <= visible || h < 2) return;
    const th = Math.max(1, Math.round((visible / total) * h));
    const ty = Math.round((top / Math.max(1, total - visible)) * (h - th));
    for (let i = 0; i < h; i++) this.s.put(x, y + i, i >= ty && i < ty + th ? "┃" : "│", { fg: i >= ty && i < ty + th ? T.green : T.line });
  }
}

// Braille canvas: 2×4 dots per cell
export class Braille {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.bits = new Uint8Array(w * h);
    this.col = new Int32Array(w * h).fill(-1);
    this.pri = new Uint8Array(w * h);
  }
  get pw() { return this.w * 2; }
  get ph() { return this.h * 4; }
  set(px, py, color, pri = 0) {
    px = Math.floor(px); py = Math.floor(py);
    if (px < 0 || py < 0 || px >= this.w * 2 || py >= this.h * 4) return;
    const cx = px >> 1, cy = py >> 2, i = cy * this.w + cx;
    const dx = px & 1, dy = py & 3;
    const bit = dy === 3 ? (dx ? 0x80 : 0x40) : dx ? 0x08 << dy : 0x01 << dy;
    this.bits[i] |= bit;
    if (pri >= this.pri[i]) { this.col[i] = color; this.pri[i] = pri; }
  }
  line(x0, y0, x1, y1, color, pri) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i++) this.set(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, color, pri);
  }
  draw(g, x, y) {
    for (let j = 0; j < this.h; j++) this.drawRow(g, x, y + j, j);
  }
  drawRow(g, x, y, j) {
    for (let i = 0; i < this.w; i++) {
      const b = this.bits[j * this.w + i];
      if (b) g.s.cell(x + i, y, String.fromCharCode(0x2800 + b), this.col[j * this.w + i], g.bgAt(x + i, y), 0);
    }
  }
}
