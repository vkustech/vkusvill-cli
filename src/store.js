// Persistent state: cart, favourites, history, recent searches and UI preferences.
// One JSON file in ~/.config/vv-cli/state.json, readable by the owner only.
//
// - Writes are atomic (temp file + rename) and debounced; exit and crash paths flush synchronously.
// - Everything read from disk is validated: a hand-edited or truncated file never crashes the app.
// - A file that cannot be parsed is kept as state.json.broken-<time> instead of being overwritten.
// - Another process (a second TUI, `vv cart add`) may change the file: the TUI watches it and reloads.

import { mkdirSync, readFileSync, renameSync, statSync, chmodSync, watchFile, unwatchFile } from "node:fs";
import path from "node:path";
import { CONFIG_DIR as DIR, writePrivate } from "./paths.js";
import { snapshot, fromSnapshot, lineTotal, qtyStep } from "./product.js";

const VERSION = 2;
const FILE = path.join(DIR, "state.json");

export const CART_MAX = 100;
export const QTY_MAX = 40;
const HISTORY_MAX = 60;
const QUERIES_MAX = 20;
const FAVS_MAX = 500;

const isId = (v) => Number.isInteger(v) && v > 0 && v < 1e9;
const clampQty = (q) => Math.min(QTY_MAX, Math.max(0.01, Math.round(q * 100) / 100));

function validProduct(p) {
  return p && typeof p === "object" && isId(p.id) && typeof p.name === "string" && Number.isFinite(p.price);
}

class Store {
  constructor() {
    this.cart = [];      // [{ p, q, at }] — `at` is when the price snapshot was taken
    this.favs = [];
    this.history = [];
    this.queries = [];
    this.prefs = {};     // UI state: last tab, filters, sorts
    this.warning = null;   // shown once by the TUI
    this.saveError = null; // last failed write, shown by the TUI
    this.listeners = new Set();
    this.mtime = 0;
    this.load();
  }

  load() {
    let raw;
    try { raw = readFileSync(FILE, "utf8"); } catch { return; }
    let s;
    try {
      s = JSON.parse(raw);
      if (!s || typeof s !== "object") throw new Error("not an object");
    } catch {
      const backup = `${FILE}.broken-${Date.now()}`;
      try { renameSync(FILE, backup); } catch {}
      this.warning = `Файл состояния был поврежден — копия в ${backup}`;
      return;
    }
    const now = Date.now();
    this.cart = (Array.isArray(s.cart) ? s.cart : [])
      .filter((l) => validProduct(l?.p) && Number.isFinite(l.q) && l.q > 0)
      .slice(0, CART_MAX)
      .map((l) => ({ p: fromSnapshot(l.p), q: clampQty(l.q), at: Number.isFinite(l.at) ? l.at : now }));
    this.favs = (Array.isArray(s.favs) ? s.favs : []).filter(validProduct).slice(0, FAVS_MAX).map(fromSnapshot);
    this.history = (Array.isArray(s.history) ? s.history : []).filter(validProduct).slice(0, HISTORY_MAX).map(fromSnapshot);
    this.queries = (Array.isArray(s.queries) ? s.queries : []).filter((q) => typeof q === "string" && q.length <= 100).slice(0, QUERIES_MAX);
    this.prefs = s.prefs && typeof s.prefs === "object" && !Array.isArray(s.prefs) ? s.prefs : {};
    try { this.mtime = statSync(FILE).mtimeMs; } catch {}
  }

  save() {
    clearTimeout(this.timer);
    this.pending = true;
    this.timer = setTimeout(() => this.saveNow(), 200);
  }

  saveNow() {
    clearTimeout(this.timer);
    this.pending = false;
    try {
      mkdirSync(DIR, { recursive: true, mode: 0o700 });
      const data = {
        v: VERSION,
        cart: this.cart.map((l) => ({ p: snapshot(l.p), q: l.q, at: l.at })),
        favs: this.favs.map(snapshot),
        history: this.history.map(snapshot),
        queries: this.queries,
        prefs: this.prefs,
      };
      const tmp = `${FILE}.${process.pid}.tmp`;
      writePrivate(tmp, JSON.stringify(data));
      renameSync(tmp, FILE);
      // Older versions created these with default permissions: tighten on every write
      try { chmodSync(FILE, 0o600); chmodSync(DIR, 0o700); } catch {}
      this.mtime = statSync(FILE).mtimeMs;
      this.saveError = null;
    } catch (e) {
      // Surfaced by the TUI; a lost write must never be silent
      this.saveError = e.message;
      this.notify();
    }
  }

  // Reload when another process rewrites the file (polling: fs.watch is unreliable across platforms)
  watch() {
    watchFile(FILE, { interval: 1000 }, (cur) => {
      // A pending local write wins: it is the newer intent and is about to land
      if (!cur.mtimeMs || cur.mtimeMs === this.mtime || this.pending) return;
      this.load();
      this.notify();
    });
  }

  unwatch() { unwatchFile(FILE); }

  notify() { for (const fn of this.listeners) fn(); }

  changed() {
    this.save();
    this.notify();
  }

  // ——— Preferences ———

  pref(key, fallback) { return this.prefs[key] ?? fallback; }
  setPref(key, value) { this.prefs[key] = value; this.save(); }

  // ——— Cart ———

  qty(id) { return this.cart.find((l) => l.p.id === id)?.q ?? 0; }

  add(p, delta = qtyStep(p)) {
    if (!validProduct(p) || !Number.isFinite(delta) || delta === 0) return false;
    const line = this.cart.find((l) => l.p.id === p.id);
    if (line) {
      const q = Math.round((line.q + delta) * 100) / 100;
      if (q < 0.01) this.cart = this.cart.filter((l) => l !== line);
      else line.q = clampQty(q);
      if (p.comp) { line.p = p; line.at = Date.now(); } // a fuller product refreshes the snapshot
    } else if (delta > 0) {
      if (this.cart.length >= CART_MAX) return false;
      this.cart.push({ p, q: clampQty(delta), at: Date.now() });
    }
    this.changed();
    return true;
  }

  // Fresh price data for a cart line
  refresh(id, p) {
    const line = this.cart.find((l) => l.p.id === id);
    if (!line || !validProduct(p)) return false;
    const changed = line.p.price !== p.price;
    line.p = { ...line.p, ...p };
    line.at = Date.now();
    return changed;
  }

  stale(maxAge) { return this.cart.filter((l) => Date.now() - l.at > maxAge); }

  remove(id) { this.cart = this.cart.filter((l) => l.p.id !== id); this.changed(); }
  clearCart() { this.cart = []; this.changed(); }

  get total() { return this.cart.reduce((s, l) => s + lineTotal(l.p, l.q), 0); }
  get savings() { return this.cart.reduce((s, l) => s + (l.p.old ? (l.p.old - l.p.price) * l.q : 0), 0); }
  get count() { return this.cart.length; }

  // ——— Favourites and history ———

  isFav(id) { return this.favs.some((p) => p.id === id); }

  toggleFav(p) {
    if (this.isFav(p.id)) this.favs = this.favs.filter((x) => x.id !== p.id);
    else this.favs = [p, ...this.favs].slice(0, FAVS_MAX);
    this.changed();
    return this.isFav(p.id);
  }

  viewed(p) {
    this.history = [p, ...this.history.filter((x) => x.id !== p.id)].slice(0, HISTORY_MAX);
    this.save();
  }

  rememberQuery(q) {
    q = q.trim().slice(0, 100);
    if (!q) return;
    this.queries = [q, ...this.queries.filter((x) => x !== q)].slice(0, QUERIES_MAX);
    this.save();
  }
}

export const store = new Store();
