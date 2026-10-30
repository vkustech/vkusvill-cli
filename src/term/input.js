// Terminal input parsing: keys, mouse (SGR), paste. Hotkeys also work with the Russian keyboard layout.

import { clean } from "../safe.js";

const RU = "йцукенгшщзхъфывапролджэячсмитьбюЙЦУКЕНГШЩЗХЪФЫВАПРОЛДЖЭЯЧСМИТЬБЮё";
const EN = "qwertyuiop[]asdfghjkl;'zxcvbnm,.QWERTYUIOP{}ASDFGHJKL:\"ZXCVBNM<>`";
const RU2EN = new Map([...RU].map((c, i) => [c, EN[i]]));

const PASTE_MAX = 64 * 1024;
const PASTE_END = "\x1b[201~";
const SEQ_MAX = 64;        // an unfinished ESC [ … longer than this is junk
const STRING_MAX = 8192;   // terminal replies (OSC, DCS…) are looked for this far

const SEQ = {
  "[A": "up", "[B": "down", "[C": "right", "[D": "left", "[H": "home", "[F": "end",
  "OA": "up", "OB": "down", "OC": "right", "OD": "left", "OH": "home", "OF": "end",
  "[1~": "home", "[4~": "end", "[7~": "home", "[8~": "end", "[2~": "insert", "[3~": "delete",
  "[5~": "pageup", "[6~": "pagedown", "[Z": "backtab",
  "OP": "f1", "OQ": "f2", "OR": "f3", "OS": "f4", "[11~": "f1", "[15~": "f5",
};

function key(name, extra = {}) {
  return { type: "key", name, ch: null, ctrl: false, alt: false, shift: false, ...extra };
}

export class Input {
  constructor(stdin, onEvent) {
    this.stdin = stdin;
    this.onEvent = onEvent;
    this.buf = "";
    this.pasting = null;
    this.timer = null;
    this.handler = (data) => this.feed(data.toString("utf8"));
  }

  start() {
    if (this.stdin.isTTY) this.stdin.setRawMode(true);
    this.stdin.resume();
    this.stdin.on("data", this.handler);
  }

  stop() {
    this.stdin.off("data", this.handler);
    if (this.stdin.isTTY) this.stdin.setRawMode(false);
    this.stdin.pause();
  }

  feed(s) {
    clearTimeout(this.timer);
    this.buf += s;
    this.parse();
    // A lone ESC is the Esc key if nothing arrives after it
    if (this.buf === "\x1b") this.timer = setTimeout(() => { this.buf = ""; this.emit(key("escape")); }, 30);
  }

  emit(ev) {
    this.onEvent(ev);
  }

  // Bracketed paste: the end marker may come split across reads, so it is searched in all of the
  // text so far. Whatever follows the marker in the same read is dropped, not taken as keys: in a
  // terminal that does not filter pasted text, a copied "\x1b[201~" plus keys could otherwise press
  // buttons in the app. Control characters are removed from the pasted text itself
  pasteChunk(b) {
    const all = this.pasting + b;
    const end = all.indexOf(PASTE_END);
    if (end < 0) {
      // Capped, keeping the tail where a split end marker may start
      this.pasting = all.length > PASTE_MAX + PASTE_END.length ? all.slice(0, PASTE_MAX) + all.slice(-PASTE_END.length + 1) : all;
      this.buf = "";
      return;
    }
    this.pasting = null;
    this.buf = "";
    this.emit({ type: "paste", text: clean(all.slice(0, Math.min(end, PASTE_MAX))) });
  }

  parse() {
    while (this.buf.length) {
      const b = this.buf;
      if (this.pasting !== null) { this.pasteChunk(b); return; }
      if (b[0] === "\x1b") {
        if (b.length === 1) return;
        if (b.startsWith("\x1b[200~")) { this.pasting = ""; this.buf = b.slice(6); continue; }
        // SGR mouse: ESC [ < b ; x ; y M|m
        const m = /^\x1b\[<(\d{1,6});(\d{1,6});(\d{1,6})([Mm])/.exec(b);
        if (m) {
          this.buf = b.slice(m[0].length);
          this.emit(mouse(+m[1], +m[2] - 1, +m[3] - 1, m[4] === "m"));
          continue;
        }
        if (b[1] === "[") {
          const csi = /^\x1b\[([0-9;:?<=>]*)([ -\/]*)([@-~])/.exec(b);
          if (!csi) {
            // An unfinished sequence waits for the rest, but not forever
            if (b.length < SEQ_MAX && /^\x1b\[[0-9;:?<=> -\/]*$/.test(b)) return;
            this.buf = b.slice(2);
            continue;
          }
          this.buf = b.slice(csi[0].length);
          // Keys are ESC [ n ; mod X. Anything else (?, >, intermediates) is a terminal reply, not a key
          const k = !csi[2] && /^(\d*)(?:;(\d+))?$/.exec(csi[1]);
          if (!k) continue;
          const mod = k[2] ? +k[2] - 1 : 0;
          const name = SEQ[csi[3] === "~" ? `[${k[1]}~` : `[${csi[3]}`];
          if (name) this.emit(key(name, { shift: !!(mod & 1), alt: !!(mod & 2), ctrl: !!(mod & 4) }));
          continue;
        }
        // OSC, DCS, APC, PM, SOS: terminal replies, skipped up to BEL or ST when the whole reply is here.
        // Without a terminator it is a plain Alt+key (Alt+P is ESC P), so typing is never swallowed
        if ("]P_^X".includes(b[1])) {
          const end = b.slice(0, STRING_MAX).search(/\x07|\x1b\\/);
          if (end > 1) { this.buf = b.slice(end + (b[end] === "\x07" ? 1 : 2)); continue; }
        }
        if (b[1] === "O" && b.length >= 3) {
          this.buf = b.slice(3);
          const name = SEQ["O" + b[2]];
          if (name) this.emit(key(name));
          continue;
        }
        // Alt+character
        const ch = String.fromCodePoint(b.codePointAt(1));
        this.buf = b.slice(1 + ch.length);
        if (ch === "\x1b") { this.emit(key("escape")); this.buf = "\x1b" + this.buf; continue; }
        this.emit(printable(ch, { alt: true }));
        continue;
      }
      // One character at a time without copying the rest of the buffer
      const ch = String.fromCodePoint(b.codePointAt(0));
      this.buf = b.slice(ch.length);
      const c = ch.charCodeAt(0);
      if (ch === "\r" || ch === "\n") this.emit(key("enter"));
      else if (ch === "\t") this.emit(key("tab"));
      else if (ch === "\x7f" || ch === "\b") this.emit(key("backspace"));
      else if (c === 0) this.emit(key("space", { ctrl: true }));
      else if (c < 27) this.emit(key(String.fromCharCode(c + 96), { ctrl: true }));
      else if (c < 32 || (c >= 0x80 && c < 0xa0)) continue;
      else this.emit(printable(ch));
    }
  }
}

function printable(ch, extra = {}) {
  const hot = RU2EN.get(ch) ?? ch;
  return { type: "key", name: ch === " " ? "space" : ch, ch, hot, ctrl: false, alt: false, shift: ch !== ch.toLowerCase(), ...extra };
}

function mouse(code, x, y, release) {
  const base = code & ~(4 | 8 | 16 | 32);
  const drag = !!(code & 32);
  let action;
  if (code & 64) action = (code & 1) ? "wheeldown" : "wheelup";
  else if (release) action = "up";
  else if (drag) action = "drag";
  else action = "down";
  return { type: "mouse", action, button: base & 3, x, y, shift: !!(code & 4), ctrl: !!(code & 16) };
}
