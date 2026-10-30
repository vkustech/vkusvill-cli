// Shops: region, city, metro and feature filters, "open now" from the opening hours,
// and a Braille-dot map of all loaded shops with crosshairs on the selected one; z zooms in.

import { T, mix } from "../ui/theme.js";
import { ListView, Menu, TextInput, ChipBar } from "../ui/widgets.js";
import { Braille } from "../ui/draw.js";
import * as api from "../api.js";
import { plural } from "../product.js";
import { store } from "../store.js";
import { loader } from "./browser.js";
import { openUrl, copy } from "../sys.js";
import { strWidth } from "../term/width.js";

// "All on the map" and the walk that learns a region's cities stop here: 40 pages are 400 shops
const ALL_PAGES = 40;

// Moscow outlines for the map backdrop: MKAD ring road, Garden Ring, Kremlin
const MKAD = [[55.911, 37.59], [55.896, 37.70], [55.86, 37.80], [55.81, 37.843], [55.75, 37.843], [55.69, 37.83], [55.64, 37.80], [55.60, 37.73], [55.574, 37.68], [55.58, 37.60], [55.60, 37.50], [55.64, 37.45], [55.68, 37.41], [55.73, 37.37], [55.79, 37.37], [55.84, 37.39], [55.88, 37.45], [55.905, 37.53], [55.911, 37.59]];
const CENTER = [55.752, 37.617];
const MOSCOW_BOX = { lat0: 55.52, lat1: 55.96, lon0: 37.25, lon1: 37.98 };

const FILTER_KEYS = { region: "region", city: "city", subway: "subway", feature: "feature" };
const FILTER_NAMES = { region: "Регион", city: "Город", subway: "Метро", feature: "Особенность" };

// Moscow time: opening hours are given in local time, and most shops are in the Moscow time zone
function mskMinutes() {
  const d = new Date(Date.now() + 3 * 3600e3);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function openState(schedule) {
  if (!schedule) return null;
  if (/круглосуточно/i.test(schedule)) return { open: true, text: "круглосуточно" };
  const m = /(\d{1,2})[:.](\d{2})\s*(?:до|-|–|—)\s*(\d{1,2})[:.](\d{2})/.exec(schedule);
  if (!m) return null;
  const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
  const now = mskMinutes();
  const open = b > a ? now >= a && now < b : now >= a || now < b;
  const hh = (v) => `${String(Math.floor(v / 60) % 24).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
  return { open, text: open ? `открыт до ${hh(b)}` : `закрыт · откроется в ${hh(a)}` };
}

export function shopsView(app) {
  return new ShopsView(app);
}

// Warehouse for online orders only: «Только для курьеров, …», «Закрыт для покупателей…»
export const isCourier = (s) => /только для курьер|закрыт для покупател/i.test(`${s.address} ${s.schedule ?? ""} ${s.description ?? ""}`);
const cleanAddress = (s) => s.address.replace(/^только для курьеров,?\s*/i, "");

export function shopState(s) {
  if (isCourier(s)) return { open: false, courier: true, text: "склад онлайн-заказов, покупателей не пускают" };
  return openState(s.schedule);
}

// City → region and metro → city links: the VkusVill reference lists don't provide them, so we collect
// them from the shops we load and keep them on disk; city and metro lists narrow down to the chosen region
const GEO_TTL = 90 * 24 * 3600e3;
const geo = { cities: {}, subways: {}, done: {} };
const geoReady = api.diskGet("geo", "v1", GEO_TTL).then((g) => { if (g) Object.assign(geo, g); });
let geoTimer = null;
function learn(items) {
  for (const s of items) {
    const r = s.region?.id;
    if (s.city?.id) {
      const c = (geo.cities[s.city.id] ??= { r, shops: {} });
      c.r = r;
      c.shops[s.id] = 1;
    }
    if (s.subway?.id) geo.subways[s.subway.id] = { r, c: s.city?.id, shops: { ...geo.subways[s.subway.id]?.shops, [s.id]: 1 } };
  }
  clearTimeout(geoTimer);
  geoTimer = setTimeout(() => api.diskPut("geo", "v1", geo), 500);
}
const shopCount = (x) => Object.keys(x?.shops ?? {}).length;

class ShopsView {
  constructor(app) {
    this.app = app;
    this.list = new ListView();
    this.bar = new ChipBar();
    // Place filters survive restarts; Moscow region is the default
    const saved = store.pref("shops", null);
    const isId = (v) => Number.isInteger(v) && v >= 0;
    if (saved && ["region", "city", "subway", "feature"].every((k) => isId(saved.f?.[k]))) {
      this.f = { ...saved.f };
      this.names = Object.fromEntries(Object.entries(saved.names ?? {}).filter(([, v]) => typeof v === "string"));
    } else {
      this.f = { region: 3872, city: 0, subway: 0, feature: 0 };
      this.names = { region: "Москва и Московская обл" };
    }
    this.defs = [];
    this.zoom = false;
    this.search = new TextInput({ placeholder: "адрес, улица или метро", onChange: () => { this.list.sel = 0; this.list.top = 0; } });
    this.focus = "list";
    this.reset();
  }

  reset() { this.regionHint = null; this.items = []; this.page = 0; this.pages = null; this.total = null; this.hasMore = true; this.loading = false; this.error = null; this.all = false; this.autoLoads = 0; this.req = (this.req ?? 0) + 1; this.list.sel = 0; this.list.top = 0; }
  busy() { return this.loading; }
  onShow() { if (!this.page && !this.loading) geoReady.then(() => this.loadMore()); }

  // Shops matching the search; courier-only warehouses go last
  get visible() {
    const q = this.search.value.trim().toLowerCase();
    const v = q ? this.items.filter((s) => `${s.address} ${s.city?.name ?? ""} ${s.subway?.name ?? ""}`.toLowerCase().includes(q)) : this.items;
    return [...v].sort((a, b) => isCourier(a) - isCourier(b));
  }

  focusTop() { this.focus = "search"; }

  // Place filters as keyboard-walkable pills, and "all on the map" while pages remain
  chips() {
    const out = [["region", "r"], ["city", "g"], ["subway", "m"], ["feature", "f"]].map(([kind, key]) => {
      const val = this.f[kind] ? this.names[kind] : kind === "region" && this.regionHint ? this.regionHint : "любой";
      return { label: `${key} ${FILTER_NAMES[kind]}: ${val} ▾`, run: () => this.pick(kind), ...(this.f[kind] ? { fg: T.bg, bg: T.lime, bold: true } : {}) };
    });
    if (this.hasMore && this.items.length) out.push({ label: "L все на карту", run: () => this.loadAll() });
    return out;
  }

  // More pages as the selection nears the end, but at most 10 in a row without the user moving:
  // an address search that matches nothing must not walk every shop in the country
  tick() {
    if (!this.hasMore || this.loading || this.error || !this.page || this.all) return;
    if (this.list.sel !== this.autoSel) { this.autoSel = this.list.sel; this.autoLoads = 0; }
    if ((this.autoLoads ?? 0) >= 10 || this.list.sel < this.visible.length - 5) return;
    this.autoLoads = (this.autoLoads ?? 0) + 1;
    this.loadMore();
  }

  async loadMore(prio = "hi") {
    if (this.loading || !this.hasMore) return;
    this.loading = true;
    const req = this.req;
    try {
      const d = await api.shops({ page: this.page + 1, ...this.f }, { prio });
      if (req !== this.req) return;
      this.items.push(...(d.items ?? []));
      learn(d.items ?? []);
      this.page++;
      this.pages = d.meta?.pages;
      this.total = d.meta?.total;
      this.hasMore = !!d.meta?.has_more && !!d.items?.length;
      if (d.meta?.filters?.length) this.defs = d.meta.filters;
      // Every shop in the region has been seen, so its city list is complete
      if (!this.hasMore && this.f.region && !this.f.city && !this.f.subway && !this.f.feature) geo.done[this.f.region] = true;
      // No region is set, but all shops found are in one region, so show its name
      const regions = new Set((d.items ?? []).map((s) => s.region?.name).filter(Boolean));
      if (!this.f.region && regions.size === 1 && this.page === 1) this.regionHint = [...regions][0];
      // Only a few pages: put them all on the map right away
      if (this.page === 1 && this.pages && this.pages <= 6) this.all = true;
    } catch (e) {
      if (req === this.req) { this.error = e.message; this.hasMore = false; }
    } finally {
      if (req === this.req) this.loading = false;
      this.app.invalidate();
    }
    if (this.all && this.hasMore && req === this.req) {
      if (this.page < ALL_PAGES) this.loadMore("lo");
      else { this.all = false; this.app.toast("Магазинов слишком много для карты — выберите регион или город", T.orange); }
    }
  }

  loadAll() {
    if (!this.hasMore) return this.app.toast("Все магазины уже на карте");
    const left = (this.pages ?? 0) - this.page;
    // All of Russia is 220+ pages: not worth that many requests, a region or a city narrows it down
    if (this.pages > ALL_PAGES) return this.app.toast(`Это ${this.pages} страниц — выберите регион или город, и все магазины встанут на карту`, T.orange);
    if (left > 20) this.app.toast(`Гружу ${left} страниц в фоне, около ${Math.max(1, Math.round(left / 30))} мин — потом из кэша`, T.orange);
    this.all = true;
    if (!this.loading) this.loadMore("lo");
  }

  setFilter(kind, value, label) {
    this.f[kind] = value;
    this.names[kind] = value ? label : "";
    if (value) {
      // VkusVill reference lists cover the whole country: reset places that don't fit, keep those that do
      if (kind === "region") {
        if (this.f.city && geo.cities[this.f.city]?.r !== value) { this.f.city = 0; this.names.city = ""; }
        if (this.f.subway && geo.subways[this.f.subway]?.r !== value) { this.f.subway = 0; this.names.subway = ""; }
      }
      if (kind === "city") {
        if (this.f.region && geo.cities[value]?.r !== this.f.region) { this.f.region = 0; this.names.region = ""; }
        if (this.f.subway && geo.subways[this.f.subway]?.c !== value) { this.f.subway = 0; this.names.subway = ""; }
      }
      if (kind === "subway") {
        const sw = geo.subways[value];
        if (this.f.region && sw?.r !== this.f.region) { this.f.region = 0; this.names.region = ""; }
        if (this.f.city && sw?.c !== this.f.city) { this.f.city = 0; this.names.city = ""; }
      }
    }
    this.persist();
    this.reset();
    this.loadMore();
  }

  persist() { store.setPref("shops", { f: this.f, names: this.names }); }

  pick(kind) {
    const def = this.defs.find((d) => d.param === FILTER_KEYS[kind]);
    if (!def) return this.app.toast("Фильтры еще загружаются", T.dim);
    const regionName = (id) => this.defs.find((d) => d.param === "region")?.items.find((i) => i.id === id)?.name.replace(/ обл$| край$/, "");
    const plural3 = (n) => `${n} ${plural(n, "магазин", "магазина", "магазинов")}`;
    let options = def.items.map((i) => ({ label: i.name, value: i.id, checked: this.f[kind] === i.id }));
    let title = FILTER_NAMES[kind];
    const extra = [];
    if (kind === "city" || kind === "subway") {
      const map = kind === "city" ? geo.cities : geo.subways;
      const inScope = (id) => {
        const g = map[id];
        if (kind === "subway" && this.f.city) return g?.c === this.f.city;
        return this.f.region ? g?.r === this.f.region : true;
      };
      const scoped = this.f.region || (kind === "subway" && this.f.city);
      if (scoped) {
        options = options.filter((o) => inScope(o.value));
        title += ` · ${kind === "subway" && this.f.city ? this.names.city : this.names.region}`;
        if (!geo.done[this.f.region]) extra.push({ label: `⟳ найти остальные ${kind === "city" ? "города" : "станции"} региона`, value: "__all", hint: `${Math.max(0, (this.pages ?? 0) - this.page)} стр.`, color: T.lime });
        else if (!options.length) extra.push({ label: kind === "city" ? "в регионе нет других городов" : "в регионе нет метро", value: "__none", color: T.dim });
      }
      for (const o of options) {
        const n = shopCount(map[o.value]);
        o.hint = scoped ? (n ? plural3(n) : "") : regionName(map[o.value]?.r) ?? "";
        o.n = n;
      }
      if (scoped) options.sort((a, b) => b.n - a.n || a.label.localeCompare(b.label, "ru"));
    }
    this.app.overlay(new Menu({
      title, filter: options.length > 10,
      items: [{ label: "Любой", value: 0, checked: !this.f[kind] }, ...options, ...extra],
      onPick: (it) => {
        if (it.value === "__none") return;
        if (it.value === "__all") {
          // Walk all shops in the region so their cities and metro stations get into the lookup
          for (const k of ["city", "subway", "feature"]) { this.f[k] = 0; this.names[k] = ""; }
          this.persist();
          this.reset();
          this.all = true;
          this.loadMore("lo");
          this.app.toast("Собираю города региона — меню пополнится по ходу загрузки");
          return;
        }
        this.setFilter(kind, it.value, it.label);
      },
    }));
  }

  key(k) {
    if (this.focus === "search") {
      if (k.type === "paste") return this.search.key(k);
      if (k.name === "down" || k.name === "tab") { this.focus = "chips"; return true; }
      if (k.name === "enter" || k.name === "escape") { this.focus = "list"; if (k.name === "escape") this.search.set(""); return true; }
      return this.search.key(k);
    }
    if (k.type !== "key") return false;
    // Zones top to bottom: address search → place filters → list
    if (this.focus === "chips") {
      if (k.name === "up") { this.focus = "search"; return true; }
      if (k.name === "down" || k.name === "escape") { this.focus = "list"; return true; }
      if (this.bar.key(k, this.chips())) return true;
    }
    const vis = this.visible;
    if (k.name === "up" && this.list.sel <= 0) { this.focus = "chips"; return true; }
    if (this.list.key(k, vis.length)) return true;
    const h = k.hot ?? k.name;
    const s = vis[this.list.sel];
    if (h === "/" || k.ch === ".") { this.focus = "search"; return true; }
    if (k.name === "escape" && this.search.value) { this.search.set(""); return true; }
    if (h === "r") { this.pick("region"); return true; }
    if (h === "g") { this.pick("city"); return true; }
    if (h === "m") { this.pick("subway"); return true; }
    if (h === "f") { this.pick("feature"); return true; }
    if (h === "L") { this.loadAll(); return true; }
    if (h === "v") { this.mapOnly = !this.mapOnly; return true; }
    if (h === "z" || k.name === "enter") { this.zoom = !this.zoom; return true; }
    if (h === "o" && s) { openUrl(s.url); return true; }
    if (h === "y" && s) { copy(["ВкусВилл", s.city?.name, cleanAddress(s)].filter(Boolean).join(", ")).then(() => this.app.toast("Адрес скопирован")); return true; }
    if (h === "p" && s?.lat) { openUrl(`https://yandex.ru/maps/?pt=${s.lon},${s.lat}&z=17&l=map`); return true; }
    return false;
  }

  hints() {
    if (this.focus === "search") return [["↓", "к фильтрам"], ["⏎", "к списку"], ["esc", "сбросить поиск"]];
    if (this.focus === "chips") return [["← →", "выбор"], ["⏎", "выбрать"], ["↑", "к поиску"], ["↓", "к списку"]];
    return [["↑↓", "магазин"], ["/", "поиск"], ...(this.app.g.w < 100 ? [["v", "карта"]] : []), ["z", "приблизить"], ["r g m f", "регион·город·метро·особ."], ["L", "все на карту"], ["p", "Я.Карты"], ["o", "на сайте"], ["y", "адрес"]];
  }

  draw(g, r) {
    const app = this.app;
    g.fill(r.x, r.y, r.w, r.h, T.bg);
    const vis = this.visible;
    // Search box, like the catalog and recipes: a framed field with the "open now" count in its corner
    const searching = this.focus === "search" && !app.headerFocus;
    const open = vis.filter((s) => shopState(s)?.open).length;
    const shops = vis.filter((s) => !isCourier(s)).length;
    g.box(r.x, r.y, r.w, 3, {
      fg: searching ? T.lineHi : T.line, bg: T.panel, title: "Поиск магазина", titleFg: searching ? T.lime : T.dim,
      right: vis.length ? `● ${open} из ${shops} открыто` : "", rightFg: open ? T.lime : T.dim,
    });
    g.text(r.x + 2, r.y + 1, "⌕", { fg: T.lime, bold: true, bg: T.panel });
    this.search.draw(g, r.x + 4, r.y + 1, r.w - 8, { focused: searching, bg: T.panel, blink: app.frame % 10 < 7 || !searching });
    app.hit(r.x, r.y, r.w, 3, { click: () => { this.focus = "search"; } });
    // Place filters and the loading progress under the box
    const fy = r.y + 3;
    this.bar.draw(g, app, r.x + 1, fy, r.x + r.w - 30, this.chips(), { focused: this.focus === "chips" && !app.headerFocus });
    const progress = this.pages ? this.page / this.pages : 0;
    const pw = 16;
    const px = r.x + r.w - pw - 12;
    g.gradBar(px, fy, pw, progress, [T.greenD, T.lime]);
    g.text(px + pw + 1, fy, `${this.items.length}/${this.total ?? "…"}`, { fg: T.dim });
    app.hit(px, fy, pw + 10, 1, { click: () => this.loadAll() });

    const top = r.y + 5, H = r.h - 5;
    if (r.w < 100 && this.mapOnly) return this.drawMap(g, { x: r.x, y: top, w: r.w, h: H });
    const lw = r.w >= 100 ? Math.max(44, Math.floor(r.w * 0.42)) : r.w;
    g.fill(r.x, top, lw, H, T.panel);
    if (!vis.length) {
      const msg = this.loading ? "Ищу магазины…" : this.error ? `⚠ ${this.error}` : this.items.length ? `По «${this.search.value}» ничего` : "Магазинов не нашлось";
      g.textC(r.x, lw, top + Math.floor(H / 2) - 1, msg, { fg: this.error ? T.red : T.dim, bg: T.panel });
      const many = ["region", "city", "subway", "feature"].filter((k) => this.f[k]).length > 1;
      if (!this.loading && !this.error && many && !this.items.length) g.textC(r.x, lw, top + Math.floor(H / 2) + 1, "под все фильтры сразу ничего нет — ослабьте один из них", { fg: T.dim, bg: T.panel });
      else if (this.search.value && this.hasMore && !this.loading) g.textC(r.x, lw, top + Math.floor(H / 2) + 1, "L — загрузить все магазины и искать по ним", { fg: T.dim, bg: T.panel });
      if (this.loading) loader(g, r.x + Math.floor(lw / 2) - 6, top + Math.floor(H / 2) + 1, app.frame);
    } else {
      // Wide enough (no map beside the list): one line per shop, place and hours in columns
      const PLACE = 20, HOURS = 28, RATING = 7;
      const oneLine = lw - 6 - PLACE - HOURS - RATING >= 26;
      const rowH = oneLine ? 1 : 2;
      this.list.draw(g, app, r.x, top, lw - 1, H, vis, (s, _i, y, sel) => {
        const bg = sel ? (this.focus === "list" && !app.headerFocus ? T.selHi : T.sel) : T.panel;
        g.fill(r.x, y, lw - 1, rowH, bg);
        for (let j = 0; j < rowH; j++) if (sel) g.text(r.x, y + j, "▌", { fg: T.lime, bg });
        const st = shopState(s);
        const courier = st?.courier;
        g.text(r.x + 2, y, courier ? "◌" : st ? (st.open ? "●" : "○") : "·", { fg: courier ? T.mute : st?.open ? T.lime : T.red, bg });
        let ax = r.x + 4;
        if (courier) ax = g.text(ax, y, "склад ", { fg: T.violet, bg });
        const place = s.subway?.name ? `Ⓜ ${s.subway.name}` : s.city?.name ?? "";
        const hours = courier ? "только для курьеров" : st?.text ?? s.schedule ?? "";
        const hoursFg = courier ? T.mute : st && !st.open ? mix(T.red, T.dim, 0.5) : T.dim;
        const rating = s.rating && !courier ? `★ ${String(s.rating).replace(".", ",")}` : "";
        if (oneLine) {
          const rx = r.x + lw - 2 - PLACE - HOURS - RATING;
          g.textW(ax, y, cleanAddress(s), rx - ax - 1, { fg: courier ? T.dim : sel ? T.white : T.text, bold: sel && !courier, bg });
          g.textW(rx, y, place, PLACE - 1, { fg: T.dim, bg });
          g.textW(rx + PLACE, y, hours, HOURS - 1, { fg: hoursFg, bg });
          if (rating) g.textR(r.x + lw - 2, y, rating, { fg: T.yellow, bg });
          return;
        }
        g.textW(ax, y, cleanAddress(s), r.x + lw - 10 - ax, { fg: courier ? T.dim : sel ? T.white : T.text, bold: sel && !courier, bg });
        if (rating) g.textR(r.x + lw - 2, y, rating, { fg: T.yellow, bg });
        g.textW(r.x + 4, y + 1, [place, hours].filter(Boolean).join(" · "), lw - 6, { fg: hoursFg, bg });
      }, { rowH, onPick: () => { this.zoom = !this.zoom; } });
    }
    if (lw < r.w) this.drawMap(g, { x: r.x + lw + 1, y: top, w: r.w - lw - 1, h: H });
  }

  drawMap(g, r) {
    const app = this.app;
    const sel = this.visible[this.list.sel];
    const detailH = sel ? 9 : 0;
    const mh = r.h - detailH;
    g.fill(r.x, r.y, r.w, r.h, T.panel2);
    const pts = this.items.filter((s) => s.lat && s.lon);
    if (pts.length) {
      // Bounds from percentiles so outlying shops don't shrink the map; when zoomed, the area around the selected shop
      const lats = pts.map((s) => s.lat).sort((a, b) => a - b), lons = pts.map((s) => s.lon).sort((a, b) => a - b);
      const q = (arr, t) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(t * (arr.length - 1))))];
      let lat0 = q(lats, 0.02), lat1 = q(lats, 0.98), lon0 = q(lons, 0.02), lon1 = q(lons, 0.98);
      // In Moscow and the region, default to a frame around the MKAD
      const inMoscow = (s) => Math.abs(s.lat - CENTER[0]) < 0.25 && Math.abs(s.lon - CENTER[1]) < 0.45;
      const moscow = pts.filter(inMoscow).length >= pts.length / 2;
      if (moscow && !this.f.subway) ({ lat0, lat1, lon0, lon1 } = MOSCOW_BOX);
      if (this.zoom && sel?.lat) { const d = 0.03; lat0 = sel.lat - d; lat1 = sel.lat + d; lon0 = sel.lon - d * 1.8; lon1 = sel.lon + d * 1.8; }
      if (lat1 - lat0 < 0.01) { lat0 -= 0.02; lat1 += 0.02; }
      if (lon1 - lon0 < 0.01) { lon0 -= 0.03; lon1 += 0.03; }
      const k = Math.cos(((lat0 + lat1) / 2) * Math.PI / 180);
      const b = new Braille(r.w - 2, mh - 2);
      const spanX = (lon1 - lon0) * k, spanY = lat1 - lat0;
      const scale = Math.min((b.pw - 4) / spanX, (b.ph - 4) / spanY);
      const ox = (b.pw - spanX * scale) / 2, oy = (b.ph - spanY * scale) / 2;
      const proj = (s) => [ox + (s.lon - lon0) * k * scale, oy + (lat1 - s.lat) * scale];
      if (moscow) {
        // Backdrop: dotted MKAD, Garden Ring, Kremlin
        const ring = MKAD.map(([lat, lon]) => proj({ lat, lon }));
        for (let i = 1; i < ring.length; i++) b.line(ring[i - 1][0], ring[i - 1][1], ring[i][0], ring[i][1], T.line, 0);
        for (let a = 0; a < 64; a++) { const t = (a / 64) * Math.PI * 2; const [px, py] = proj({ lat: CENTER[0] + Math.sin(t) * 0.022, lon: CENTER[1] + Math.cos(t) * 0.038 }); b.set(px, py, T.line, 0); }
        const [kx, ky] = proj({ lat: CENTER[0], lon: CENTER[1] });
        b.set(kx, ky, T.red, 2); b.set(kx + 1, ky, T.red, 2);
      }
      for (const s of pts) {
        const [px, py] = proj(s);
        const st = shopState(s);
        const col = st?.courier ? T.mute : st && !st.open ? mix(T.red, T.panel2, 0.4) : T.green;
        b.set(px, py, col, 1); b.set(px + 1, py, col, 1); b.set(px, py + 1, col, 1); b.set(px + 1, py + 1, col, 1);
      }
      if (sel?.lat) {
        const [sx, sy] = proj(sel);
        // Crosshairs
        for (let i = 0; i < b.pw; i += 3) b.set(i, sy, T.mute, 0);
        for (let j = 0; j < b.ph; j += 3) b.set(sx, j, T.mute, 0);
        for (let a = 0; a < 24; a++) { const t = (a / 24) * Math.PI * 2; b.set(sx + Math.cos(t) * 4, sy + Math.sin(t) * 4, T.lime, 3); }
        b.set(sx, sy, T.white, 4); b.set(sx + 1, sy, T.white, 4); b.set(sx, sy + 1, T.white, 4); b.set(sx + 1, sy + 1, T.white, 4);
      }
      b.draw(g, r.x + 1, r.y + 1);
      // Scale bar
      const kmPerDot = 111 / scale;
      const nice = [0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500].find((v) => v / kmPerDot >= 10) ?? 500;
      const cells = Math.max(2, Math.round(nice / kmPerDot / 2));
      g.text(r.x + 2, r.y + mh - 1, "├" + "─".repeat(cells) + "┤", { fg: T.dim, bg: T.panel2 });
      g.text(r.x + 4 + cells, r.y + mh - 1, `${String(nice).replace(".", ",")} км`, { fg: T.dim, bg: T.panel2 });
      g.textR(r.x + r.w - 2, r.y + mh - 1, this.zoom ? "z — вся карта" : "z — приблизить", { fg: T.dim, bg: T.panel2 });
      g.text(r.x + 2, r.y, ` КАРТА · ${pts.length} ${plural(pts.length, "магазин", "магазина", "магазинов")} `, { fg: T.lime, bold: true, bg: T.panel2 });
      if (this.hasMore) g.textR(r.x + r.w - 2, r.y, " L — загрузить все ", { fg: T.dim, bg: T.panel2 });
      app.hit(r.x, r.y, r.w, mh, { click: () => { this.zoom = !this.zoom; } });
    }
    if (!sel) return;
    const y = r.y + mh;
    g.hline(r.x, y, r.w, T.line);
    const x = r.x + 2, w = r.w - 4;
    const st = shopState(sel);
    g.textW(x, y + 1, `${sel.city?.name ?? ""}, ${cleanAddress(sel)}`, w, { fg: T.white, bold: true, bg: T.panel2 });
    g.textW(x, y + 2, [sel.subway?.name && `Ⓜ ${sel.subway.name}`, sel.schedule].filter(Boolean).join(" · "), w, { fg: T.sub, bg: T.panel2 });
    if (st) g.pill(x, y + 3, st.text, { fg: T.bg, bg: st.courier ? T.violet : st.open ? T.lime : T.red, bold: true });
    if (sel.phone?.length) g.text(x + (st ? strWidth(st.text) + 3 : 0), y + 3, `☏ ${sel.phone.join(", ")}`, { fg: T.sub, bg: T.panel2 });
    let cx = x, cy = y + 5;
    for (const f of sel.features ?? []) {
      const wd = strWidth(f.name) + 2;
      if (cx + wd > x + w) { cx = x; cy++; }
      if (cy >= r.y + r.h) break;
      g.pill(cx, cy, f.name.toLowerCase(), { fg: T.mint, bg: mix(T.mint, T.panel2, 0.85) });
      cx += wd + 1;
    }
  }
}
