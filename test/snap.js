// Runs the interface without a terminal: a scripted key sequence produces screen snapshots as HTML and text.
// node test/snap.js [width] [height] — snapshots go to test/out/
// The script adds to the cart and makes a cart link, so it runs signed out with a throwaway config:
// your cart, history and sign-in are never touched.
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tmp = mkdtempSync(path.join(tmpdir(), "vv-snap-"));
process.env.VV_CONFIG_DIR = path.join(tmp, "config");
process.env.VV_SECRETS = "file";
delete process.env.VV_TOKEN;

const { App } = await import("../src/app.js");
const { Input } = await import("../src/term/input.js");
const { VIEWS } = await import("../src/main.js");
const { Splash } = await import("../src/views/overlays.js");

const [W = 140, H = 42] = process.argv.slice(2).map(Number);
// A path, not a URL: on Windows URL.pathname would be "/C:/…"
const OUT = fileURLToPath(new URL("./out/", import.meta.url));
mkdirSync(OUT, { recursive: true });

process.env.VV_COLOR = "truecolor";
const app = new App({ views: VIEWS, headless: true, size: [W, H] });
let captured = "";
app.screen.out = { write: (s) => { captured += s; } };
app.screen.truecolor = true;
const input = new Input({ isTTY: false }, (ev) => app.onEvent(ev));
app.page.onShow?.();
const ticker = setInterval(() => app.tick(), 90);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = (s) => input.feed(s);
const esc = async () => { input.feed("\x1b"); await sleep(60); };
const frames = [];
const snap = (name) => {
  app.render();
  app.screen.invalidateAll();
  captured = "";
  app.screen.flush();
  writeFileSync(OUT + name + ".html", xterm(captured, name));
  frames.push([name, captured]);
  writeFileSync(OUT + name + ".txt", app.screen.snapshot());
  console.log("snap", name);
};
// Snapshot in a real terminal emulator: xterm.js gets exactly the bytes that would go to the terminal
const xterm = (ansi, name) => `<!doctype html><meta charset="utf-8"><title>${name}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js"></script>
<style>body{margin:0;background:#0b130e}#t{padding:6px}</style><div id="t"></div>
<script>
const cols=${W}, rows=${H};
const fs = Math.max(6, Math.floor((innerWidth - 16) / (cols * 0.6)));
const term = new Terminal({ cols, rows, fontSize: fs, fontFamily: "Menlo, 'SF Mono', monospace", allowProposedApi: true, theme: { background: "#0b130e" } });
term.open(document.getElementById("t"));
term.write(${JSON.stringify("\x1b[?1049h")} + ${JSON.stringify(ansi)});
</script>`;
const until = async (fn, ms = 15000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await sleep(100); await sleep(400); };

app.overlay(new Splash(app, { duration: 100000 }));
await sleep(600);
snap("00-splash");
key("x");
await until(() => app.page.items?.length);
snap("01-home");
key("творог");
await until(() => app.page.title?.includes("творог") && app.page.items?.length && !app.page.loading);
key("\x1b[B"); await sleep(50); key("\x1b[B"); await sleep(1500);
snap("02-search");
key("+"); key("+"); key("\r");
await until(() => app.page.p?.props?.length > 4);
await sleep(1200);
snap("03-product");
await esc(); key("x"); key("\x1b[B"); key("x"); key("X");
await sleep(1500);
snap("04-compare");
await esc(); key("f");
await sleep(200);
snap("05-filter-menu");
await esc();
key("2");
await until(() => app.page.items?.length);
await sleep(1500);
snap("06-deals");
key("+");
key("3");
await until(() => app.page.items?.length);
await sleep(1500);
snap("07-recipes");
key("\r");
await sleep(2500);
snap("08-recipe");
await esc(); key("4");
await until(() => app.page.items?.length);
await sleep(300);
snap("09-shops");
key("z");
await sleep(200);
snap("10-shops-zoom");
key("5");
await sleep(300);
snap("11-cart");
key("o");
await until(() => app.overlays.at(-1)?.link || app.overlays.at(-1)?.error);
snap("12-checkout");
key("z"); // the other size of the QR code, when both fit
await sleep(50);
snap("12-checkout-z");
await esc(); key("6");
await sleep(300);
snap("13-profile");
key("\x0b");
await sleep(100);
snap("14-palette");
await esc(); key("?");
await sleep(100);
snap("15-help");
clearInterval(ticker);
writeFileSync(OUT + "gallery.html", `<!doctype html><meta charset="utf-8"><title>vv-cli gallery</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js"></script>
<style>body{margin:0;background:#050806;color:#7f9a88;font:12px Menlo,monospace}h2{margin:14px 8px 4px;font-size:12px}</style><body>
<script>const F=${JSON.stringify(frames)};
const fs=Math.max(6,Math.floor((innerWidth-16)/(${W}*0.6)));
for(const [n,a] of F){const h=document.createElement("h2");h.id=n;h.textContent=n;document.body.append(h);const d=document.createElement("div");document.body.append(d);
const t=new Terminal({cols:${W},rows:${H},fontSize:fs,fontFamily:"Menlo, monospace",theme:{background:"#0b130e"}});t.open(d);t.write("\\x1b[?1049h"+a);}
</script>`);
process.exit(0);
