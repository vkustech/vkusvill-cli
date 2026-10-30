// Variants of the QR code drawing, to see which ones a phone scans in a particular terminal.
// Each variant encodes its own link (…share=test-A and so on), so the phone shows which one it read.
// node test/qr-variants.js            all variants
// node test/qr-variants.js C D        only these

import qrcode from "qrcode-generator";

const VARIANTS = {
  A: { name: "▀, два модуля в ячейке", cols: 1, half: "▀" },
  B: { name: "▄, два модуля в ячейке", cols: 1, half: "▄" },
  C: { name: "заливка, модуль — 2 колонки × 1 строка", cols: 2 },
  D: { name: "заливка, модуль — 1 колонка × 1 строка, вытянут по высоте", cols: 1 },
};

const R = "\x1b[0m";
const bg = (dark) => `\x1b[48;5;${dark ? 16 : 231}m`;
const fg = (dark) => `\x1b[38;5;${dark ? 16 : 231}m`;
const out = (s = "") => process.stdout.write(s + "\n");

function matrix(text) {
  const q = qrcode(0, "L");
  q.addData(text);
  q.make();
  const n = q.getModuleCount(), quiet = 2;
  return { size: n + quiet * 2, dark: (r, c) => r >= quiet && c >= quiet && r < n + quiet && c < n + quiet && q.isDark(r - quiet, c - quiet) };
}

function draw({ cols, half }, text) {
  const { size, dark } = matrix(text);
  const rows = [];
  if (half) {
    for (let y = 0; y < size; y += 2) {
      let line = "";
      for (let x = 0; x < size; x++) {
        const top = dark(y, x), bot = dark(y + 1, x);
        if (top === bot) line += bg(top) + " ";
        else line += half === "▀" ? fg(top) + bg(bot) + "▀" : fg(bot) + bg(top) + "▄";
      }
      rows.push(line);
    }
  } else {
    for (let y = 0; y < size; y++) {
      let line = "";
      for (let x = 0; x < size; x++) line += bg(dark(y, x)) + " ".repeat(cols);
      rows.push(line);
    }
  }
  return { rows, w: size * cols };
}

const env = process.env;
const [W, H] = [process.stdout.columns ?? 0, process.stdout.rows ?? 0];
out(`Терминал: ${[env.TERM_PROGRAM, env.TERMINAL_EMULATOR, env.TERM].filter(Boolean).join(" · ") || "неизвестен"} · окно ${W}×${H}`);
out("Сканируйте по очереди. Телефон покажет ссылку с test-A, test-B… — это вариант, который прочитался.");

const pick = process.argv.slice(2).map((s) => s.toUpperCase()).filter((k) => VARIANTS[k]);
for (const key of pick.length ? pick : Object.keys(VARIANTS)) {
  const v = VARIANTS[key];
  const { rows, w } = draw(v, `https://vkusvill.ru/mobile?basket&share=test-${key}`);
  out();
  out(`${key}: ${v.name} · ${w}×${rows.length}`);
  if (W && w + 2 > W) { out(`  окно уже ${w + 2} колонок — не помещается`); continue; }
  out();
  for (const r of rows) out("  " + r + R);
}
out();
