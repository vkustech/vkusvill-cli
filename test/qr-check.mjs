// QR check: draws the code into the screen buffer, rebuilds the pixels a terminal would show and decodes them with jsQR.
// The code of filled cells must scan wherever a terminal puts its line spacing. The half-size one of ▄ is a fallback for
// small windows: it must scan where glyphs fill the cell and where the spacing is above them; elsewhere jsQR reads it
// for some links only (about half), so there it is reported, not required.
// node test/qr-check.mjs <path to jsqr>
import { Screen } from "../src/term/screen.js";
import { G } from "../src/ui/draw.js";

const jsQR = (await import(process.argv[2])).default;
const text = "https://vkusvill.ru/mobile?basket&share=80337";
// Cell size in pixels and the rows its block glyphs fill; JetBrains is measured from a screenshot
const TERMINALS = {
  exact: { cell: [15, 34, 0, 34], half: true },
  "spacing above (JetBrains)": { cell: [15, 34, 8, 34], half: true },
  "spacing below": { cell: [15, 34, 0, 26], half: false },
  "spacing split": { cell: [15, 34, 4, 30], half: false },
};

function scan(half, [cw, ch, g0, g1]) {
  const s = new Screen({ columns: 90, rows: 50, write() {} });
  s.clear(0x0b130e);
  const { w, h } = new G(s).qr(3, 2, text, half);
  const mid = (g0 + g1) >> 1;
  const glyph = { "▀": [g0, mid], "▄": [mid, g1] };
  const pad = 3, W = (w + pad * 2) * cw, H = (h + pad * 2) * ch;
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let cy = 0; cy < h; cy++) for (let cx = 0; cx < w; cx++) {
    const i = (2 + cy) * s.w + 3 + cx;
    const g = glyph[s.ch[i]];
    for (let y = 0; y < ch; y++) {
      if ((g && y >= g[0] && y < g[1] ? s.fg[i] : s.bg[i]) !== 0) continue;
      for (let x = 0; x < cw; x++) {
        const o = (((pad + cy) * ch + y) * W + (pad + cx) * cw + x) * 4;
        data[o] = data[o + 1] = data[o + 2] = 0;
      }
    }
  }
  return jsQR(data, W, H)?.data === text;
}

let failed = false;
for (const [name, t] of Object.entries(TERMINALS)) {
  const full = scan(false, t.cell), half = scan(true, t.cell);
  console.log(`${name}: filled cells ${full ? "OK" : "FAIL"}, ▄ ${half ? "OK" : t.half ? "FAIL" : "not read (not required)"}`);
  failed ||= !full || (t.half && !half);
}
process.exit(failed ? 1 : 0);
