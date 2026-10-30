// Plain-output commands: tables, colored when stdout is a terminal, and --json for scripts.

import { qrMatrix } from "./ui/draw.js";
import * as api from "./api.js";
import { normalize, rub, compactNum, qtyText, lineTotal, plural } from "./product.js";
import { store, CART_MAX, QTY_MAX } from "./store.js";
import { padEnd, padStart } from "./term/width.js";
import { openState } from "./views/shops.js";
import * as auth from "./auth.js";
import { openUrl } from "./sys.js";
import { createInterface } from "node:readline";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const green = c("38;5;77"), lime = c("38;5;155"), dim = c("2"), bold = c("1"), orange = c("38;5;215"), yellow = c("38;5;221"), red = c("38;5;203");
const width = () => Math.min(process.stdout.columns || 100, 120);

const out = (s = "") => process.stdout.write(s + "\n");

// Stock at the signed-in user's address, when the answer carries it
const stockText = (p) => (p.available == null ? null : p.available <= 0 ? "нет" : p.unit === "кг" ? `${+Number(p.available).toFixed(1)} кг` : `${p.available} шт`);

function productTable(items) {
  const w = width();
  const ps = items.map(normalize);
  const withStock = ps.some((p) => p.available != null);
  const nameW = Math.max(20, w - 40 - (withStock ? 8 : 0));
  for (const p of ps) {
    const price = p.old ? orange(padStart(rub(p.price), 9)) : bold(padStart(rub(p.price), 9));
    const off = p.off ? orange(padStart(`−${p.off}%`, 5)) : "     ";
    const rating = p.rating ? yellow("★") + padEnd(p.rating.toFixed(1).replace(".", ","), 4) : "     ";
    const st = stockText(p);
    const stock = withStock ? " " + (p.available > 0 ? green : red)(padStart(st ?? "", 7)) : "";
    out(`${dim(padStart(String(p.id), 7))}  ${padEnd(p.name, nameW)} ${rating} ${off} ${price}${stock}`);
  }
}

export async function search(q, { json, sort, page = 1 }) {
  if (!q) throw new Error("Что искать? vv search творог");
  const d = await api.search(q, { page, sort: sort ?? "popularity" });
  if (json) return out(JSON.stringify(d, null, 2));
  out(`${green("◆")} ${bold(`«${q}»`)} ${dim(`· ${d.meta?.total ?? 0} ${plural(d.meta?.total ?? 0, "товар", "товара", "товаров")} · стр. ${d.meta?.page}/${d.meta?.pages}`)}`);
  productTable(d.items ?? []);
  if (d.meta?.has_more) out(dim(`  еще: vv search ${q} --page ${page + 1}`));
}

export async function deals({ json, type, personal }) {
  if (personal) {
    const d = await api.personalDiscounts();
    if (json) return out(JSON.stringify(d, null, 2));
    out(`${orange("%")} ${bold("6 скидок для меня")}`);
    return productTable(d.products ?? d.items ?? []);
  }
  const d = await api.discounts({ type });
  if (json) return out(JSON.stringify(d, null, 2));
  out(`${orange("%")} ${bold(type === "card" ? "Скидки по карте" : "Скидки от нескольких штук")} ${dim(`· ${d.meta?.total ?? 0}`)}`);
  productTable(d.items ?? []);
}

export async function orders({ json, page = 1 }) {
  const d = await api.orders(page);
  if (json) return out(JSON.stringify(d, null, 2));
  const list = d.orders ?? d.items ?? [];
  if (!list.length) return out(dim("Заказов за 30 дней нет"));
  for (const o of list) {
    const date = o.created_at ? new Date(o.created_at * (o.created_at < 1e12 ? 1000 : 1)).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) : "";
    const sum = typeof o.price === "object" ? o.price?.price : o.price;
    out(`${bold(`№ ${o.id_general ?? o.id}`)}  ${dim(`${date} · ${o.service ?? ""}`)}  ${o.status_name ?? ""}  ${lime(rub(sum))}`);
    out(dim(`  ${(o.products ?? []).map((p) => p.name).join(" · ")}`));
  }
}

function card(p) {
  out(bold(p.name));
  out(`${p.old ? orange(rub(p.price)) + " " + dim(`было ${rub(p.old)}`) : lime(rub(p.price))}${p.unit === "кг" ? dim(" за кг") : ""}  ${p.rating ? yellow("★ " + String(p.rating).replace(".", ",")) + dim(` · ${compactNum(p.votes)}`) : ""}`);
  if (p.offInfo) out(orange(p.offInfo));
  const st = stockText(p);
  if (st) out(p.available > 0 ? green(`● в наличии ${st}`) : red("○ нет в наличии"));
  if (p.kcal != null) out(`${dim("на 100 г")}  Б ${p.p ?? "—"} · Ж ${p.f ?? "—"} · У ${p.c ?? "—"} · ${lime(Math.round(p.kcal) + " ккал")}`);
  if (p.comp) out(`${dim("Состав:")} ${p.comp}`);
  out(dim(p.url));
}

export async function product(id, { json }) {
  if (!id) throw new Error("Нужен id товара: vv product 27695");
  const d = await api.details(id);
  if (json) return out(JSON.stringify(d, null, 2));
  card(normalize(d));
}

export async function barcode(code, { json }) {
  if (!/^\d{13}$/.test(code ?? "")) throw new Error("Нужен штрихкод EAN-13: 13 цифр");
  const d = await api.barcode(code);
  if (json) return out(JSON.stringify(d, null, 2));
  card(normalize(d));
}

export async function recipes(q, { json }) {
  const d = await api.recipes({ q });
  if (json) return out(JSON.stringify(d, null, 2));
  out(`${green("◆")} ${bold("Рецепты")} ${dim(`· ${d.meta?.total ?? 0}`)}`);
  for (const r of d.items ?? []) {
    out(`${bold(r.name)}  ${dim([r.cooking_time?.name, r.complexity?.name, r.portions && `${r.portions} порц.`].filter(Boolean).join(" · "))}`);
    out(dim(`  ${(r.ingredients ?? []).map((i) => i.name).join(", ")}`));
  }
}

export async function shops(q, { json }) {
  // Filter by a metro station or city name, looked up in the reference lists of the first page
  const first = await api.shops({ page: 1 });
  let f = {};
  if (q) {
    // Best match wins: exact name, then a name starting with the query, then one containing it;
    // on a tie a city beats a region and a metro station ("Волгоград" is the city, not the avenue)
    const norm = (s) => s.toLowerCase().replace(/ё/g, "е").replace(/^(г|п|пгт|с|д|рп)\.\s*/, "").replace(/\s+(обл|край|респ)\.?$/, "").trim();
    const ql = norm(q);
    const rank = { city: 0, region: 1, subway: 2 };
    let best = null;
    for (const def of first.meta?.filters ?? []) {
      if (!(def.param in rank)) continue;
      for (const item of def.items) {
        const n = norm(item.name);
        const score = n === ql ? 0 : n.startsWith(ql) ? 1 : n.includes(ql) ? 2 : -1;
        if (score < 0) continue;
        const key = score * 10 + rank[def.param];
        if (!best || key < best.key) best = { key, param: def.param, id: item.id };
      }
    }
    if (!best) throw new Error(`Не знаю метро или город «${q}»`);
    f = { [best.param]: best.id };
  }
  const d = Object.keys(f).length ? await api.shops({ page: 1, ...f }) : first;
  if (json) return out(JSON.stringify(d, null, 2));
  for (const s of d.items ?? []) {
    const st = openState(s.schedule);
    out(`${st ? (st.open ? lime("●") : red("○")) : " "} ${bold(s.address)}  ${dim([s.subway?.name && `м. ${s.subway.name}`, s.city?.name].filter(Boolean).join(" · "))}`);
    out(dim(`  ${st?.text ?? s.schedule ?? ""}${s.phone?.length ? " · " + s.phone.join(", ") : ""}`));
  }
  if (d.meta?.has_more) out(dim(`  …и еще ${d.meta.total - (d.items?.length ?? 0)}`));
}

// The same code as in the app: a module is two cells filled with background, so line spacing cannot break it;
// in a narrow terminal two modules per cell as ▄, which keeps scanning where ▀ does not (see G.qr).
export function printQR(text) {
  const { size, dark } = qrMatrix(text);
  const cols = process.stdout.columns ?? Infinity;
  const bg = (on) => `\x1b[48;5;${on ? 16 : 231}m`;
  if (size * 2 + 2 <= cols) {
    for (let y = 0; y < size; y++) {
      let line = "  ";
      for (let x = 0; x < size; x++) line += bg(dark(y, x)) + "  ";
      out(line + "\x1b[0m");
    }
    return;
  }
  if (size + 2 > cols) return out(dim(`  Окно мало для QR-кода: нужно ${size + 2} колонок, сейчас ${cols}`));
  for (let y = 0; y < size; y += 2) {
    let line = "  ";
    for (let x = 0; x < size; x++) {
      const top = dark(y, x), bot = dark(y + 1, x);
      line += top === bot ? bg(top) + " " : `\x1b[38;5;${bot ? 16 : 231}m${bg(top)}▄`;
    }
    out(line + "\x1b[0m");
  }
}

export async function cart(args, { json }) {
  const [sub, id, qty] = args;
  if (sub === "add") {
    if (!/^\d{1,9}$/.test(id ?? "")) throw new Error("vv cart add <id> [кол-во] — id товара числом");
    const p = normalize(await api.details(id));
    const q = qty === undefined ? (p.unit === "кг" ? 0.5 : 1) : Number(String(qty).replace(",", "."));
    if (!Number.isFinite(q) || q <= 0 || q > QTY_MAX) throw new Error(`Количество — число от 0,01 до ${QTY_MAX}`);
    if (!store.qty(p.id) && store.count >= CART_MAX) throw new Error(`В корзине уже ${CART_MAX} позиций — больше ВкусВилл не принимает`);
    store.add(p, q);
    store.saveNow();
    return out(`${lime("✚")} ${p.name} ${dim(`· в корзине ${qtyText(p, store.qty(p.id))}`)}`);
  }
  if (sub === "clear") { store.clearCart(); store.saveNow(); return out("Корзина очищена"); }
  if (sub === "link") {
    if (!store.cart.length) throw new Error("Корзина пуста");
    const d = await api.cartLink(store.cart.map((l) => ({ id: l.p.id, q: l.q })));
    if (json) return out(JSON.stringify(d, null, 2));
    out();
    if (process.stdout.isTTY) printQR(d.link);
    out();
    out(`  ${lime(d.link)}`);
    out(dim(`  ${store.count} ${plural(store.count, "позиция", "позиции", "позиций")} · ${rub(store.total)} · оплата и доставка — у ВкусВилла`));
    return;
  }
  if (json) return out(JSON.stringify(store.cart.map((l) => ({ id: l.p.id, name: l.p.name, q: l.q, price: l.p.price })), null, 2));
  if (!store.cart.length) return out(dim("Корзина пуста — npx vkusvill, чтобы набрать"));
  const nameW = Math.max(20, width() - 30);
  for (const l of store.cart) out(`${padEnd(l.p.name, nameW)} ${padStart(qtyText(l.p, l.q), 8)} ${bold(padStart(rub(lineTotal(l.p, l.q)), 10))}`);
  out(`${padEnd("Итого", nameW + 9)} ${lime(bold(padStart(rub(store.total), 10)))}`);
  out(dim("vv cart link — ссылка и QR-код"));
}


// ——— Sign-in ———

// Lines from the terminal or a pipe through one shared reader: several readline interfaces on one
// stdin lose buffered input, so a piped answer for the second question would vanish. A question asked
// after the input has ended gets null. `hidden` does not echo (for the client secret).
let reader = null;
const pending = [];
const buffered = [];
let ended = false;
let muted = false;

function lineReader() {
  if (reader) return reader;
  reader = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
  const write = reader._writeToOutput?.bind(reader);
  if (write) reader._writeToOutput = (text) => { if (!muted || text.includes("\n")) write(muted ? "\n" : text); };
  reader.on("line", (line) => { const next = pending.shift(); if (next) next(line); else buffered.push(line); });
  reader.on("close", () => { ended = true; while (pending.length) pending.shift()(null); });
  return reader;
}

function ask(question, { hidden = false, signal } = {}) {
  lineReader();
  process.stdout.write(question);
  return new Promise((resolve, reject) => {
    const done = (line) => {
      muted = false;
      if (line === null) return resolve(null);
      if (hidden && !process.stdin.isTTY) process.stdout.write("\n");
      resolve(line.trim());
    };
    if (buffered.length) return done(buffered.shift());
    if (ended) return done(null);
    muted = hidden;
    pending.push(done);
    signal?.addEventListener("abort", () => {
      const i = pending.indexOf(done);
      if (i >= 0) pending.splice(i, 1);
      muted = false;
      reject(new Error("aborted"));
    });
  });
}

const when = (t) => new Date(t).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

// The client secret is only ever read from the prompt (or piped stdin): a flag would show it in `ps` and shell history
export async function login({ clientId, redirect, scope, noBrowser }) {
  let clientSecret;
  const st = auth.status();
  if (st.viaEnv) throw new Error("Задан VV_TOKEN — он важнее входа. Уберите его, чтобы войти");
  if (clientId || !st.configured) {
    if (!clientId) {
      out(`Нужен персональный клиент ВкусВилла. Зарегистрируйте его: ${lime(auth.REGISTRATION_URL)}`);
      out(dim(`  Отметьте «У моего сервиса нет публичного URI» — ВкусВилл подставит ${auth.DEFAULT_REDIRECT}, его и ловит vv login.`));
      out(dim("  Данные клиента ВкусВилл пришлет на почту."));
      out();
      clientId = await ask("client_id: ");
      if (!clientId) throw new Error("Нужен client_id из письма ВкусВилла");
    }
    // VkusVill issues a secret with every personal client; ask unless this very client already has one
    const stored = auth.read();
    if (!clientSecret && !(stored?.clientId === clientId && stored?.clientSecret)) {
      for (let i = 0; i < 3 && !clientSecret; i++) clientSecret = await ask("client_secret (из того же письма, ввод не отображается): ", { hidden: true });
      if (!clientSecret) throw new Error("Без client_secret ВкусВилл не выдаст токен");
    }
    auth.setClient({ clientId, clientSecret: clientSecret || undefined, redirectUri: redirect });
  } else if (redirect) {
    auth.setClient({ clientId: st.clientId, redirectUri: redirect });
  }
  // `--scope all` forgets the rights trimmed at earlier sign-ins; a list asks for exactly those
  if (scope === "all") auth.setClient({ clientId: auth.read().clientId, scopes: null });
  const rec = auth.read();
  const loopback = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(rec.redirectUri);
  const rec2 = await auth.login({
    scope: scope && scope !== "all" ? scope : undefined,
    notice: (text) => out(orange(text)),
    open: (url) => {
      out(`Страница входа ВкусВилла: ${dim(url)}`);
      if (!noBrowser && openUrl(url)) out(dim("Открыл ее в браузере."));
      out(loopback ? dim("Жду подтверждения… Если браузер ушел на адрес, который не открылся, вставьте его сюда и нажмите Enter.")
        : "После входа скопируйте адрес из строки браузера и вставьте сюда:");
    },
    paste: (signal) => ask("> ", { signal }),
  });
  out(`${lime("✓")} Вход выполнен · до ${when(rec2.expiresAt)}${rec2.refreshToken ? dim(" · продлевается сам") : dim(" · без продления: через сутки vv login снова")}`);
  await printRights(rec2.scope);
  process.exit(0); // stdin listeners from the race must not keep the process alive
}

// Granted rights in the words of VkusVill's registration form, and what is missing
async function printRights(scope) {
  const granted = (scope ?? "").split(/\s+/).filter(Boolean);
  const all = (await auth.metadata()).scopes;
  for (const s of all) out(`  ${granted.includes(s) ? lime("✓") : dim("·")} ${granted.includes(s) ? auth.scopeLabel(s) : dim(`${auth.scopeLabel(s)} — не выдано`)}`);
  if (all.some((s) => !granted.includes(s))) out(dim("  Чтобы добавить: отметьте действие в настройках клиента на vkusvill.ru и vv login --scope all"));
}

export async function logout({ forget = false } = {}) {
  if (forget) {
    const had = auth.read();
    const r = await auth.forget();
    if (!had) return out(dim("Клиент и так не настроен"));
    return out(`${lime("✓")} Клиент, секрет и токены стерты${r && !r.revoked ? dim(" (ВкусВилл не подтвердил отзыв — доступ истечет сам)") : ""}`);
  }
  const r = await auth.logout();
  if (!r) return out(dim("Вход и так не выполнен"));
  out(r.revoked ? `${lime("✓")} Вышли: токены отозваны у ВкусВилла и удалены`
    : `${lime("✓")} Вышли: токены удалены с этого компьютера ${dim("(ВкусВилл не подтвердил отзыв — доступ истечет сам)")}`);
}

export async function authStatus({ json }) {
  const st = auth.status();
  if (json) return out(JSON.stringify(st, null, 2));
  if (st.viaEnv) return out("Вход: токен из VV_TOKEN");
  if (!st.configured) return out(`Вход не настроен — ${lime("vv login")}`);
  out(`Клиент: ${st.clientId}`);
  out(`Секреты: ${st.storage}`);
  if (st.secretsAt) out(dim(`  где: ${st.secretsAt}`));
  if (st.secretsAt !== st.metaAt) out(dim(`  остальное (id клиента, срок, права): ${st.metaAt}`));
  if (st.storageHint) out(dim(`  ${st.storageHint}`));
  if (!st.signedIn) return out(`Вход: истек — ${lime("vv login")}`);
  out(`Вход: до ${when(st.expiresAt)}${st.refreshable ? dim(" · продлевается сам") : ""}`);
  out("Права:");
  await printRights(st.scope);
}
