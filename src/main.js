// Entry point: parses arguments and starts either the full-screen interface or a plain-output command.

import { App } from "./app.js";
import { catalogView, dealsView } from "./views/catalog.js";
import { recipesView } from "./views/recipes.js";
import { shopsView } from "./views/shops.js";
import { cartView } from "./views/cart.js";
import { profileView } from "./views/profile.js";
import { Splash, Help, Palette, Barcode, CompareView, analogsView } from "./views/overlays.js";
import * as cli from "./cli.js";

import { VERSION } from "./version.js";

export { VERSION };

export const VIEWS = {
  catalog: catalogView,
  deals: dealsView,
  recipes: recipesView,
  shops: shopsView,
  cart: cartView,
  profile: profileView,
  palette: (app) => app.overlay(new Palette(app)),
  help: (app) => app.overlay(new Help()),
  barcode: (app) => app.overlay(new Barcode(app)),
  analogs: analogsView,
  compare: (app) => app.push(new CompareView(app)),
  searchCatalog: (app, q) => {
    app.stacks.catalog.length = 1;
    app.switchTab("catalog");
    app.stacks.catalog[0].search(q);
  },
  signIn: (app) => {
    app.stacks.profile.length = 1;
    app.switchTab("profile");
    app.page.openSignIn();
  },
  signOut: (app) => app.stacks.profile[0].signOut(),
  searchRecipes: (app, q) => {
    app.stacks.recipes.length = 1;
    app.switchTab("recipes");
    const v = app.stacks.recipes[0];
    v.input.set(q);
    v.setQuery(q);
    v.focus = "list";
  },
};

const HELP = `
  ВкусВилл в терминале · vkusvill ${"$VERSION"}

  npx vkusvill                полноэкранный интерфейс
  npx vkusvill <запрос>       открыть интерфейс сразу с поиском

  Команды с обычным выводом (для скриптов, --json — сырые данные):
    vv search <запрос>        поиск товаров   [--sort price_asc|price_desc|rating|new] [--page N]
    vv deals                  скидки по карте [--quantity — «от N штук»] [--personal — «6 скидок для меня»]
    vv product <id>           карточка товара
    vv barcode <EAN-13>       товар по штрихкоду
    vv recipes <запрос>       рецепты
    vv shops [метро|город]    магазины
    vv cart                   корзина из интерфейса
    vv cart add <id> [кол-во] положить товар в корзину
    vv cart link              ссылка на корзину ВкусВилла и QR-код
    vv cart clear             очистить корзину

  Вход (заказы, любимый продукт, 6 скидок, персональная выдача):
    vv login                  войти; client_id — из письма ВкусВилла после регистрации клиента
                              [--client-id ID] [--redirect URI] [--no-browser]; секрет — только на запрос или через stdin
                              [--scope all] — заново запросить все права (если отметили новые на сайте)
    vv auth                   статус входа и права
    vv orders                 заказы за 30 дней [--page N]
    vv logout                 выйти и отозвать токены [--forget — стереть и клиента с секретом]

  Флаги: --json  --no-splash  --version  --help
  Окружение: VV_TOKEN (готовый токен вместо входа), VV_COLOR=256|truecolor, NO_COLOR
`;

const VALUE_FLAGS = new Set(["--sort", "--page", "--client-id", "--redirect", "--scope"]);
const BOOL_FLAGS = new Set(["--json", "--quantity", "--personal", "--no-splash", "--version", "--help", "--no-browser", "--forget"]);
const SORTS = ["popularity", "rating", "price_asc", "price_desc", "new"];

// Splits argv into positional words, boolean flags and flag values (`--page 2` or `--page=2`)
function parseArgs(argv) {
  const args = [], flags = new Set(), values = {};
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === "-h") a = "--help";
    if (a === "-v") a = "--version";
    if (!a.startsWith("--")) { args.push(a); continue; }
    const [name, inline] = a.split(/=(.*)/s, 2);
    if (VALUE_FLAGS.has(name)) {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new Error(`Флагу ${name} нужно значение`);
      values[name.slice(2)] = v;
    } else if (BOOL_FLAGS.has(name)) flags.add(name);
    else throw new Error(`Неизвестный флаг ${name} — vv --help`);
  }
  return { args, flags, values };
}

export async function main(argv) {
  const { args, flags, values } = parseArgs(argv);
  if (flags.has("--version") || args[0] === "version") return console.log(VERSION);
  if (flags.has("--help") || args[0] === "help") return console.log(HELP.replace("$VERSION", VERSION));
  if (values.sort !== undefined && !SORTS.includes(values.sort)) throw new Error(`--sort: одно из ${SORTS.join(", ")}`);
  if (values.page !== undefined && !/^[1-9]\d{0,4}$/.test(values.page)) throw new Error("--page: номер страницы, 1 и больше");
  const json = flags.has("--json");
  const cmd = args[0];
  const commands = {
    search: () => cli.search(args.slice(1).join(" "), { json, sort: values.sort, page: +(values.page ?? 1) }),
    deals: () => cli.deals({ json, type: flags.has("--quantity") ? "quantity" : "card", personal: flags.has("--personal") }),
    orders: () => cli.orders({ json, page: +(values.page ?? 1) }),
    product: () => cli.product(args[1], { json }),
    barcode: () => cli.barcode(args[1], { json }),
    recipes: () => cli.recipes(args.slice(1).join(" "), { json }),
    shops: () => cli.shops(args.slice(1).join(" "), { json }),
    cart: () => cli.cart(args.slice(1), { json }),
    login: () => cli.login({ clientId: values["client-id"], redirect: values.redirect, scope: values.scope, noBrowser: flags.has("--no-browser") }),
    logout: () => cli.logout({ forget: flags.has("--forget") }),
    auth: () => cli.authStatus({ json }),
  };
  if (commands[cmd]) return commands[cmd]();
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    if (args.length) return cli.search(args.join(" "), { json });
    return console.log(HELP.replace("$VERSION", VERSION));
  }
  const app = new App({ views: VIEWS });
  app.start();
  if (args.length) VIEWS.searchCatalog(app, args.join(" "));
  if (!flags.has("--no-splash") && !args.length && !process.env.VV_NO_SPLASH) app.overlay(new Splash(app));
}
