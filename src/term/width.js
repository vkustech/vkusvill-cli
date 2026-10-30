// Terminal cell width of a character: 0 for combining marks, 2 for CJK and emoji, 1 otherwise.

const WIDE = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
];

export function charWidth(cp) {
  // C0 controls, DEL and C1 (\x9b is CSI) are never printed
  if (cp < 0x300) return cp < 32 || (cp >= 0x7f && cp < 0xa0) ? 0 : 1;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0xfeff || cp === 0xfe0f || cp === 0xfe0e) return 0;
  for (const [a, b] of WIDE) if (cp >= a && cp <= b) return 2;
  return 1;
}

export function strWidth(s) {
  let w = 0;
  for (const ch of s) w += charWidth(ch.codePointAt(0));
  return w;
}

// Truncates a string to width w, ending it with "…" if it doesn't fit
export function truncate(s, w) {
  if (w <= 0) return "";
  if (strWidth(s) <= w) return s;
  let out = "", cur = 0;
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0));
    if (cur + cw > w - 1) break;
    out += ch;
    cur += cw;
  }
  return out + "…";
}

export function padEnd(s, w) {
  const t = truncate(s, w);
  return t + " ".repeat(Math.max(0, w - strWidth(t)));
}

export function padStart(s, w) {
  const t = truncate(s, w);
  return " ".repeat(Math.max(0, w - strWidth(t))) + t;
}

// Word wrap; overlong words are split
export function wrap(text, w) {
  w = Math.max(1, Math.floor(w));
  const lines = [];
  for (const para of String(text).split("\n")) {
    const start = lines.length;
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let wd = word;
      // An overlong word is cut in one pass over its characters: re-measuring the rest after every
      // cut would be quadratic, and a long server string would freeze the screen
      if (strWidth(wd) > w) {
        if (line) { lines.push(line); line = ""; }
        let cut = "", cw = 0;
        for (const ch of wd) {
          const chw = charWidth(ch.codePointAt(0));
          // a glyph wider than the line still has to go somewhere
          if (cw + chw > w && cut) { lines.push(cut); cut = ""; cw = 0; }
          cut += ch;
          cw += chw;
        }
        wd = cut;
      }
      if (!wd) continue;
      if (!line) line = wd;
      else if (strWidth(line) + 1 + strWidth(wd) <= w) line += " " + wd;
      else { lines.push(line); line = wd; }
    }
    // An empty paragraph stays a blank line; a paragraph that ended on a split word adds nothing more
    if (line || lines.length === start) lines.push(line);
  }
  return lines;
}
