// QR check: draws the code into the screen buffer with half blocks, rebuilds the pixels from the cells and decodes them with jsQR.
// node test/qr-check.mjs <path to jsqr>
import { Screen } from "../src/term/screen.js";
import { G } from "../src/ui/draw.js";

const jsQR = (await import(process.argv[2])).default;
const text = "https://vkusvill.ru/mobile?basket&share=80337";
const s = new Screen({ columns: 60, rows: 30, write() {} });
s.clear(0x0b130e);
const g = new G(s);
const { w, h } = g.qr(3, 2, text);
// A ▀ cell: the top pixel is the foreground color, the bottom one is the background; scale 8
const K = 8, W = (w + 6) * K, H = (h * 2 + 6) * K;
const data = new Uint8ClampedArray(W * H * 4).fill(255);
for (let cy = 0; cy < h; cy++) for (let cx = 0; cx < w; cx++) {
  const i = (2 + cy) * s.w + 3 + cx;
  const ch = s.ch[i];
  const top = ch === " " ? s.bg[i] : s.fg[i];
  const bot = s.bg[i];
  for (const [py, col] of [[cy * 2, top], [cy * 2 + 1, bot]]) {
    const v = col === 0 ? 0 : 255;
    for (let y = 0; y < K; y++) for (let x = 0; x < K; x++) {
      const o = (((py + 3) * K + y) * W + (cx + 3) * K + x) * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
    }
  }
}
const res = jsQR(data, W, H);
console.log(res?.data === text ? `QR OK: ${res.data}` : `QR FAIL: ${res?.data}`);
