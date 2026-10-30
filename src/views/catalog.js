// Catalog: live VkusVill search, categories taken from the response, suggestions; an empty query shows today's discounted products.
// Deals: loyalty-card discounts and "buy N or more" discounts.

import { T } from "../ui/theme.js";
import { TextInput, Menu, ChipBar } from "../ui/widgets.js";
import { ProductBrowser } from "./browser.js";
import * as api from "../api.js";
import { store } from "../store.js";

const SUGGEST = ["творог", "сырники", "хумус", "гранола", "кефир", "авокадо", "куриное филе", "пельмени", "хлеб", "сыр", "ягоды", "кофе"];

const pageOf = (d) => ({ items: d.items ?? [], total: d.meta?.total, hasMore: !!d.meta?.has_more, facets: d.facets?.categories });

export function catalogView(app) {
  const st = { q: "", category: 0, timer: null };
  const input = new TextInput({ placeholder: "что ищем? творог, сырники, хумус…" });
  const b = new ProductBrowser(app, {
    prefKey: "catalog",
    title: "Сегодня со скидкой",
    headerH: 4,
    hintsExtra: [["/", "поиск"], ["g", "категории"]],
    loader: async (page, { sort }) => {
      if (!st.q) return pageOf(await api.discounts({ page, sort }));
      return pageOf(await api.search(st.q, { page, sort, category: st.category }));
    },
    drawHeader: (g, r) => drawSearch(g, r),
    // Zones top to bottom: search box → chips → list. ↑↓ move between them, ← → walk the chips
    keyHook: (k) => {
      if (b.focus === "search") {
        if (k.type === "paste") { input.key(k); return true; }
        if (k.name === "down" || k.name === "tab") { if (st.q) store.rememberQuery(st.q); b.focus = chips().length ? "chips" : "list"; return true; }
        if (k.name === "escape") { b.focus = "list"; return true; }
        if (k.name === "enter") { submit(); b.focus = "list"; return true; }
        if (k.name === "up") return false; // on to the header
        return input.key(k);
      }
      if (k.type !== "key") return false;
      if (b.focus === "chips") {
        if (k.name === "up") { b.focus = "search"; return true; }
        if (k.name === "down" || k.name === "escape") { b.focus = "list"; return true; }
        if (bar.key(k, chips())) return true;
      }
      const h = k.hot ?? k.name;
      if (h === "/" || k.ch === "." || (k.ctrl && k.name === "f")) { b.focus = "search"; return true; }
      if (h === "g") { categoryMenu(); return true; }
      if (k.name === "escape" && st.q) { input.set(""); setQuery(""); b.focus = "search"; return true; }
      if (k.name === "up" && b.list.sel === 0) { b.focus = chips().length ? "chips" : "search"; return true; }
      return false;
    },
  });
  b.focus = "search";
  b.focusTop = () => { b.focus = "search"; };
  const bar = new ChipBar();

  // Chips under the search box: categories of the results, or recent queries and suggestions
  function chips() {
    if (st.q && b.facets?.length) {
      return [
        { label: "все", prefix: "g ", run: () => setCategory(0), ...(st.category ? {} : { fg: T.bg, bg: T.lime, bold: true }) },
        ...b.facets.map((c) => ({ label: c.category_name.toLowerCase(), run: () => setCategory(c.category_id), ...(st.category === c.category_id ? { fg: T.bg, bg: T.lime, bold: true } : {}) })),
      ];
    }
    if (st.q) return [];
    const recent = store.queries.slice(0, 5);
    return [
      ...recent.map((q, i) => ({ label: q, prefix: i ? undefined : "недавно ", fg: T.mint, run: () => search(q) })),
      ...SUGGEST.filter((q) => !recent.includes(q)).map((q, i) => ({ label: q, prefix: i ? undefined : recent.length ? " попробуйте " : "попробуйте ", run: () => search(q) })),
    ];
  }

  input.onChange = (v) => {
    clearTimeout(st.timer);
    st.timer = setTimeout(() => setQuery(v), 320);
  };
  const submit = () => { clearTimeout(st.timer); setQuery(input.value); store.rememberQuery(input.value); };

  function setQuery(v) {
    v = v.trim();
    if (v === st.q) return;
    st.q = v;
    st.category = 0;
    b.facets = null;
    b.title = v ? `«${v}»` : "Сегодня со скидкой";
    b.reload();
    app.invalidate();
  }

  function search(v) { input.set(v); setQuery(v); store.rememberQuery(v); b.focus = "list"; }

  function setCategory(id) { st.category = id; b.reload(); }

  function categoryMenu() {
    if (!b.facets?.length) return app.toast("Категории появятся после поиска", T.dim);
    app.overlay(new Menu({
      title: "Категория",
      items: [{ label: "Все категории", value: 0, checked: !st.category }, ...b.facets.map((c) => ({ label: c.category_name + (c.subcategory_name ? ` · ${c.subcategory_name}` : ""), value: c.category_id, checked: st.category === c.category_id }))],
      onPick: (it) => setCategory(it.value),
    }));
  }

  function drawSearch(g, r) {
    const focused = b.focus === "search" && !app.headerFocus;
    g.fill(r.x, r.y, r.w, r.h, T.bg);
    g.box(r.x, r.y, r.w, 3, { fg: focused ? T.lineHi : T.line, bg: T.panel, title: "Поиск", titleFg: focused ? T.lime : T.dim, right: focused ? "⏎ искать · ↓ дальше" : "/ — искать", rightFg: T.dim });
    g.text(r.x + 2, r.y + 1, "⌕", { fg: T.lime, bold: true, bg: T.panel });
    input.draw(g, r.x + 4, r.y + 1, r.w - 8, { focused, bg: T.panel, blink: app.frame % 10 < 7 || !focused });
    app.hit(r.x, r.y, r.w, 3, { click: () => { b.focus = "search"; } });
    // Chips: categories of the results, or suggestions
    bar.draw(g, app, r.x + 1, r.y + 3, r.x + r.w - 1, chips(), { focused: b.focus === "chips" && !app.headerFocus });
  }

  const baseHints = b.hints.bind(b);
  b.hints = () => (b.focus === "search" ? [["⏎", "искать"], ["↓", "дальше"], ["^U", "очистить"], ["esc", "к списку"]]
    : b.focus === "chips" ? [["← →", "выбор"], ["⏎", "выбрать"], ["↑", "к поиску"], ["↓", "к списку"]]
    : baseHints());
  b.search = search;
  return b;
}

// Combo sets are not a discount type of the MCP server but regular catalog items. Search is fuzzy
// ("комбо" also finds soup sets and kombucha), so only real combos are kept: "Комбо-набор: …",
// "Комбо «Кофейная пара» …", "Набор: X + Y", a ready meal with a salad, or a combo shelf. Two queries
// find different ones. Café combos for pickup ("Комбо дня", "Комбо-обед") are not in the MCP catalog.
// Combos rank first: pages are fetched two at a time, in parallel (signed-in answers take about
// two seconds each), and a query stops at the first batch without a single combo.
// A ready meal "dish and salad" is a combo too ("Сосиски … с картофельным пюре и салат винегрет")
const isCombo = (it) => {
  const name = it.name ?? "", cats = it.category ?? [];
  if (/комбо/i.test(name) || /^\s*набор:/i.test(name) || cats.some((c) => /комбо/i.test(c.name ?? ""))) return true;
  return /\sи\sсалат(?![а-яё])/i.test(name) && cats.some((c) => /готовая еда/i.test(c.name ?? ""));
};
const BATCH = 2; // two queries × two pages fill the four request slots at once

async function combos({ sort, vvonly }) {
  const found = new Map();
  await Promise.all(["комбо", "комбо-набор"].map(async (q) => {
    for (let first = 1; first <= 15; first += BATCH) {
      const pages = await Promise.all(Array.from({ length: BATCH }, (_, i) => api.search(q, { page: first + i, sort, vvonly }).catch(() => null)));
      const hits = pages.flatMap((d) => (d?.items ?? []).filter(isCombo));
      hits.forEach((it) => found.set(it.id, it));
      if (!hits.length || pages.some((d) => !d?.meta?.has_more)) break;
    }
  }));
  const items = [...found.values()];
  return { items, total: items.length, hasMore: false };
}

const TITLES = { card: "Скидки по карте", quantity: "Скидки от нескольких штук", combo: "Комбо-наборы" };

export function dealsView(app) {
  const saved = store.pref("deals", {});
  const st = { type: ["quantity", "combo"].includes(saved.type) ? saved.type : "card", vvonly: saved.vvonly === 0 ? 0 : 1 };
  const persist = () => store.setPref("deals", { ...st });
  const b = new ProductBrowser(app, {
    prefKey: "deals",
    title: "Акции",
    headerH: 2,
    hintsExtra: [["t", "тип акции"]],
    loader: async (page, { sort }) => (st.type === "combo"
      ? combos({ sort, vvonly: st.vvonly })
      : pageOf(await api.discounts({ type: st.type, page, sort, vvonly: st.vvonly }))),
    drawHeader: (g, r) => {
      g.fill(r.x, r.y, r.w, r.h, T.bg);
      const x = g.text(r.x + 1, r.y, "%  ", { fg: T.orange, bold: true });
      bar.draw(g, app, x, r.y, r.x + r.w - 32, chips(), { focused: b.focus === "chips" && !app.headerFocus });
      g.textR(r.x + r.w - 1, r.y, "скидки обновляются каждый день", { fg: T.dim });
    },
    // Zones: the deal-type switches above the list. ↑ from the first row reaches them, ↑ again the header
    keyHook: (k) => {
      if (k.type !== "key") return false;
      const h = k.hot ?? k.name;
      if (b.focus === "chips") {
        if (k.name === "down" || k.name === "escape") { b.focus = "list"; return true; }
        if (k.name === "up") return false;
        if (bar.key(k, chips())) return true;
      } else if (k.name === "up" && b.list.sel === 0) { b.focus = "chips"; return true; }
      if (h === "t") { setType({ card: "quantity", quantity: "combo", combo: "card" }[st.type]); return true; }
      if (h === "v") { toggleBrand(); return true; }
      return false;
    },
  });
  const bar = new ChipBar();
  const on = { fg: T.bg, bg: T.orange, bold: true };
  const chips = () => [
    { label: "по карте лояльности", run: () => setType("card"), ...(st.type === "card" ? on : {}) },
    { label: "при покупке от N штук", run: () => setType("quantity"), ...(st.type === "quantity" ? on : {}) },
    { label: "комбо-наборы", run: () => setType("combo"), ...(st.type === "combo" ? on : {}) },
    { label: st.vvonly ? "только ВкусВилл" : "все бренды", prefix: "  ", run: () => toggleBrand() },
  ];
  b.focus = "list";
  b.focusTop = () => { b.focus = "chips"; };
  function toggleBrand() { st.vvonly = st.vvonly ? 0 : 1; persist(); b.reload(); }
  const baseHints = b.hints.bind(b);
  b.hints = () => (b.focus === "chips" ? [["← →", "выбор"], ["⏎", "выбрать"], ["↓", "к списку"]] : baseHints());
  function setType(t) { st.type = t; persist(); b.title = TITLES[t]; b.reload(); }
  b.title = TITLES[st.type];
  return b;
}

