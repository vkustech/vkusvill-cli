// Keyboard-only navigation: ↑ from the top of every page reaches the header, ← → walk the tabs,
// ↓ goes back into the page. Offline: the API endpoint points nowhere, pages stay empty.
// node test/keys-check.mjs

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "vv-keys-"));
process.env.VV_CONFIG_DIR = path.join(tmp, "config");
// Never touch the real credential store from tests
process.env.VV_SECRETS = "file";
process.env.VV_CACHE_DIR = path.join(tmp, "cache");
process.env.VV_ENDPOINT = "http://127.0.0.1:9/mcp";
delete process.env.VV_TOKEN;

const { App } = await import("../src/app.js");
const { VIEWS } = await import("../src/main.js");
const { productView } = await import("../src/views/product.js");
const { normalize } = await import("../src/product.js");

const app = new App({ views: VIEWS, headless: true, size: [120, 34] });
const press = (name, extra = {}) => { app.onEvent({ type: "key", name, ch: extra.ch ?? null, hot: extra.hot ?? extra.ch ?? null, ctrl: false, alt: false, shift: false, ...extra }); app.render(); };
const type = (text) => { for (const ch of text) press(ch, { ch }); };
const header = () => app.screen.snapshot().split("\n")[0];

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
};

app.page.onShow?.();
app.render();

await test("↑ from the catalog search box goes to the header", () => {
  assert.equal(app.page.focus, "search");
  press("up");
  assert.equal(app.headerFocus, true);
  assert.equal(app.headerItems()[app.headerSel], "catalog");
});
await test("← → switch tabs right away; the status line says how to get back", () => {
  press("right");
  assert.equal(app.tab, "deals");
  press("right");
  assert.equal(app.tab, "recipes");
  assert.ok(app.screen.snapshot().split("\n").at(-1).includes("в раздел"));
});
await test("digits and Tab switch tabs while staying in the header", () => {
  press("5", { ch: "5" });
  assert.equal(app.tab, "cart");
  assert.equal(app.headerFocus, true);
  press("tab");
  assert.equal(app.tab, "profile");
  press("3", { ch: "3" });
  assert.equal(app.tab, "recipes");
  assert.equal(app.headerFocus, true);
});
await test("↓ goes back into the page, straight into its search box", () => {
  press("down");
  assert.equal(app.headerFocus, false);
  assert.equal(app.page.focus, "search");
  type("тыква");
  assert.equal(app.page.input.value, "тыква");
});
await test("recipes: search → filters → list going down, and back up to the header", () => {
  press("down");
  assert.equal(app.page.focus, "chips");
  press("down");
  assert.equal(app.page.focus, "list");
  press("up");
  assert.equal(app.page.focus, "chips");
  press("up");
  assert.equal(app.page.focus, "search");
  press("up");
  assert.equal(app.headerFocus, true);
});
await test("shops: address search → place filters → list, ← → walk the filters", () => {
  press("4", { ch: "4" });
  press("down");
  assert.equal(app.page.focus, "search");
  press("down");
  assert.equal(app.page.focus, "chips");
  press("right"); press("right");
  assert.equal(app.page.bar.sel, 2);
  assert.match(app.page.hints().map((h) => h[1]).join(" "), /выбор/);
  press("down");
  assert.equal(app.page.focus, "list");
  press("up");
  assert.equal(app.page.focus, "chips");
  press("up"); press("up");
  assert.equal(app.headerFocus, true);
});
await test("catalog: suggestions under the search box are a row of their own", () => {
  press("1", { ch: "1" });
  press("down");
  assert.equal(app.page.focus, "search");
  press("down");
  assert.equal(app.page.focus, "chips");
  press("right");
  const label = app.screen.snapshot().split("\n")[4];
  assert.ok(label.includes("сырники"));
  press("enter");
  assert.equal(app.page.focus, "list", "a suggestion searches and moves to the results");
  assert.equal(app.stacks.catalog[0].title, "«сырники»");
  press("up");
  assert.equal(app.page.focus, "search", "no results offline: no chips, straight to the search box");
});
await test("deals: ↑ from the list reaches the deal-type switches, Enter picks one", () => {
  press("up");
  press("2", { ch: "2" });
  press("down");
  assert.equal(app.page.focus, "chips");
  press("right");
  press("enter");
  assert.equal(app.page.title, "Скидки от нескольких штук");
  press("down");
  assert.equal(app.page.focus, "list");
  press("up");
  assert.equal(app.page.focus, "chips");
  press("up");
  assert.equal(app.headerFocus, true);
});
await test("the sign-in button is the last header item and Enter presses it", () => {
  press("6", { ch: "6" });
  press("right");
  assert.equal(app.headerItems()[app.headerSel], "auth");
  assert.match(header(), /войти/);
  press("enter");
  assert.equal(app.tab, "profile");
  assert.equal(app.overlays.at(-1)?.title, "Данные клиента");
  press("escape");
  assert.equal(app.overlays.length, 0);
});
await test("cart: ↓ from the last line reaches the checkout button, p pays", async () => {
  const { store } = await import("../src/store.js");
  store.add({ id: 77, name: "Кефир 1%", price: 95, unit: "шт" }, 1);
  press("5", { ch: "5" });
  press("down");
  press("down");
  assert.equal(app.page.focus, "checkout");
  assert.match(app.page.hints()[0][1], /оформить/);
  press("up");
  assert.equal(app.page.focus, "list");
  press("p", { ch: "p" });
  assert.equal(app.overlays.at(-1)?.constructor.name, "Checkout", "p — pay");
  press("escape");
  press("з", { ch: "з", hot: "p" });
  assert.equal(app.overlays.at(-1)?.constructor.name, "Checkout", "the same key in the Russian layout");
  press("escape");
  store.clearCart();
  press("up");
});
await test("a recipe: ↑ from the first ingredient reaches the add-to-cart button", () => {
  press("3", { ch: "3" });
  press("down");
  app.page.open({ name: "Тест", ingredients: [{ name: "Молоко", quantity: "1 л", ids: ["1"] }, { name: "Соль", quantity: "по вкусу", ids: [] }], steps: [] });
  app.render();
  press("down");
  press("up"); press("up");
  assert.equal(app.page.focus, "button");
  assert.match(app.page.hints()[0][1], /в корзину/);
  press("down");
  assert.equal(app.page.focus, "list");
  app.pop();
  press("up");
});
await test("cart and profile lists hand ↑ to the header from their first row", () => {
  press("5", { ch: "5" });
  press("up");
  assert.equal(app.headerFocus, true);
  press("6", { ch: "6" });
  press("down");
  assert.equal(app.page.focus, "nav");
  press("up");
  assert.equal(app.headerFocus, true);
});
await test("a product page scrolls first, then hands ↑ to the header", () => {
  press("1", { ch: "1" });
  press("down");
  const p = normalize({ id: 1, name: "Творог 5%, 180 г", price: { current: 112 }, unit: "шт", description: "Творог для завтраков и выпечки. ".repeat(120) });
  app.push(productView(app, p));
  app.render();
  press("down"); press("down");
  assert.equal(app.page.scroll, 2);
  press("up"); press("up");
  assert.equal(app.headerFocus, false);
  press("up");
  assert.equal(app.headerFocus, true);
  press("escape");
  assert.equal(app.headerFocus, false);
});
await test("→ opens a recipe, ← comes back to the list", () => {
  press("3", { ch: "3" });
  press("down");
  app.page.open({ name: "Тест", ingredients: [{ name: "Молоко", quantity: "1 л", ids: ["1"] }], steps: [] });
  app.render();
  assert.equal(app.stacks.recipes.length, 2);
  press("left");
  assert.equal(app.stacks.recipes.length, 1);
});
await test("on a product page ← turns photos back first, then returns to the list", () => {
  press("1", { ch: "1" });
  app.stacks.catalog.length = 1;
  const p = normalize({ id: 2, name: "Сыр, 200 г", price: { current: 200 }, unit: "шт", images: [{ medium: "https://img.vkusvill.ru/a.webp" }, { medium: "https://img.vkusvill.ru/b.webp" }] });
  app.push(productView(app, p));
  press("right"); press("right");
  assert.equal(app.page.photo, 1, "no wrap past the last photo");
  press("left");
  assert.equal(app.page.photo, 0);
  assert.equal(app.stacks.catalog.length, 2);
  press("left");
  assert.equal(app.stacks.catalog.length, 1);
});
await test("a letter typed in the header leaves it and goes to the page", () => {
  app.pop();
  press("up");
  assert.equal(app.headerFocus, true);
  press("с", { ch: "с", hot: "c" });
  assert.equal(app.headerFocus, false);
});

console.log(`\n${passed} passed${process.exitCode ? ", some failed" : ""}`);
process.exit(process.exitCode ?? 0);
