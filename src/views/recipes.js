// VkusVill recipes: search, filters (allergens, time, difficulty, cooking method), a preview card with a photo,
// and a recipe page with the steps and an ingredient checklist that goes into the cart with one key.

import { T, mix } from "../ui/theme.js";
import { TextInput, ListView, Menu, ChipBar } from "../ui/widgets.js";
import { image } from "../image.js";
import * as api from "../api.js";
import { normalize, qtyStep, plural, decode } from "../product.js";
import { store } from "../store.js";
import { productView } from "./product.js";
import { loader } from "./browser.js";
import { openUrl } from "../sys.js";
import { wrap, strWidth } from "../term/width.js";

const PARAMS = { exclude_allergens: "allergens", cooking_time: "time", complexity: "complexity", cooking_method: "method", feature: "feature", category: "category" };

// VkusVill lists cooking times out of order ("до 20 минут" last): sort them by duration.
// "до 1 часа" → 60, "1-2 часа" → 120, "более 2 часов" → just after 120; unparsed names keep their place
const minutes = (name = "") => {
  const n = Math.max(...(name.match(/\d+/g) ?? [NaN]).map(Number));
  return Number.isFinite(n) ? n * (/час/i.test(name) ? 60 : 1) + (/более|больше|свыше/i.test(name) ? 1 : 0) : Infinity;
};
const byDuration = (items) => [...items].sort((a, b) => minutes(a.name) - minutes(b.name));

const emptyFilters = () => ({ allergens: [], time: 0, complexity: 0, method: 0, feature: 0, category: 0 });

// Saved filters are validated: ids must be positive integers
function loadRecipeFilters() {
  const saved = store.pref("recipes", {});
  const f = emptyFilters();
  const isId = (v) => Number.isInteger(v) && v > 0;
  if (Array.isArray(saved.allergens)) f.allergens = saved.allergens.filter(isId).slice(0, 20);
  for (const k of ["time", "complexity", "method", "feature", "category"]) if (isId(saved[k])) f[k] = saved[k];
  return f;
}

export function recipesView(app) {
  return new RecipesView(app);
}

class RecipesView {
  constructor(app) {
    this.app = app;
    this.input = new TextInput({ placeholder: "блюдо или продукт: сырники, тыква, курица…" });
    this.input.onChange = (v) => { clearTimeout(this.timer); this.timer = setTimeout(() => this.setQuery(v), 350); };
    this.list = new ListView();
    this.bar = new ChipBar();
    this.q = "";
    this.f = loadRecipeFilters();
    this.filterDefs = [];
    this.focus = "list";
    this.reset();
  }

  reset() { this.items = []; this.page = 0; this.hasMore = true; this.total = null; this.loading = false; this.error = null; this.req = (this.req ?? 0) + 1; this.list.sel = 0; this.list.top = 0; }
  busy() { return this.loading; }
  onShow() { if (!this.page && !this.loading) this.loadMore(); }

  saveFilters() { store.setPref("recipes", this.f); }

  focusTop() { this.focus = "search"; }

  chips() {
    const act = this.activeFilters();
    return [
      { label: act.length ? "фильтры ▾" : "фильтры: аллергены, время, сложность…", prefix: "f ", run: () => this.filterMenu() },
      ...act.map((a) => ({
        label: `${a.label} ×`, fg: T.bg, bg: a.key === "allergens" ? T.orange : T.lime, bold: true,
        run: () => {
          if (a.key === "allergens") this.f.allergens = this.f.allergens.filter((i) => i !== a.id); else this.f[a.key] = 0;
          this.saveFilters(); this.reset(); this.loadMore();
        },
      })),
    ];
  }

  tick() {
    if (this.hasMore && !this.loading && !this.error && this.page && this.list.sel >= this.items.length - 4) this.loadMore();
  }

  setQuery(v) { v = v.trim(); if (v === this.q) return; this.q = v; this.reset(); this.loadMore(); }

  async loadMore() {
    if (this.loading || !this.hasMore) return;
    this.loading = true;
    const req = this.req;
    try {
      const d = await api.recipes({ q: this.q, page: this.page + 1, ...this.f });
      if (req !== this.req) return;
      this.items.push(...(d.items ?? []));
      this.page++;
      this.total = d.meta?.total;
      this.hasMore = !!d.meta?.has_more;
      if (d.meta?.filters?.length) this.filterDefs = d.meta.filters;
    } catch (e) {
      if (req === this.req) { this.error = e.message; this.hasMore = false; }
    } finally {
      if (req === this.req) this.loading = false;
      this.app.invalidate();
    }
  }

  filterMenu() {
    const items = [];
    for (const def of this.filterDefs) {
      const key = PARAMS[def.param];
      if (!key) continue;
      items.push({ label: def.name.toUpperCase(), section: true });
      for (const it of key === "time" ? byDuration(def.items) : def.items) {
        const checked = key === "allergens" ? this.f.allergens.includes(it.id) : this.f[key] === it.id;
        items.push({ label: (key === "allergens" ? "без: " : "") + it.name.toLowerCase(), value: { key, id: it.id }, checked });
      }
    }
    if (!items.length) return this.app.toast("Фильтры еще загружаются", T.dim);
    this.app.overlay(new Menu({
      title: "Фильтры рецептов", multi: true, items, filter: true,
      onPick: (it, all) => {
        if (!it.value) { it.checked = false; return; }
        const { key, id } = it.value;
        if (key === "allergens") {
          this.f.allergens = it.checked ? [...this.f.allergens, id] : this.f.allergens.filter((x) => x !== id);
        } else {
          // Single choice within a group
          for (const o of all) if (o.value?.key === key && o !== it) o.checked = false;
          this.f[key] = it.checked ? id : 0;
        }
        this.saveFilters();
        this.reset();
        this.loadMore();
      },
    }));
  }

  activeFilters() {
    const out = [];
    for (const def of this.filterDefs) {
      const key = PARAMS[def.param];
      for (const it of def.items) {
        if (key === "allergens" ? this.f.allergens.includes(it.id) : this.f[key] === it.id) out.push({ key, id: it.id, label: (key === "allergens" ? "без " : "") + it.name.toLowerCase() });
      }
    }
    return out;
  }

  open(r) { if (r) this.app.push(new RecipeView(this.app, r)); }

  key(k) {
    if (this.focus === "search") {
      if (k.type === "paste") return this.input.key(k);
      if (k.name === "down" || k.name === "tab") { this.focus = "chips"; return true; }
      if (k.name === "escape") { this.focus = "list"; return true; }
      if (k.name === "enter") { clearTimeout(this.timer); this.setQuery(this.input.value); this.focus = "list"; return true; }
      return this.input.key(k);
    }
    if (k.type !== "key") return false;
    // Zones top to bottom: search → filter chips → list
    if (this.focus === "chips") {
      if (k.name === "up") { this.focus = "search"; return true; }
      if (k.name === "down" || k.name === "escape") { this.focus = "list"; return true; }
      if (this.bar.key(k, this.chips())) return true;
    }
    const h = k.hot ?? k.name;
    if (k.name === "up" && this.list.sel === 0) { this.focus = "chips"; return true; }
    if (this.list.key(k, this.items.length)) return true;
    if (h === "/" || k.ch === ".") { this.focus = "search"; return true; }
    if (h === "f") { this.filterMenu(); return true; }
    if (k.name === "enter" || k.name === "right") { this.open(this.items[this.list.sel]); return true; }
    if (h === "o" && this.items[this.list.sel]) { openUrl(this.items[this.list.sel].url); return true; }
    if (k.name === "escape" && (this.q || this.activeFilters().length)) { this.input.set(""); this.q = ""; this.f = emptyFilters(); this.saveFilters(); this.reset(); this.loadMore(); return true; }
    return false;
  }

  hints() {
    if (this.focus === "search") return [["⏎", "искать"], ["↓", "к фильтрам"]];
    if (this.focus === "chips") return [["← →", "выбор"], ["⏎", "открыть или снять"], ["↑", "к поиску"], ["↓", "к списку"]];
    return [["↑↓", "выбор"], ["⏎", "рецепт"], ["/", "поиск"], ["f", "фильтры"], ["o", "на сайте"], ["esc", "сбросить"]];
  }

  draw(g, r) {
    const app = this.app;
    g.fill(r.x, r.y, r.w, r.h, T.bg);
    const focused = this.focus === "search" && !app.headerFocus;
    g.box(r.x, r.y, r.w, 3, { fg: focused ? T.lineHi : T.line, bg: T.panel, title: "Поиск рецептов", titleFg: focused ? T.lime : T.dim, right: `${this.total ?? "…"} ${plural(this.total ?? 0, "рецепт", "рецепта", "рецептов")}` });
    g.text(r.x + 2, r.y + 1, "⌕", { fg: T.lime, bold: true, bg: T.panel });
    this.input.draw(g, r.x + 4, r.y + 1, r.w - 8, { focused, bg: T.panel, blink: app.frame % 10 < 7 || !focused });
    app.hit(r.x, r.y, r.w, 3, { click: () => { this.focus = "search"; } });
    // The filters button and the active filters (Enter on one removes it)
    this.bar.draw(g, app, r.x + 1, r.y + 3, r.x + r.w - 2, this.chips(), { focused: this.focus === "chips" && !app.headerFocus });
    const top = r.y + 4;
    const H = r.h - 4;
    const paneW = r.w >= 96 ? Math.max(40, Math.min(60, Math.floor(r.w * 0.42))) : 0;
    const lw = r.w - paneW - (paneW ? 1 : 0);
    g.fill(r.x, top, lw, H, T.panel);
    if (!this.items.length) {
      g.textC(r.x, lw, top + Math.floor(H / 2) - 1, this.loading ? "Листаю кулинарную книгу…" : this.error ? `⚠ ${this.error}` : "Ничего не нашлось", { fg: this.error ? T.red : T.dim, bg: T.panel });
      if (this.loading) loader(g, r.x + Math.floor(lw / 2) - 6, top + Math.floor(H / 2) + 1, app.frame);
    } else {
      // Wide enough: one line per recipe with the details in aligned columns on the right;
      // otherwise the details go on a second line
      const COLS = [["time", 14], ["level", 11], ["portions", 11], ["kcal", 17]];
      const metaW = COLS.reduce((s, [, w]) => s + w, 0);
      const oneLine = lw - 6 - metaW >= 28;
      const rowH = oneLine ? 1 : 2;
      this.list.draw(g, app, r.x, top, lw - 1, H, this.items, (it, _i, y, sel) => {
        const bg = sel ? (this.focus === "list" ? T.selHi : T.sel) : T.panel;
        g.fill(r.x, y, lw - 1, rowH, bg);
        for (let j = 0; j < rowH; j++) if (sel) g.text(r.x, y + j, "▌", { fg: T.lime, bg });
        const meta = {
          time: it.cooking_time?.name && `◷ ${it.cooking_time.name}`,
          level: it.complexity?.name && `◆ ${it.complexity.name.toLowerCase()}`,
          portions: it.portions && `${it.portions} ${plural(it.portions, "порция", "порции", "порций")}`,
          kcal: it.nutritional?.calories && `${Math.round(it.nutritional.calories)} ккал/100 г`,
        };
        if (oneLine) {
          g.textW(r.x + 2, y, decode(it.name), lw - 6 - metaW, { fg: sel ? T.white : T.text, bold: sel, bg });
          let cx = r.x + lw - 2 - metaW;
          for (const [key, w] of COLS) { if (meta[key]) g.textW(cx, y, meta[key], w - 1, { fg: T.dim, bg }); cx += w; }
          return;
        }
        g.textW(r.x + 2, y, decode(it.name), lw - 6, { fg: sel ? T.white : T.text, bold: sel, bg });
        g.textW(r.x + 2, y + 1, Object.values(meta).filter(Boolean).join("   "), lw - 6, { fg: T.dim, bg });
      }, { rowH, onPick: (it) => this.open(it) });
    }
    if (paneW) this.drawPane(g, { x: r.x + lw + 1, y: top, w: paneW - 1, h: H }, this.items[this.list.sel]);
  }

  drawPane(g, r, it) {
    g.fill(r.x, r.y, r.w, r.h, T.panel);
    g.vline(r.x - 1, r.y, r.h, T.line);
    if (!it) return;
    const app = this.app;
    const ph = Math.min(Math.floor(r.h * 0.42), Math.round(r.w * 0.34));
    const img = image(it.image, r.w, ph, { mode: "cover", trim: false });
    if (img && !img.error) g.photo(r.x, r.y, img);
    else g.photoPlaceholder(r.x, r.y, r.w, ph, app.frame, "готовлю фото…");
    let y = r.y + ph + 1;
    const x = r.x + 1, w = r.w - 2;
    y += g.para(x, y, w, 2, decode(it.name), { fg: T.white, bold: true, bg: T.panel });
    let cx = x;
    for (const [label, col] of [[it.cooking_time?.name, T.lime], [it.complexity?.name?.toLowerCase(), T.yellow], [it.cooking_method?.name?.toLowerCase(), T.blue]]) {
      if (!label || cx + strWidth(label) + 2 > x + w) continue;
      g.pill(cx, y, label, { fg: col, bg: mix(col, T.panel, 0.82) });
      cx += strWidth(label) + 3;
    }
    y += 2;
    if (it.description) y += g.para(x, y, w, 4, decode(it.description).replace(/<[^>]+>/g, ""), { fg: T.sub, bg: T.panel }) + 1;
    if (it.allergens?.length && y < r.y + r.h - 2) {
      g.textW(x, y++, "Аллергены: " + it.allergens.map((a) => a.name.toLowerCase()).join(", "), w, { fg: T.orange, bg: T.panel });
      y++;
    }
    if (y < r.y + r.h - 1) g.text(x, y++, `ИНГРЕДИЕНТЫ · ${it.ingredients?.length ?? 0}`, { fg: T.dim, bold: true, bg: T.panel });
    for (const ing of it.ingredients ?? []) {
      if (y >= r.y + r.h) break;
      g.text(x, y, "·", { fg: T.green, bg: T.panel });
      g.textW(x + 2, y, ing.name, w - 16, { fg: T.text, bg: T.panel });
      g.textR(x + w, y++, ing.quantity ?? "", { fg: T.dim, bg: T.panel });
    }
  }
}

const SKIP = /^(соль|перец|вода|специи)|по вкусу/i;

class RecipeView {
  constructor(app, r) {
    this.app = app;
    this.r = r;
    this.ings = (r.ingredients ?? []).map((i) => ({ ...i, checked: !!i.ids?.length && !SKIP.test(i.name) && !SKIP.test(i.quantity ?? "") }));
    this.list = new ListView();
    this.scroll = 0;
    this.adding = null;
  }

  busy() { return !!this.adding; }

  async addChecked() {
    const todo = this.ings.filter((i) => i.checked && i.ids?.length);
    if (!todo.length) return this.app.toast("Отметьте ингредиенты пробелом", T.orange);
    this.adding = { done: 0, total: todo.length, ok: 0 };
    await Promise.all(todo.map(async (ing) => {
      try {
        const p = normalize(await api.details(ing.ids[0]));
        if (p?.id) { if (!store.qty(p.id)) store.add(p, qtyStep(p)); this.adding.ok++; ing.product = p; }
      } catch {}
      this.adding.done++;
      this.app.invalidate();
    }));
    const { ok, total } = this.adding;
    this.adding = null;
    this.app.toast(`В корзине ${ok} из ${total} ${plural(total, "ингредиента", "ингредиентов", "ингредиентов")}`, ok ? T.lime : T.orange);
  }

  async openIngredient(ing) {
    if (!ing?.ids?.length) return;
    try {
      const p = ing.product ?? normalize(await api.details(ing.ids[0]));
      this.app.push(productView(this.app, p));
    } catch (e) { this.app.toast(e.message, T.red); }
  }

  key(k) {
    if (k.type !== "key") return false;
    const h = k.hot ?? k.name;
    if (this.narrow && this.showSteps && k.name === "escape") { this.showSteps = false; return true; }
    if (this.narrow && this.showSteps && (k.name === "up" || k.name === "down")) {
      if (k.name === "up" && this.scroll <= 0) return false;
      this.scroll = Math.max(0, this.scroll + (k.name === "up" ? -1 : 1));
      return true;
    }
    // The "+ в корзину" button sits above the ingredients: ↑ from the first one reaches it
    if (this.focus === "button") {
      if (k.name === "down" || k.name === "escape") { this.focus = "list"; return true; }
      if (k.name === "enter" || k.name === "space") { this.addChecked(); return true; }
      if (k.name === "up") return false;
    } else if (k.name === "up" && this.list.sel <= 0) { this.focus = "button"; return true; }
    if (this.focus !== "button" && this.list.key(k, this.ings.length)) return true;
    const ing = this.ings[this.list.sel];
    if (k.name === "space" || h === "x") { if (ing) ing.checked = !ing.checked; return true; }
    if (h === "a") { const all = this.ings.every((i) => i.checked); this.ings.forEach((i) => { i.checked = !all && !!i.ids?.length; }); return true; }
    if (h === "+" || h === "=") { this.addChecked(); return true; }
    if (k.name === "enter" || k.name === "right") { this.openIngredient(ing); return true; }
    if (k.name === "pagedown") { this.scroll += 8; return true; }
    if (k.name === "pageup") { this.scroll = Math.max(0, this.scroll - 8); return true; }
    if (h === "o") { openUrl(this.r.url); return true; }
    if (h === "s" || k.name === "tab") { this.showSteps = !this.showSteps; return true; }
    return false;
  }

  hints() {
    if (this.focus === "button") return [["⏎", "положить отмеченное в корзину"], ["↓", "к ингредиентам"], ["esc", "к ингредиентам"]];
    return [["← esc", "назад"], ["␣", "отметить"], ["a", "все"], ["+", "в корзину"], ["⏎", "товар"], [this.narrow ? "s" : "PgDn", "шаги"], ["o", "на сайте"]];
  }

  draw(g, r) {
    const app = this.app;
    const it = this.r;
    g.fill(r.x, r.y, r.w, r.h, T.bg);
    const wide = r.w >= 100;
    this.narrow = !wide;
    if (!wide && this.showSteps) return this.drawSteps(g, r, r.x + 2, r.w - 5);
    const lw = wide ? Math.min(62, Math.floor(r.w * 0.42)) : r.w;
    // Left column: photo, meta, ingredients
    g.fill(r.x, r.y, lw, r.h, T.panel);
    const ph = Math.min(Math.floor(r.h * 0.34), Math.round(lw * 0.3));
    const img = image(it.image, lw, ph, { mode: "cover", trim: false });
    if (img && !img.error) g.photo(r.x, r.y, img); else g.photoPlaceholder(r.x, r.y, lw, ph, app.frame, "готовлю фото…");
    g.text(r.x + 1, r.y, " ← ", { fg: T.bg, bg: T.lime, bold: true });
    app.hit(r.x + 1, r.y, 3, 1, { click: () => app.pop() });
    let y = r.y + ph + 1;
    const x = r.x + 2, w = lw - 4;
    y += g.para(x, y, w, 2, decode(it.name), { fg: T.white, bold: true, bg: T.panel });
    const meta = [it.cooking_time?.name && `◷ ${it.cooking_time.name}`, it.complexity?.name && `◆ ${it.complexity.name.toLowerCase()}`, it.portions && `⊙ ${it.portions} ${plural(it.portions, "порция", "порции", "порций")}`].filter(Boolean).join("   ");
    g.textW(x, y++, meta, w, { fg: T.sub, bg: T.panel });
    const nu = it.nutritional;
    if (nu?.calories) {
      g.spans(x, y++, [["на 100 г  ", { fg: T.dim, bg: T.panel }], ["Б ", { fg: T.blue, bold: true, bg: T.panel }], [`${nu.proteins}  `, { bg: T.panel, fg: T.text }], ["Ж ", { fg: T.yellow, bold: true, bg: T.panel }], [`${nu.fats}  `, { bg: T.panel, fg: T.text }], ["У ", { fg: T.orange, bold: true, bg: T.panel }], [`${nu.carbs}  `, { bg: T.panel, fg: T.text }], [`${Math.round(nu.calories)} ккал`, { fg: T.lime, bold: true, bg: T.panel }]], w);
    }
    y++;
    const checked = this.ings.filter((i) => i.checked).length;
    g.text(x, y, `ИНГРЕДИЕНТЫ`, { fg: T.dim, bold: true, bg: T.panel });
    const btn = this.adding ? ` кладу ${this.adding.done}/${this.adding.total}… ` : ` + в корзину: ${checked} `;
    const onBtn = this.focus === "button" && !app.headerFocus;
    g.textR(x + w, y, btn, { fg: T.bg, bg: this.adding ? T.yellow : T.lime, bold: true, underline: onBtn });
    if (onBtn) g.textR(x + w - strWidth(btn) - 1, y, "▸", { fg: T.lime, bg: T.panel });
    app.hit(x + w - strWidth(btn), y, strWidth(btn), 1, { click: () => this.addChecked() });
    y += 1;
    this.list.draw(g, app, r.x, y, lw - 1, r.y + r.h - y, this.ings, (ing, _i, ry, sel) => {
      const bg = sel ? T.selHi : T.panel;
      g.fill(r.x, ry, lw - 1, 1, bg);
      const inCart = ing.product && store.qty(ing.product.id);
      g.text(x, ry, ing.checked ? "◼" : "◻", { fg: ing.checked ? T.lime : ing.ids?.length ? T.dim : T.mute, bg });
      g.textW(x + 2, ry, ing.name, w - 18, { fg: ing.ids?.length ? (sel ? T.white : T.text) : T.dim, bold: sel, bg });
      g.textR(x + w, ry, (inCart ? "✓ " : "") + (ing.quantity ?? ""), { fg: inCart ? T.lime : T.sub, bg });
      app.hit(x, ry, 2, 1, { click: () => { ing.checked = !ing.checked; } });
    }, { onPick: (ing) => this.openIngredient(ing) });
    if (!wide) return;
    this.drawSteps(g, r, r.x + lw + 2, r.w - lw - 5);
  }

  // Cooking steps: on the right on a wide screen, full screen on a narrow one
  drawSteps(g, r, sx, sw) {
    const app = this.app;
    const it = this.r;
    const lines = [];
    if (it.description) { wrap(decode(it.description).replace(/<[^>]+>/g, ""), sw).forEach((l) => lines.push([l, { fg: T.sub, italic: true }])); lines.push(null); }
    if (it.allergens?.length) { lines.push([`Аллергены: ${it.allergens.map((a) => a.name.toLowerCase()).join(", ")}`, { fg: T.orange }]); lines.push(null); }
    for (const st of it.steps ?? []) {
      const n = String(st.step_number);
      const tl = wrap(decode(st.text ?? "").replace(/<[^>]+>/g, ""), sw - 4);
      tl.forEach((l, i) => lines.push(i === 0 ? { n, l } : [`    ${l}`, { fg: T.text }]));
      lines.push(null);
    }
    const maxS = Math.max(0, lines.length - (r.h - 2));
    this.scroll = Math.min(this.scroll, maxS);
    g.text(sx, r.y, `ПРИГОТОВЛЕНИЕ · ${(it.steps ?? []).length} ${plural((it.steps ?? []).length, "шаг", "шага", "шагов")}`, { fg: T.lime, bold: true });
    for (let i = 0; i < r.h - 2; i++) {
      const ln = lines[this.scroll + i];
      if (!ln) continue;
      if (Array.isArray(ln)) g.text(sx, r.y + 2 + i, ln[0], ln[1]);
      else { g.text(sx, r.y + 2 + i, ln.n.padStart(2).padEnd(3), { fg: T.bg, bg: T.green, bold: true }); g.text(sx + 4, r.y + 2 + i, ln.l, { fg: T.white }); }
    }
    g.scrollbar(r.x + r.w - 1, r.y + 2, r.h - 2, this.scroll, r.h - 2, lines.length);
    app.hit(sx, r.y, sw + 2, r.h, { wheel: (d) => { this.scroll = Math.max(0, Math.min(maxS, this.scroll + d * 3)); } });
  }
}

