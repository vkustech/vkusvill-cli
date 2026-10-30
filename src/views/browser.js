// Product list with a detail pane on the right: the shared base for catalog, deals, analogs and favourites.
// Loads pages as you scroll; filters and sorts what is already loaded in place.

import { T } from "../ui/theme.js";
import { ListView, Menu } from "../ui/widgets.js";
import { productRow, productPane, perKg } from "../ui/product-ui.js";
import { normalize, qtyText, qtyStep } from "../product.js";
import { store } from "../store.js";
import { productView } from "./product.js";
import { openUrl } from "../sys.js";

export const FILTERS = [
  { id: "noSugar", label: "Без сахара в составе", test: (p) => p.comp && !p.flags.sugar },
  { id: "noGluten", label: "Без глютена", test: (p) => p.comp && !p.flags.gluten },
  { id: "noLactose", label: "Без лактозы", test: (p) => p.comp && !p.flags.lactose },
  { id: "noAdd", label: "Без пищевых добавок", test: (p) => p.comp && !p.flags.additives },
  { id: "noPalm", label: "Без пальмового масла", test: (p) => !p.flags.palm },
  { id: "sale", label: "Только со скидкой", test: (p) => !!p.old },
  { id: "top", label: "Рейтинг 4,8 и выше", test: (p) => p.rating >= 4.8 },
  { id: "protein", label: "Белка 10 г и больше на 100 г", test: (p) => (p.p ?? 0) >= 10 },
  { id: "light", label: "До 150 ккал на 100 г", test: (p) => p.kcal != null && p.kcal <= 150 },
];

export const LOCAL_SORTS = [
  { id: "perkg", label: "Дешевле за кг", fn: (a, b) => (perKg(a) ?? a.price) - (perKg(b) ?? b.price) },
  { id: "protein", label: "Больше белка на рубль", fn: (a, b) => protPerRub(b) - protPerRub(a) },
  { id: "kcal", label: "Меньше калорий", fn: (a, b) => (a.kcal ?? 1e9) - (b.kcal ?? 1e9) },
  { id: "off", label: "Самая большая скидка", fn: (a, b) => (b.off ?? 0) - (a.off ?? 0) },
  { id: "votes", label: "Больше всего оценок", fn: (a, b) => b.votes - a.votes },
];
const protPerRub = (p) => (p.p && p.grams ? (p.p * p.grams) / 100 / p.price : p.p && p.unit === "кг" ? (p.p * 10) / p.price : 0);

export const SERVER_SORTS = [
  { id: "popularity", label: "Популярные" },
  { id: "rating", label: "С высоким рейтингом" },
  { id: "price_asc", label: "Сначала дешевые" },
  { id: "price_desc", label: "Сначала дорогие" },
  { id: "new", label: "Новинки" },
];

const AUTO_LOADS = 10;

export class ProductBrowser {
  constructor(app, { title, loader, headerH = 0, drawHeader, emptyText = "Ничего не нашлось", serverSort = true, keyHook, hintsExtra = [], autoLoad = true, prefKey = null } = {}) {
    this.app = app;
    this.title = title;
    this.loader = loader;
    this.headerH = headerH;
    this.drawHeaderFn = drawHeader;
    this.emptyText = emptyText;
    this.serverSort = serverSort;
    this.keyHook = keyHook;
    this.hintsExtra = hintsExtra;
    this.autoLoad = autoLoad;
    this.list = new ListView();
    this.prefKey = prefKey;
    // Sort and filters survive restarts for named browsers (catalog, deals)
    const saved = prefKey ? store.pref(`browser.${prefKey}`, {}) : {};
    this.filters = new Set((Array.isArray(saved.filters) ? saved.filters : []).filter((id) => FILTERS.some((f) => f.id === id)));
    this.sort = SERVER_SORTS.some((s) => s.id === saved.sort) ? saved.sort : "popularity";
    this.localSort = LOCAL_SORTS.some((s) => s.id === saved.localSort) ? saved.localSort : null;
    this.reset();
  }

  reset() {
    this.items = [];
    this.page = 0;
    this.total = null;
    this.hasMore = true;
    this.loading = false;
    this.error = null;
    this.req = (this.req ?? 0) + 1;
    this.autoLoads = 0;
    this.list.sel = 0;
    this.list.top = 0;
    this.loaded = false;
  }

  busy() { return this.loading; }

  reload() { this.reset(); this.loadMore(); }

  onShow() { if (!this.loaded && !this.loading) this.loadMore(); }

  async loadMore() {
    if (this.loading || !this.hasMore) return;
    this.loading = true;
    this.error = null;
    const req = this.req;
    try {
      const res = await this.loader(this.page + 1, { sort: this.sort });
      if (req !== this.req) return;
      const seen = new Set(this.items.map((p) => p.id));
      for (const it of res.items ?? []) { const p = normalize(it); if (!seen.has(p.id)) { this.items.push(p); seen.add(p.id); } }
      this.page++;
      this.total = res.total ?? this.items.length;
      // An empty page ends the list even if the server says there is more
      this.hasMore = !!res.hasMore && !!res.items?.length;
      this.facets = res.facets ?? this.facets;
      this.loaded = true;
    } catch (e) {
      if (req !== this.req) return;
      this.error = e.message;
      this.hasMore = false;
    } finally {
      if (req === this.req) this.loading = false;
      this.app.invalidate();
    }
  }

  get visible() {
    let v = this.items;
    if (this.filters.size) v = v.filter((p) => [...this.filters].every((id) => FILTERS.find((f) => f.id === id).test(p)));
    if (this.localSort) { const s = LOCAL_SORTS.find((x) => x.id === this.localSort); v = [...v].sort(s.fn); }
    return v;
  }

  // Load more when the selection nears the end of the list or filters left too few items. At most
  // AUTO_LOADS pages in a row without the user moving: a filter that matches nothing must not walk
  // the whole catalog
  tick() {
    if (!this.autoLoad || !this.hasMore || this.loading || this.error || !this.items.length) return;
    if (this.list.sel !== this.autoSel) { this.autoSel = this.list.sel; this.autoLoads = 0; }
    if (this.autoLoads >= AUTO_LOADS) return;
    const n = this.visible.length;
    if (this.list.sel >= n - 6 || n < this.list.height) { this.autoLoads++; this.loadMore(); }
  }

  get current() { return this.visible[this.list.sel]; }

  open(p) {
    if (!p) return;
    store.viewed(p);
    this.app.push(productView(this.app, p, { list: this.visible, index: this.visible.indexOf(p) }));
  }

  persist() {
    if (this.prefKey) store.setPref(`browser.${this.prefKey}`, { sort: this.sort, localSort: this.localSort, filters: [...this.filters] });
  }

  sortMenu() {
    const items = [];
    if (this.serverSort) {
      items.push({ label: "ВКУСВИЛЛ СОРТИРУЕТ", section: true });
      for (const s of SERVER_SORTS) items.push({ label: s.label, value: { server: s.id }, checked: !this.localSort && this.sort === s.id });
      items.push({ label: "ПО ЗАГРУЖЕННЫМ ТОВАРАМ", section: true });
    }
    for (const s of LOCAL_SORTS) items.push({ label: s.label, value: { local: s.id }, checked: this.localSort === s.id });
    if (!this.serverSort) items.unshift({ label: "Как у ВкусВилла", value: { local: null }, checked: !this.localSort });
    this.app.overlay(new Menu({
      title: "Сортировка", items,
      onPick: (it) => {
        if (!it.value) return;
        if (it.value.server) { this.localSort = null; if (this.sort !== it.value.server) { this.sort = it.value.server; this.reload(); } }
        else { this.localSort = it.value.local; this.list.sel = 0; }
        this.persist();
      },
    }));
  }

  filterMenu() {
    this.app.overlay(new Menu({
      title: "Фильтры по составу и цене", multi: true,
      items: FILTERS.map((f) => ({ label: f.label, value: f.id, checked: this.filters.has(f.id) })),
      onPick: (it) => { if (it.checked) this.filters.add(it.value); else this.filters.delete(it.value); this.list.sel = 0; this.autoLoads = 0; this.persist(); },
    }));
  }

  sortLabel() {
    if (this.localSort) return LOCAL_SORTS.find((s) => s.id === this.localSort).label.toLowerCase();
    return SERVER_SORTS.find((s) => s.id === this.sort)?.label.toLowerCase() ?? "";
  }

  addToCart(p, sign = 1) {
    if (!p) return;
    const before = store.qty(p.id);
    store.add(p, sign * qtyStep(p));
    const q = store.qty(p.id);
    if (sign > 0) this.app.toast(before ? `В корзине ${qtyText(p, q)} · ${p.title}` : `✚ ${p.title}`);
    else this.app.toast(q ? `В корзине ${qtyText(p, q)}` : `Убрано: ${p.title}`, T.orange);
  }

  key(k) {
    if (this.keyHook?.(k)) return true;
    if (k.type !== "key") return false;
    const vis = this.visible;
    if (this.list.key(k, vis.length)) return true;
    const p = vis[this.list.sel];
    const h = k.hot ?? k.name;
    if (k.name === "enter" || k.name === "right") { this.open(p); return true; }
    if (h === "+" || h === "=") { this.addToCart(p, 1); return true; }
    if (h === "-" || h === "_") { this.addToCart(p, -1); return true; }
    if (h === "*" || h === "l") { if (p) this.app.toast(store.toggleFav(p) ? `♥ В избранном: ${p.title}` : "Убрано из избранного", T.pink); return true; }
    if (h === "s") { this.sortMenu(); return true; }
    if (h === "f") { this.filterMenu(); return true; }
    if (h === "o" && p) { openUrl(p.url); this.app.toast("Открываю на сайте ВкусВилла"); return true; }
    if (h === "x" && p) { this.app.toggleCompare(p); return true; }
    if (h === "X") { this.app.openCompare(); return true; }
    if (h === "R") { this.reload(); return true; }
    return false;
  }

  hints() {
    if (this.error && !this.items.length) return [["R", "попробовать снова"], ...this.hintsExtra];
    return [["↑↓", "выбор"], ["⏎", "товар"], ["+ −", "корзина"], ...this.hintsExtra, ["s", "сорт"], ["f", "фильтры"], ["*", "избранное"], ["x", "сравнить"]];
  }

  draw(g, r) {
    const app = this.app;
    g.fill(r.x, r.y, r.w, r.h, T.bg);
    let y = r.y;
    if (this.drawHeaderFn) { this.drawHeaderFn(g, { x: r.x, y, w: r.w, h: this.headerH }); y += this.headerH; }
    const h = r.y + r.h - y;
    const showPane = r.w >= 96;
    const paneW = showPane ? Math.max(38, Math.min(58, Math.floor(r.w * 0.38))) : 0;
    const listW = r.w - paneW - (showPane ? 1 : 0);
    const vis = this.visible;
    // List header row
    const lx = r.x + 1, lw = listW - 2;
    g.fill(r.x, y, listW, h, T.panel);
    const count = this.total != null ? `${vis.length}${this.filters.size ? ` из ${this.items.length}` : ""}${this.total > this.items.length ? ` · всего ${this.total}` : ""}` : "";
    g.spans(lx + 1, y, [[this.title ?? "", { fg: T.lime, bold: true, bg: T.panel }], [count ? `  ${count}` : "", { fg: T.dim, bg: T.panel }]], lw - 30);
    const meta = `↕ ${this.sortLabel()}${this.filters.size ? `  ⚑ ${this.filters.size}` : ""}`;
    g.textR(lx + lw, y, meta, { fg: this.filters.size || this.localSort ? T.yellow : T.dim, bg: T.panel });
    app.hit(lx + lw - meta.length, y, meta.length, 1, { click: () => this.sortMenu() });
    g.hline(r.x, y + 1, listW, T.line);
    const ly = y + 2, lh = h - 2;
    if (!vis.length) {
      const msg = this.loading ? "Загружаю…" : this.error ? `⚠ ${this.error}` : this.items.length ? "Все загруженные товары отсеяны фильтрами" : this.emptyText;
      g.textC(r.x, listW, ly + Math.floor(lh / 2) - 1, msg, { fg: this.error ? T.red : T.dim, bg: T.panel });
      if (this.error) g.textC(r.x, listW, ly + Math.floor(lh / 2) + 1, "R — попробовать снова", { fg: T.dim, bg: T.panel });
      else if (this.loading) loader(g, r.x + Math.floor(listW / 2) - 6, ly + Math.floor(lh / 2) + 1, app.frame);
    } else {
      this.list.draw(g, app, lx - 1, ly, listW - 1, lh, vis, (p, _i, ry, sel) => {
        productRow(g, p, lx - 1, ry, listW - 1, { selected: sel, focused: !["search", "chips"].includes(this.focus) && !app.headerFocus, mark: app.compare.has(p.id) ? "⇄" : "" });
      }, { onPick: (p) => this.open(p) });
      if (this.loading) g.textC(r.x, listW, r.y + r.h - 1, ` ${"⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[app.frame % 10]} подгружаю… `, { fg: T.lime, bg: T.panel });
    }
    if (showPane) {
      const px = r.x + listW + 1;
      g.vline(r.x + listW, y, h, T.line, "│");
      productPane(g, app, vis[this.list.sel], px, y, paneW - 1, h);
      app.hit(px, y, paneW, h, { click: (ev) => { if (ev.double) this.open(vis[this.list.sel]); } });
    }
  }
}

// Running "caterpillar" loading indicator
export function loader(g, x, y, frame) {
  const n = 12;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(((frame % (n * 2)) - n) - (i - n / 2));
    g.text(x + i, y, "▬", { fg: d < 1.5 ? T.lime : d < 3 ? T.green : T.mute });
  }
}

