// Variants of the large price display, to see how each one renders in a particular terminal.
// node test/price-variants.js

const tc = /truecolor|24bit/i.test(process.env.COLORTERM ?? "") || process.env.TERM_PROGRAM !== "Apple_Terminal";
const rgb = (c, bg) => {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  if (tc) return `\x1b[${bg ? 48 : 38};2;${r};${g};${b}m`;
  const i = (v) => Math.round((v / 255) * 5);
  return `\x1b[${bg ? 48 : 38};5;${16 + 36 * i(r) + 6 * i(g) + i(b)}m`;
};
const R = "\x1b[0m", B = "\x1b[1m";
const LIME = 0xb5e853, DARK = 0x0b130e, ORANGE = 0xff9f43;
const price = (n) => `${n.toLocaleString("ru-RU").replace(/\s/g, " ")} ₽`;

const SETS = {
  heavy: {
    "0": ["┏━┓", "┃ ┃", "┗━┛"], "1": ["╺┓ ", " ┃ ", "╺┻╸"], "2": ["╺━┓", "┏━┛", "┗━╸"], "3": ["╺━┓", "╺━┫", "╺━┛"], "4": ["╻ ╻", "┗━┫", "  ╹"],
    "5": ["┏━╸", "┗━┓", "╺━┛"], "6": ["┏━╸", "┣━┓", "┗━┛"], "7": ["╺━┓", "  ┃", "  ╹"], "8": ["┏━┓", "┣━┫", "┗━┛"], "9": ["┏━┓", "┗━┫", "╺━┛"], "₽": ["┏━┓", "╋━┛", "╹  "],
  },
  double: {
    "0": ["╔═╗", "║ ║", "╚═╝"], "1": ["═╗ ", " ║ ", "═╩═"], "2": ["══╗", "╔═╝", "╚══"], "3": ["══╗", " ═╣", "══╝"], "4": ["╥ ╥", "╚═╣", "  ╨"],
    "5": ["╔══", "╚═╗", "══╝"], "6": ["╔══", "╠═╗", "╚═╝"], "7": ["══╗", "  ║", "  ╨"], "8": ["╔═╗", "╠═╣", "╚═╝"], "9": ["╔═╗", "╚═╣", "══╝"], "₽": ["╔═╗", "╬═╝", "╨  "],
  },
  round: {
    "0": ["╭─╮", "│ │", "╰─╯"], "1": ["╶╮ ", " │ ", "╶┴╴"], "2": ["╶─╮", "╭─╯", "╰─╴"], "3": ["╶─╮", " ─┤", "╶─╯"], "4": ["╷ ╷", "╰─┤", "  ╵"],
    "5": ["╭─╴", "╰─╮", "╶─╯"], "6": ["╭─╴", "├─╮", "╰─╯"], "7": ["╶─╮", "  │", "  ╵"], "8": ["╭─╮", "├─┤", "╰─╯"], "9": ["╭─╮", "╰─┤", "╶─╯"], "₽": ["╭─╮", "┼─╯", "╵  "],
  },
};

// 3×5 pixel font: a pixel is a cell filled with background color (no glyphs, hence no gaps)
const PIX = {
  "0": ["###", "#.#", "#.#", "#.#", "###"], "1": [".#.", "##.", ".#.", ".#.", "###"], "2": ["###", "..#", "###", "#..", "###"],
  "3": ["###", "..#", ".##", "..#", "###"], "4": ["#.#", "#.#", "###", "..#", "..#"], "5": ["###", "#..", "###", "..#", "###"],
  "6": ["###", "#..", "###", "#.#", "###"], "7": ["###", "..#", "..#", ".#.", ".#."], "8": ["###", "#.#", "###", "#.#", "###"],
  "9": ["###", "#.#", "###", "..#", "###"], "₽": [".###.", ".#..#", "####.", ".#...", ".#..."], " ": ["..", "..", "..", "..", ".."],
};

function lines(set, s) {
  const rows = ["", "", ""];
  for (const c of s) {
    const g = set[c];
    if (!g) { rows.forEach((_, i) => (rows[i] += " ")); continue; }
    g.forEach((r, i) => (rows[i] += r + " "));
  }
  return rows;
}

function pixels(s, cw, fg, bg) {
  const rows = ["", "", "", "", ""];
  for (const c of s) {
    const g = PIX[c] ?? PIX[" "];
    for (let y = 0; y < 5; y++) {
      for (const px of g[y]) rows[y] += px === "#" ? rgb(fg, true) + " ".repeat(cw) : rgb(bg, true) + " ".repeat(cw);
      rows[y] += rgb(bg, true) + " ".repeat(cw);
    }
  }
  return rows.map((r) => r + R);
}

const out = (s = "") => process.stdout.write(s + "\n");
const title = (t) => out(`\n${B}${t}${R}`);

out(`терминал: ${process.env.TERM_PROGRAM ?? "?"} · TERM=${process.env.TERM} · ${tc ? "truecolor" : "256 цветов"}`);

for (const [k, name] of [["heavy", "A · жирные линии (сейчас)"], ["double", "B · двойные линии"], ["round", "C · тонкие скругленные"]]) {
  title(name);
  const a = lines(SETS[k], price(725)), b = lines(SETS[k], price(1208));
  a.forEach((r, i) => out(`  ${rgb(LIME)}${B}${r}${R}      ${rgb(ORANGE)}${B}${b[i]}${R}`));
}

title("D · пиксели фоном, квадратные (ячейка ×2)");
pixels(price(725), 2, LIME, DARK).forEach((r) => out("  " + r));

title("E · пиксели фоном, узкие (как табло)");
const e1 = pixels(price(725), 1, LIME, DARK), e2 = pixels(price(1208), 1, ORANGE, DARK);
e1.forEach((r, i) => out(`  ${r}    ${e2[i]}`));

title("F · ценник: заливка и обычный жирный текст");
for (const [n, c, old] of [[725, LIME, null], [1208, ORANGE, 1390]]) {
  const t = `  ${price(n)}  `;
  out(`  ${rgb(c, true)}${" ".repeat(t.length)}${R}`);
  out(`  ${rgb(c, true)}${rgb(DARK)}${B}${t}${R}${old ? `  ${rgb(0x6f8a77)}\x1b[9m${price(old)}${R} ${rgb(ORANGE)}${B}−13%${R}` : ""}`);
  out(`  ${rgb(c, true)}${" ".repeat(t.length)}${R}`);
}

title("G · ценник с цифрами-линиями внутри");
{
  const rows = lines(SETS.heavy, price(725));
  const w = rows[0].length + 3;
  out(`  ${rgb(LIME, true)}${" ".repeat(w)}${R}`);
  rows.forEach((r) => out(`  ${rgb(LIME, true)}${rgb(DARK)}${B}  ${r} ${R}`));
  out(`  ${rgb(LIME, true)}${" ".repeat(w)}${R}`);
}

// Postcode digits from a Russian envelope: a "two squares" grid with a diagonal in each
// t m b — horizontals; lu ld ru rd — vertical halves; du — upper square diagonal, dd — lower one
const POSTAL = {
  "0": "t b lu ld ru rd", "1": "du ru rd", "2": "t ru dd b", "3": "t du m rd b", "4": "lu m ru rd",
  "5": "t lu m rd b", "6": "du ld m rd b", "7": "t du ld", "8": "t m b lu ld ru rd", "9": "t lu ru m dd",
};

// Segments → a W×5 "pixel" grid; diagonals as a staircase
function postalGrid(d, W) {
  const g = Array.from({ length: 5 }, () => Array(W).fill(0));
  const on = (x, y) => { g[y][x] = 1; };
  for (const seg of POSTAL[d].split(" ")) {
    if (seg === "t" || seg === "m" || seg === "b") for (let x = 0; x < W; x++) on(x, { t: 0, m: 2, b: 4 }[seg]);
    if (seg[0] === "l" || seg[0] === "r") { const x = seg[0] === "l" ? 0 : W - 1, y0 = seg[1] === "u" ? 0 : 2; for (let y = y0; y <= y0 + 2; y++) on(x, y); }
    if (seg === "du" || seg === "dd") {
      const y0 = seg === "du" ? 0 : 2;
      on(W - 1, y0); on(0, y0 + 2);
      for (let x = 1; x < W - 1; x++) on(x, y0 + 1);
    }
  }
  return g;
}

// Thin lines: each cell has up/down/left/right connections; the diagonal is ╱
const LIGHT = { 0: " ", 1: "╵", 2: "╷", 3: "│", 4: "╴", 8: "╶", 12: "─", 10: "┌", 6: "┐", 9: "└", 5: "┘", 11: "├", 7: "┤", 14: "┬", 13: "┴", 15: "┼" };
function postalLines(d) {
  const W = 3, m = Array.from({ length: 5 }, () => Array(W).fill(0)), diag = new Set();
  const h = (y) => { for (let x = 0; x < W; x++) m[y][x] |= (x > 0 ? 4 : 0) | (x < W - 1 ? 8 : 0); };
  const v = (x, y0) => { for (let y = y0; y <= y0 + 2; y++) m[y][x] |= (y > y0 ? 1 : 0) | (y < y0 + 2 ? 2 : 0); };
  for (const seg of POSTAL[d].split(" ")) {
    if (seg === "t") h(0); if (seg === "m") h(2); if (seg === "b") h(4);
    if (seg === "lu") v(0, 0); if (seg === "ld") v(0, 2); if (seg === "ru") v(W - 1, 0); if (seg === "rd") v(W - 1, 2);
    if (seg === "du") diag.add("1,1"); if (seg === "dd") diag.add("3,1");
  }
  return m.map((row, y) => row.map((mask, x) => (diag.has(`${y},${x}`) ? "╱" : LIGHT[mask])).join(""));
}

title("I · индекс с конверта, линиями");
{
  const rows = ["", "", "", "", ""];
  for (const c of "725") postalLines(c).forEach((r, i) => (rows[i] += r + "  "));
  const rows2 = ["", "", "", "", ""];
  for (const c of "1208") postalLines(c).forEach((r, i) => (rows2[i] += r + "  "));
  rows.forEach((r, i) => out(`  ${rgb(LIME)}${B}${r}${i === 4 ? "₽" : " "}${R}      ${rgb(ORANGE)}${B}${rows2[i]}${i === 4 ? "₽" : " "}${R}`));
}

title("J · индекс с конверта, пикселями фоном (без щелей)");
{
  const draw = (s, fg) => {
    const rows = ["", "", "", "", ""];
    for (const c of s) {
      const g = postalGrid(c, 4);
      for (let y = 0; y < 5; y++) rows[y] += g[y].map((p) => rgb(p ? fg : DARK, true) + " ").join("") + rgb(DARK, true) + "  ";
    }
    return rows.map((r, i) => r + R + (i === 4 ? ` ${rgb(fg)}${B}₽${R}` : "  "));
  };
  const a = draw("725", LIME), b = draw("1208", ORANGE);
  a.forEach((r, i) => out(`  ${r}    ${b[i]}`));
}

// Larger postcode digits: a W×H grid, segments drawn as thin Bresenham lines between the envelope nodes
function postalBig(d, W, H) {
  const g = Array.from({ length: H }, () => Array(W).fill(0));
  const M = (H - 1) / 2, P = { TL: [0, 0], TR: [W - 1, 0], ML: [0, M], MR: [W - 1, M], BL: [0, H - 1], BR: [W - 1, H - 1] };
  const SEG = { t: ["TL", "TR"], m: ["ML", "MR"], b: ["BL", "BR"], lu: ["TL", "ML"], ld: ["ML", "BL"], ru: ["TR", "MR"], rd: ["MR", "BR"], du: ["TR", "ML"], dd: ["MR", "BL"] };
  for (const seg of POSTAL[d].split(" ")) {
    const [[x0, y0], [x1, y1]] = SEG[seg].map((k) => P[k]);
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= n; i++) g[Math.round(y0 + ((y1 - y0) * i) / n)][Math.round(x0 + ((x1 - x0) * i) / n)] = 1;
  }
  return g;
}
for (const [W, H] of [[5, 7], [6, 9]]) {
  title(`K · индекс ${W}×${H}, пикселями фоном`);
  const draw = (str, fg) => {
    const rows = Array(H).fill("");
    for (const c of str) {
      const g = postalBig(c, W, H);
      for (let y = 0; y < H; y++) rows[y] += g[y].map((p) => rgb(p ? fg : DARK, true) + " ").join("") + rgb(DARK, true) + "  ";
    }
    return rows.map((r, i) => r + R + (i === H - 1 ? ` ${rgb(fg)}${B}₽${R}` : "  "));
  };
  const a = draw("725", LIME), b = draw("1208", ORANGE);
  a.forEach((r, i) => out(`  ${r}    ${b[i]}`));
}

title("L · двойная высота строки (DECDHL; работает не везде)");
out(`  \x1b#3${rgb(LIME)}${B}725 ₽${R}`);
out(`  \x1b#4${rgb(LIME)}${B}725 ₽${R}`);
out();
