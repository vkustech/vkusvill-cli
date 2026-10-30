// Cell-based screen: drawing goes into a buffer, and flush sends only the changed cells to the terminal.
// Colors are 0xRRGGBB or -1 (terminal default). Terminals without truecolor get the nearest 256-palette color.

import { charWidth } from "./width.js";

export const A = { bold: 1, dim: 2, italic: 4, underline: 8, strike: 16 };

const ESC = "\x1b[";

function detectTruecolor() {
  const env = process.env;
  if (env.VV_COLOR === "256") return false;
  if (env.VV_COLOR === "truecolor") return true;
  if (/truecolor|24bit/i.test(env.COLORTERM ?? "")) return true;
  if (/-direct|truecolor/.test(env.TERM ?? "")) return true;
  if (env.TERM_PROGRAM === "Apple_Terminal") return false;
  return ["iTerm.app", "WezTerm", "vscode", "ghostty", "Hyper", "Tabby", "rio"].includes(env.TERM_PROGRAM) || !!env.KITTY_WINDOW_ID || !!env.WT_SESSION;
}

// Nearest xterm-256 palette color: the 6×6×6 cube or the grayscale ramp
const CUBE = [0, 95, 135, 175, 215, 255];
function to256(c) {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  const idx = (v) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  const ri = idx(r), gi = idx(g), bi = idx(b);
  const cr = CUBE[ri], cg = CUBE[gi], cb = CUBE[bi];
  const dCube = (cr - r) ** 2 + (cg - g) ** 2 + (cb - b) ** 2;
  const avg = (r + g + b) / 3;
  const gi2 = Math.max(0, Math.min(23, Math.round((avg - 8) / 10)));
  const gv = 8 + gi2 * 10;
  const dGray = (gv - r) ** 2 + (gv - g) ** 2 + (gv - b) ** 2;
  return dGray < dCube ? 232 + gi2 : 16 + 36 * ri + 6 * gi + bi;
}

export class Screen {
  constructor(out = process.stdout) {
    this.out = out;
    this.truecolor = detectTruecolor();
    this.w = 0;
    this.h = 0;
    this.clipStack = [];
    this.resize(out.columns || 100, out.rows || 30);
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
    const n = w * h;
    this.ch = new Array(n).fill(" ");
    this.fg = new Int32Array(n).fill(-1);
    this.bg = new Int32Array(n).fill(-1);
    this.at = new Uint8Array(n);
    this.pch = new Array(n).fill(null); // null: the terminal cell's state is unknown, redraw it
    this.pfg = new Int32Array(n);
    this.pbg = new Int32Array(n);
    this.pat = new Uint8Array(n);
    this.clip = { x0: 0, y0: 0, x1: w, y1: h };
  }

  invalidateAll() {
    this.pch.fill(null);
  }

  pushClip(x, y, w, h) {
    this.clipStack.push(this.clip);
    const c = this.clip;
    this.clip = { x0: Math.max(c.x0, x), y0: Math.max(c.y0, y), x1: Math.min(c.x1, x + w), y1: Math.min(c.y1, y + h) };
  }

  popClip() {
    this.clip = this.clipStack.pop() ?? { x0: 0, y0: 0, x1: this.w, y1: this.h };
  }

  clear(bg = -1) {
    this.ch.fill(" ");
    this.fg.fill(-1);
    this.bg.fill(bg);
    this.at.fill(0);
  }

  // A single cell; s is the character, null is the continuation of a wide character to the left
  cell(x, y, s, fg, bg, at) {
    const c = this.clip;
    if (x < c.x0 || y < c.y0 || x >= c.x1 || y >= c.y1) return;
    const i = y * this.w + x;
    // Overwriting half of a wide character: the other half becomes a space
    if (this.ch[i] === null && x > 0 && s !== null) this.ch[i - 1] = " ";
    if (s !== null && x + 1 < this.w && this.ch[i + 1] === null) this.ch[i + 1] = " ";
    this.ch[i] = s;
    if (fg !== undefined && fg !== null) this.fg[i] = fg;
    if (bg !== undefined && bg !== null) this.bg[i] = bg;
    this.at[i] = at ?? 0;
  }

  // Styled text; returns x after the text. Without bg, the cell's background is kept
  put(x, y, str, st = {}) {
    const at = (st.bold ? A.bold : 0) | (st.dim ? A.dim : 0) | (st.italic ? A.italic : 0) | (st.underline ? A.underline : 0) | (st.strike ? A.strike : 0);
    const maxX = st.maxW !== undefined ? x + st.maxW : Infinity;
    for (const ch of String(str)) {
      const cp = ch.codePointAt(0);
      const cw = charWidth(cp);
      if (cw === 0) continue;
      if (x + cw > maxX) break;
      if (cw === 2 && x + 1 >= this.clip.x1) { this.cell(x, y, " ", st.fg, st.bg, at); x++; break; }
      this.cell(x, y, ch, st.fg, st.bg, at);
      if (cw === 2) this.cell(x + 1, y, null, st.fg, st.bg, at);
      x += cw;
    }
    return x;
  }

  fill(x, y, w, h, bg, ch = " ", fg) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.cell(i, j, ch, fg ?? -1, bg, 0);
  }

  // Background only; characters and their colors stay
  tint(x, y, w, h, bg) {
    const c = this.clip;
    for (let j = Math.max(y, c.y0); j < Math.min(y + h, c.y1); j++)
      for (let i = Math.max(x, c.x0); i < Math.min(x + w, c.x1); i++) this.bg[j * this.w + i] = bg;
  }

  color(c, isBg) {
    if (c < 0) return isBg ? "49" : "39";
    if (this.truecolor) return `${isBg ? 48 : 38};2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`;
    return `${isBg ? 48 : 38};5;${to256(c)}`;
  }

  flush() {
    let out = "";
    let cx = -1, cy = -1, cfg = -2, cbg = -2, cat = -1;
    const w = this.w;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const ch = this.ch[i];
        if (ch === null) continue;
        if (this.pch[i] === ch && this.pfg[i] === this.fg[i] && this.pbg[i] === this.bg[i] && this.pat[i] === this.at[i]) {
          // a wide character with only its second half changed can't occur: the continuation is written together with it
          continue;
        }
        if (cx !== x || cy !== y) out += `${ESC}${y + 1};${x + 1}H`;
        const fg = this.fg[i], bg = this.bg[i], at = this.at[i];
        if (fg !== cfg || bg !== cbg || at !== cat) {
          let sgr = "0";
          if (at & A.bold) sgr += ";1";
          if (at & A.dim) sgr += ";2";
          if (at & A.italic) sgr += ";3";
          if (at & A.underline) sgr += ";4";
          if (at & A.strike) sgr += ";9";
          sgr += ";" + this.color(fg, false) + ";" + this.color(bg, true);
          out += `${ESC}${sgr}m`;
          cfg = fg; cbg = bg; cat = at;
        }
        out += ch;
        const wide = x + 1 < w && this.ch[i + 1] === null;
        this.pch[i] = ch; this.pfg[i] = fg; this.pbg[i] = bg; this.pat[i] = at;
        if (wide) { this.pch[i + 1] = null; this.pfg[i + 1] = fg; this.pbg[i + 1] = bg; this.pat[i + 1] = at; }
        cx = x + (wide ? 2 : 1);
        cy = y;
      }
    }
    if (out) this.out.write(`\x1b[?2026h${out}${ESC}0m\x1b[?2026l`);
  }

  enter() {
    this.out.write("\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[2J");
  }

  leave() {
    this.out.write("\x1b[0m\x1b[?2004l\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[?1049l");
  }

  // Buffer snapshot, for tests without a terminal
  snapshot() {
    const rows = [];
    for (let y = 0; y < this.h; y++) {
      let s = "";
      for (let x = 0; x < this.w; x++) { const c = this.ch[y * this.w + x]; if (c !== null) s += c; }
      rows.push(s);
    }
    return rows.join("\n");
  }
}
