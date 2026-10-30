// Product and recipe photos: WebP → RGBA (wasm, no system libraries) → pixels sized to terminal cells.
// One pixel is half a cell: the top colour is the ▀ glyph, the bottom one is the cell background.

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { diskGet, diskPut } from "./api.js";
import { safeUrl, readCapped } from "./safe.js";
import { USER_AGENT } from "./version.js";

const require = createRequire(import.meta.url);
const MAX_BYTES = 8 * 1024 * 1024;   // larger downloads are refused
const MAX_PIXELS = 25e6;             // larger decoded images are refused
const KEEP_WIDTH = 480;              // decoded images are shrunk right away: we never draw wider than this
const DECODED_LIMIT = 40;
const RESIZED_LIMIT = 300;

let decoder = null;
function getDecoder() {
  decoder ??= (async () => {
    const mod = await import("@jsquash/webp/decode.js");
    const wasm = require.resolve("@jsquash/webp/codec/dec/webp_dec.wasm");
    await mod.init(await WebAssembly.compile(await readFile(wasm)));
    return mod.default;
  })();
  return decoder;
}

const decoded = new Map(); // url → { w, h, data } | Promise | Error
const resized = new Map(); // url|w|h|mode → { w, h, px }
let onLoad = () => {};
export function onImageLoad(fn) { onLoad = fn; }

// Downloads: at most 4 at once and 120 a minute. The newest request goes first (it is the photo on
// screen now); when arrows race through a list, the photos scrolled past are dropped, not fetched.
const FETCH_MAX = 4, FETCH_QUEUE = 8, FETCH_PER_MIN = 120;
const waiting = [];
const fetched = [];
let fetching = 0;
let fetchTimer = null;
export class Skipped extends Error {}

function nextFetch() {
  clearTimeout(fetchTimer);
  while (fetching < FETCH_MAX && waiting.length) {
    const now = Date.now();
    while (fetched.length && now - fetched[0] > 60e3) fetched.shift();
    if (fetched.length >= FETCH_PER_MIN) { fetchTimer = setTimeout(nextFetch, fetched[0] + 60e3 - now + 50); fetchTimer.unref?.(); return; }
    const job = waiting.pop();
    fetched.push(now);
    fetching++;
    job.run().finally(() => { fetching--; nextFetch(); });
  }
}

function limited(fn) {
  return new Promise((resolve, reject) => {
    waiting.push({ run: () => fn().then(resolve, reject), reject });
    while (waiting.length > FETCH_QUEUE) waiting.shift().reject(new Skipped("scrolled past"));
    nextFetch();
  });
}

async function fetchBytes(url) {
  const hit = await diskGet("img", url, 30 * 24 * 3600e3);
  if (hit) return Buffer.from(hit, "base64");
  return limited(() => download(url));
}

async function download(url) {
  // No redirects: following one first and checking it afterwards would already have sent a request
  // wherever the server pointed, local addresses included
  const res = await fetch(url, { signal: AbortSignal.timeout(15e3), headers: { "User-Agent": USER_AGENT }, redirect: "error" });
  if (!res.ok) throw new Error(`photo ${res.status}`);
  const buf = await readCapped(res, MAX_BYTES);
  if (!buf) throw new Error("photo too large");
  diskPut("img", url, buf.toString("base64"));
  return buf;
}

// Box-filter downscale of RGBA to at most KEEP_WIDTH wide, alpha flattened onto white
function shrink({ width, height, data }) {
  const s = Math.min(1, KEEP_WIDTH / width);
  const w = Math.max(1, Math.round(width * s)), h = Math.max(1, Math.round(height * s));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * height) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * width) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * width) / w));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
        const i = (sy * width + sx) * 4, a = data[i + 3] / 255;
        r += data[i] * a + 255 * (1 - a); g += data[i + 1] * a + 255 * (1 - a); b += data[i + 2] * a + 255 * (1 - a); n++;
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { w, h, data: out };
}

// Picture size from the WebP header, so an oversized image is refused before it is decoded:
// a few kilobytes can describe a 16383×16383 picture, a gigabyte of pixels
export function webpSize(b) {
  if (b.length < 30 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return null;
  const kind = b.toString("latin1", 12, 16);
  if (kind === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
  if (kind === "VP8L" && b[20] === 0x2f) { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >>> 14) & 0x3fff) + 1 }; }
  if (kind === "VP8X") return { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 };
  return null;
}

async function load(url) {
  const decode = await getDecoder();
  const buf = await fetchBytes(url);
  const size = webpSize(buf);
  if (!size) throw new Error("not a WebP photo");
  if (size.w * size.h > MAX_PIXELS) throw new Error("photo too large");
  const img = await decode(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return shrink(img);
}

// Bounding box of the content inside a plain light margin: the product gets bigger on a dark screen
function contentBox(img) {
  const { w, h, data } = img;
  const light = (i) => data[i] > 238 && data[i + 1] > 238 && data[i + 2] > 238;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    if (!light((y * w + x) * 4)) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return { x: 0, y: 0, w, h };
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.06);
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function remember(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) map.delete(map.keys().next().value);
}

// A photo is fetched only once it has stayed on screen for SETTLE ms: arrows racing through a list
// ask for a photo per row, and the rows passed by never get one
const SETTLE = 150;
const asked = new Map(); // url → when it was first asked for
let settleTimer = null;
function settled(url) {
  const now = Date.now();
  const t = asked.get(url) ?? now;
  if (now - t >= SETTLE) { asked.delete(url); return true; }
  if (t === now) remember(asked, url, now, 200);
  // A redraw once the delay is over asks again for what is still on screen
  if (!settleTimer) { settleTimer = setTimeout(() => { settleTimer = null; onLoad(); }, t + SETTLE - now + 10); settleTimer.unref?.(); }
  return false;
}

// Pixels for a maxW × maxH cell area; mode is "contain" (fit inside) or "cover" (fill, cropping).
// Returns null while loading, { error: true } on failure.
export function image(url, maxW, maxH, { mode = "contain", trim = true } = {}) {
  if (!url || maxW < 2 || maxH < 1) return null;
  if (!safeUrl(url, "image")) return { error: true };
  const rkey = `${url}|${maxW}|${maxH}|${mode}`;
  if (resized.has(rkey)) return resized.get(rkey);
  const d = decoded.get(url);
  if (!d) {
    if (!settled(url)) return null;
    const p = load(url).then(
      (img) => { remember(decoded, url, img, DECODED_LIMIT); onLoad(); },
      // A skipped photo is forgotten, so it loads if it comes back on screen; a failed one is not retried
      // (no redraw for it: the next frame that still shows it asks again)
      (e) => {
        if (e instanceof Skipped) return decoded.delete(url);
        remember(decoded, url, e instanceof Error ? e : new Error(String(e)), DECODED_LIMIT);
        onLoad();
      },
    );
    decoded.set(url, p);
    return null;
  }
  if (d instanceof Promise) return null;
  if (d instanceof Error) return { error: true };
  const box = trim ? contentBox(d) : { x: 0, y: 0, w: d.w, h: d.h };
  const pxH = maxH * 2;
  let tw, th, sx = box.x, sy = box.y, sw = box.w, sh = box.h;
  if (mode === "cover") {
    tw = maxW; th = pxH;
    const ar = tw / th;
    if (sw / sh > ar) { const nw = sh * ar; sx += (sw - nw) / 2; sw = nw; } else { const nh = sw / ar; sy += (sh - nh) / 2; sh = nh; }
  } else {
    const s = Math.min(maxW / sw, pxH / sh);
    tw = Math.max(1, Math.round(sw * s)); th = Math.max(2, Math.round(sh * s));
    if (th % 2) th++;
  }
  const px = new Int32Array(tw * th);
  const data = d.data, W = d.w;
  // Average over the source area of every target pixel (sampled, up to 4×4 points)
  for (let ty = 0; ty < th; ty++) {
    const ya = sy + (ty * sh) / th, yb = sy + ((ty + 1) * sh) / th;
    for (let tx = 0; tx < tw; tx++) {
      const xa = sx + (tx * sw) / tw, xb = sx + ((tx + 1) * sw) / tw;
      let r = 0, g = 0, b = 0, n = 0;
      const stepY = Math.max(1, Math.floor((yb - ya) / 4)), stepX = Math.max(1, Math.floor((xb - xa) / 4));
      for (let y = Math.floor(ya); y < Math.max(Math.floor(ya) + 1, Math.ceil(yb)); y += stepY)
        for (let x = Math.floor(xa); x < Math.max(Math.floor(xa) + 1, Math.ceil(xb)); x += stepX) {
          const i = (Math.min(d.h - 1, y) * W + Math.min(W - 1, x)) * 4;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
      px[ty * tw + tx] = ((r / n) << 16) | ((g / n) << 8) | (b / n);
    }
  }
  const out = { w: tw, h: th, px };
  remember(resized, rkey, out, RESIZED_LIMIT);
  return out;
}
