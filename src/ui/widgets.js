// Text input, scrollable list, popup menu, and rich text wrapping with highlighting.

import { T } from "./theme.js";
import { strWidth, truncate, charWidth } from "../term/width.js";

export class TextInput {
  constructor({ placeholder = "", value = "", onChange, onSubmit, filter } = {}) {
    this.value = value;
    this.cursor = [...value].length;
    this.placeholder = placeholder;
    this.onChange = onChange;
    this.onSubmit = onSubmit;
    this.filter = filter; // (ch) → bool: which characters to accept
  }

  set(v) { this.value = v; this.cursor = [...v].length; }

  key(k) {
    const chars = [...this.value];
    let changed = false;
    if (k.type === "paste") {
      const add = [...k.text.replace(/[\r\n\t]+/g, " ")].filter((c) => !this.filter || this.filter(c));
      chars.splice(this.cursor, 0, ...add); this.cursor += add.length; changed = true;
    } else if (k.name === "enter") { this.onSubmit?.(this.value); return true; }
    else if (k.name === "backspace") { if (this.cursor > 0) { chars.splice(this.cursor - 1, 1); this.cursor--; changed = true; } else return true; }
    else if (k.name === "delete" || (k.ctrl && k.name === "d")) { if (this.cursor < chars.length) { chars.splice(this.cursor, 1); changed = true; } else return true; }
    else if (k.name === "left" && !k.alt) { this.cursor = Math.max(0, this.cursor - 1); return true; }
    else if (k.name === "right" && !k.alt) { this.cursor = Math.min(chars.length, this.cursor + 1); return true; }
    else if (k.name === "home" || (k.ctrl && k.name === "a")) { this.cursor = 0; return true; }
    else if (k.name === "end" || (k.ctrl && k.name === "e")) { this.cursor = chars.length; return true; }
    else if (k.ctrl && k.name === "u") { chars.splice(0, this.cursor); this.cursor = 0; changed = true; }
    else if (k.ctrl && k.name === "k") { chars.splice(this.cursor); changed = true; }
    else if ((k.ctrl && k.name === "w") || (k.alt && k.name === "backspace")) {
      let i = this.cursor;
      while (i > 0 && chars[i - 1] === " ") i--;
      while (i > 0 && chars[i - 1] !== " ") i--;
      chars.splice(i, this.cursor - i); this.cursor = i; changed = true;
    } else if (k.ch && !k.ctrl && !k.alt) {
      if (this.filter && !this.filter(k.ch)) return true;
      chars.splice(this.cursor, 0, k.ch); this.cursor++; changed = true;
    } else return false;
    if (changed) { this.value = chars.join(""); this.onChange?.(this.value); }
    return true;
  }

  draw(g, x, y, w, { focused = true, fg = T.text, bg, phFg = T.dim, blink = true } = {}) {
    const chars = [...this.value];
    if (!chars.length && !focused) { g.text(x, y, truncate(this.placeholder, w), { fg: phFg, bg, italic: true }); return; }
    // Scroll so the cursor stays visible
    let start = 0;
    while (strWidth(chars.slice(start, this.cursor).join("")) > w - 1) start++;
    let cx = x;
    for (let i = start; i < chars.length; i++) {
      const cw = charWidth(chars[i].codePointAt(0));
      if (cx + cw > x + w) break;
      const isCur = focused && i === this.cursor;
      g.text(cx, y, chars[i], isCur ? { fg: T.bg, bg: T.lime } : { fg, bg });
      cx += cw;
    }
    if (!chars.length) g.text(x + 1, y, truncate(this.placeholder, w - 1), { fg: phFg, bg, italic: true });
    if (focused && this.cursor >= chars.length && blink) g.text(Math.min(cx, x + w - 1), y, " ", { bg: T.lime });
  }
}

export class ListView {
  constructor() {
    this.sel = 0;
    this.top = 0;
    this.height = 10;
  }

  clamp(n) {
    if (n === 0) { this.sel = 0; this.top = 0; return; }
    this.sel = Math.max(0, Math.min(n - 1, this.sel));
    if (this.sel < this.top) this.top = this.sel;
    if (this.sel >= this.top + this.height) this.top = this.sel - this.height + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, n - this.height)));
  }

  // Returns false for a move up from the first row: the key goes on to whatever sits above the list
  key(k, n) {
    const up = ["up", "pageup", "home"].includes(k.name) || (k.hot === "k" && !k.ctrl);
    if (up && this.sel <= 0) return false;
    switch (k.name) {
      case "up": this.sel--; break;
      case "down": this.sel++; break;
      case "pageup": this.sel -= this.height - 1; break;
      case "pagedown": this.sel += this.height - 1; break;
      case "home": this.sel = 0; break;
      case "end": this.sel = n - 1; break;
      default:
        if (k.hot === "k" && !k.ctrl) { this.sel--; break; }
        if (k.hot === "j" && !k.ctrl) { this.sel++; break; }
        return false;
    }
    this.clamp(n);
    return true;
  }

  wheel(dir, n) {
    this.top = Math.max(0, Math.min(Math.max(0, n - this.height), this.top + dir * 3));
    if (this.sel < this.top) this.sel = this.top;
    if (this.sel >= this.top + this.height) this.sel = this.top + this.height - 1;
    this.clamp(n);
  }

  // rowH is the row height; row(item, index, y, selected)
  draw(g, app, x, y, w, h, items, row, { rowH = 1, onPick, scrollbar = true } = {}) {
    this.height = Math.max(1, Math.floor(h / rowH));
    this.clamp(items.length);
    const end = Math.min(items.length, this.top + this.height);
    for (let i = this.top; i < end; i++) {
      const ry = y + (i - this.top) * rowH;
      row(items[i], i, ry, i === this.sel);
      app?.hit(x, ry, w, rowH, {
        click: (ev) => { const again = this.sel === i; this.sel = i; this.clamp(items.length); if (again || ev.double) onPick?.(items[i], i); },
      });
    }
    app?.hit(x, y, w, h, { wheel: (dir) => this.wheel(dir, items.length), passive: true });
    if (scrollbar) g.scrollbar(x + w, y, h, this.top, this.height, items.length);
  }
}

// Popup menu: single choice or checkboxes, with a filter field when there are many items
export class Menu {
  constructor({ title, items, multi = false, onPick, onClose, x, y, width, filter }) {
    this.title = title;
    this.items = items; // [{ label, value, checked, hint, color, section }]
    this.multi = multi;
    this.onPick = onPick;
    this.onClose = onClose;
    this.list = new ListView();
    this.anchor = x !== undefined ? { x, y } : null;
    this.width = width;
    this.useFilter = filter ?? items.length > 12;
    this.input = new TextInput({ placeholder: "фильтр…", onChange: () => { this.list.sel = 0; } });
    const first = items.findIndex((i) => i.checked && !multi);
    if (first > 0) this.list.sel = first;
  }

  get visible() {
    const q = this.input.value.trim().toLowerCase();
    return q ? this.items.filter((i) => i.label.toLowerCase().includes(q)) : this.items;
  }

  key(k, app) {
    const vis = this.visible;
    if (k.name === "escape") { app.closeOverlay(this); this.onClose?.(); return true; }
    if (k.name === "enter") {
      const it = vis[this.list.sel];
      if (!it) return true;
      if (this.multi) { it.checked = !it.checked; this.onPick?.(it, this.items); }
      else { app.closeOverlay(this); this.onPick?.(it); }
      return true;
    }
    if (k.name === "space" && this.multi) {
      const it = vis[this.list.sel];
      if (it) { it.checked = !it.checked; this.onPick?.(it, this.items); }
      return true;
    }
    if (["up", "down", "pageup", "pagedown", "home", "end"].includes(k.name)) { this.list.key(k, vis.length); return true; }
    if (this.useFilter && this.input.key(k)) return true;
    if (!this.useFilter && (k.hot === "j" || k.hot === "k")) { this.list.key(k, vis.length); return true; }
    return true;
  }

  draw(g, app) {
    const vis = this.visible;
    const labelW = Math.max(strWidth(this.title ?? "") + 4, ...this.items.map((i) => strWidth(i.label) + (i.hint ? strWidth(i.hint) + 3 : 0) + (this.multi ? 4 : 2)));
    const w = Math.min(g.w - 4, Math.max(this.width ?? 0, labelW + 4, 30));
    const rows = Math.min(vis.length, Math.max(3, g.h - 10), 18);
    const h = rows + 2 + (this.useFilter ? 2 : 0) + (this.multi ? 1 : 0);
    let x = this.anchor ? Math.min(this.anchor.x, g.w - w - 1) : Math.floor((g.w - w) / 2);
    let y = this.anchor ? Math.min(this.anchor.y, g.h - h - 1) : Math.max(1, Math.floor((g.h - h) / 2));
    x = Math.max(0, x); y = Math.max(0, y);
    shadow(g, x, y, w, h);
    g.box(x, y, w, h, { fg: T.lineHi, bg: T.panel2, title: this.title, titleFg: T.lime });
    app.hit(x, y, w, h, { click: () => {}, wheel: (d) => this.list.wheel(d, vis.length) });
    let ly = y + 1;
    if (this.useFilter) {
      g.text(x + 2, ly, "⌕", { fg: T.lime });
      this.input.draw(g, x + 4, ly, w - 6, { bg: T.panel2 });
      g.hline(x + 1, ly + 1, w - 2, T.line);
      ly += 2;
    }
    this.list.draw(g, app, x + 1, ly, w - 3, rows, vis, (it, _i, ry, sel) => {
      const bg = sel ? T.selHi : T.panel2;
      g.fill(x + 1, ry, w - 3, 1, bg);
      let cx = x + 2;
      if (it.section) { g.text(cx, ry, it.label, { fg: T.dim, bg, bold: true }); return; }
      if (this.multi) cx = g.text(cx, ry, it.checked ? "◼ " : "◻ ", { fg: it.checked ? T.lime : T.dim, bg });
      else cx = g.text(cx, ry, it.checked ? "● " : sel ? "▸ " : "  ", { fg: T.lime, bg });
      g.textW(cx, ry, it.label, w - 6 - (cx - x) - (it.hint ? strWidth(it.hint) + 1 : 0), { fg: it.color ?? (sel ? T.white : T.text), bg, bold: sel });
      if (it.hint) g.textR(x + w - 3, ry, it.hint, { fg: T.dim, bg });
    }, {
      onPick: (it) => {
        if (this.multi) { it.checked = !it.checked; this.onPick?.(it, this.items); }
        else { app.closeOverlay(this); this.onPick?.(it); }
      },
    });
    if (!vis.length) g.textC(x, w, ly, "ничего не найдено", { fg: T.dim, bg: T.panel2 });
    if (this.multi) g.textC(x, w, y + h - 1, " пробел — отметить · esc — готово ", { fg: T.dim, bg: T.panel2 });
  }
}

export function shadow(g, x, y, w, h) {
  g.tint(x + 1, y + h, w, 1, 0x050906);
  g.tint(x + w, y + 1, 1, h, 0x050906);
}

// Text wrapping with per-character coloring: colorAt(i) → style or null
export function richWrap(text, w, colorAt) {
  const lines = [];
  const words = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) words.push({ s: m[0], i: m.index });
  let line = [], lw = 0;
  for (const word of words) {
    const ww = strWidth(word.s);
    if (lw && lw + 1 + ww > w) { lines.push(line); line = []; lw = 0; }
    line.push(word);
    lw += (lw ? 1 : 0) + ww;
  }
  if (line.length) lines.push(line);
  return lines.map((ws) => ws.map((wd) => ({ ...wd, st: colorAt(wd.i, wd.s) })));
}

export function drawRich(g, x, y, w, maxLines, lines, base) {
  const n = Math.min(lines.length, maxLines);
  for (let j = 0; j < n; j++) {
    let cx = x;
    for (const wd of lines[j]) {
      if (cx > x) cx = g.text(cx, y + j, " ", base);
      cx = g.text(cx, y + j, truncate(wd.s, x + w - cx), wd.st ?? base);
    }
  }
  return n;
}

// Modal form: one or more text fields, Tab moves between them, Enter submits.
// fields: [{ label, placeholder, hidden, value }]; onSubmit(values) may return an error string.
export class Prompt {
  constructor({ title, note = [], fields, onSubmit, onCancel }) {
    this.title = title;
    this.note = note;
    this.fields = fields.map((f) => ({ ...f, input: new TextInput({ placeholder: f.placeholder ?? "", value: f.value ?? "" }) }));
    this.focus = 0;
    this.onSubmit = onSubmit;
    this.onCancel = onCancel;
    this.error = null;
    this.animated = true; // blinking cursor
  }

  key(k, app) {
    if (k.name === "escape") { app.closeOverlay(this); this.onCancel?.(); return; }
    if (k.name === "tab" || k.name === "down") { this.focus = (this.focus + 1) % this.fields.length; return; }
    if (k.name === "backtab" || k.name === "up") { this.focus = (this.focus + this.fields.length - 1) % this.fields.length; return; }
    if (k.name === "enter") {
      if (this.focus < this.fields.length - 1 && !this.fields[this.focus + 1].optional) { this.focus++; return; }
      const values = this.fields.map((f) => f.input.value.trim());
      const err = this.onSubmit?.(values);
      if (err) { this.error = err; return; }
      app.closeOverlay(this);
      return;
    }
    this.error = null;
    this.fields[this.focus].input.key(k);
  }

  hints() { return [["⏎", "готово"], ...(this.fields.length > 1 ? [["Tab", "следующее поле"]] : []), ["esc", "отмена"]]; }

  draw(g, app) {
    const w = Math.min(g.w - 4, 76);
    // border, blank, notes (+ blank), fields as label/input/blank (the last blank holds an error), border
    const h = 3 + this.note.length + (this.note.length ? 1 : 0) + this.fields.length * 3;
    const x = Math.floor((g.w - w) / 2), y = Math.max(1, Math.floor((g.h - h) / 2));
    shadow(g, x, y, w, h);
    g.box(x, y, w, h, { fg: T.lineHi, bg: T.panel2, title: this.title, titleFg: T.lime });
    app.hit(x, y, w, h, { click: () => {} });
    let cy = y + 2;
    if (!this.note.length) cy = y + 1;
    for (const line of this.note) g.textW(x + 3, cy++, line, w - 6, { fg: T.sub, bg: T.panel2 });
    if (this.note.length) cy++;
    this.fields.forEach((f, i) => {
      const active = i === this.focus;
      g.text(x + 3, cy, f.label, { fg: active ? T.lime : T.dim, bold: active, bg: T.panel2 });
      g.fill(x + 3, cy + 1, w - 6, 1, active ? T.raise : T.panel);
      // A hidden field shows bullets with the real cursor position
      const shown = f.hidden ? new TextInput({ value: "•".repeat([...f.input.value].length), placeholder: f.input.placeholder }) : f.input;
      if (f.hidden) shown.cursor = f.input.cursor;
      shown.draw(g, x + 4, cy + 1, w - 8, { focused: active, bg: active ? T.raise : T.panel, blink: app.frame % 10 < 7 });
      app.hit(x + 3, cy, w - 6, 2, { click: () => { this.focus = i; } });
      cy += 3;
    });
    if (this.error) g.textW(x + 3, cy - 1, `⚠ ${this.error}`, w - 6, { fg: T.red, bg: T.panel2 });
  }
}

// A row of pills the keyboard can walk: ← → move, Enter or space presses. The page supplies the
// items on every draw ({ label, run, fg, bg, bold, prefix }) and tells whether the row has the focus.
// Only pills that fit on screen can be selected.
export class ChipBar {
  constructor() { this.sel = 0; this.shown = null; }

  key(k, items) {
    const n = Math.min(items.length, this.shown ?? items.length);
    if (!n) return false;
    this.sel = Math.min(this.sel, n - 1);
    if (k.name === "left") { this.sel = Math.max(0, this.sel - 1); return true; }
    if (k.name === "right") { this.sel = Math.min(n - 1, this.sel + 1); return true; }
    if (k.name === "home") { this.sel = 0; return true; }
    if (k.name === "end") { this.sel = n - 1; return true; }
    if (k.name === "enter" || k.name === "space") { items[this.sel]?.run(); return true; }
    return false;
  }

  // Draws the pills from x on row y up to maxX; returns the x after the last one drawn
  draw(g, app, x, y, maxX, items, { focused = false } = {}) {
    this.shown = 0;
    for (const [i, it] of items.entries()) {
      const pre = it.prefix ? strWidth(it.prefix) : 0;
      const w = strWidth(it.label) + 2;
      if (x + pre + w > maxX) break;
      if (it.prefix) x = g.text(x, y, it.prefix, { fg: T.dim });
      this.shown = i + 1;
      const active = focused && i === Math.min(this.sel, items.length - 1);
      // The keyboard's pill looks like a focused header tab: bright and underlined
      g.pill(x, y, it.label, { fg: active ? T.bg : it.fg ?? T.sub, bg: active ? T.lime : it.bg ?? T.raise, bold: active || it.bold });
      if (active) g.s.put(x + 1, y, it.label, { fg: T.bg, bg: T.lime, bold: true, underline: true });
      app.hit(x, y, w, 1, { click: () => { this.sel = i; it.run(); } });
      x += w + 1;
    }
    this.sel = Math.min(this.sel, Math.max(0, this.shown - 1));
    return x;
  }
}
