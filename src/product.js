// MCP response item → a convenient model: price per 100 g, kcal and macros, composition flags, photos, properties.
// Flags are heuristics over the first manufacturer's ingredients; in JS \b doesn't see Cyrillic, hence the (?<![а-яё]) boundaries.

import { cleanDeep } from "./safe.js";

const W = "(?<![а-яё])";
export const RX = {
  sugar: /сахар(?!озаменит)|сироп|(?<![а-яё])мед(?![а-яё])|(?<![а-яё])мёд|фруктоз|глюкоз|декстроз|патока|сгущ|инверт/iu,
  noSugar: /без (доб\.?|добавленного )?сахара/iu,
  gluten: new RegExp(`пшени|глютен|ячмен|ржан|${W}рож|овсян|овёс|овес|солод|манн|булгур|кускус|полб|спельт|сухар|панир`, "iu"),
  glutenFree: /без глютена/iu,
  lactose: /молок|молоч|сливк|сливоч|творог|сыр(?!ь)|кефир|йогурт|сыворот|лактоз|казеин/iu,
  lactoseFree: /безлактоз|без лактозы|безмолочн|растительн/iu,
  additives: /(?<![a-zа-яё])[EЕ] ?-?\d{3}[a-z]?|загустител[ьи]|стабилизатор[ы]?|эмульгатор[ы]?|консервант[ы]?|ароматизатор[ы]?|краситель|регулятор[ы]? кислотности|модифицированн[а-я]+ крахмал|усилител[ья] вкуса/giu,
  palm: /пальмов/iu,
};

export const decode = (s = "") =>
  String(s).replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&laquo;/g, "«").replace(/&raquo;/g, "»")
    .replace(/&mdash;/g, "—").replace(/&ndash;/g, "–").replace(/&#0?39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/\u00a0/g, " ");

const stripTags = (s) => decode(String(s).replace(/<br\s*\/?>/gi, "\n").replace(/<[^<>]{0,500}>/g, " ")).replace(/[ \t]+/g, " ").trim();

// Server text is cut before any regex runs over it: a pathological value must not stall the interface
const TEXT_MAX = 8000;
const PUNCT = new Set([";", ".", " ", "\n", "\r", "\t", "\u00a0"]);
// Trims ; . and spaces at both ends without a backtracking regex
const trimPunct = (s) => {
  let a = 0, b = s.length;
  while (a < b && PUNCT.has(s[a])) a++;
  while (b > a && PUNCT.has(s[b - 1])) b--;
  return s.slice(a, b);
};

// «ООО "А": текст;<br>ООО "Б": текст» → the first manufacturer's text, without its name
function firstMaker(value = "") {
  let part = String(value).slice(0, TEXT_MAX).split(/<br\s*\/?>/i)[0];
  part = part.replace(/^\s*(ООО|АО|ЗАО|ИП|ОАО|ПАО)?[^:]{0,80}?"[^"]*"+\s*:/u, "");
  part = part.replace(/^\s*[^:]{0,60}(ИП|ООО|АО)[^:]{0,40}:/u, "");
  const suppliers = part.indexOf("Поставщики:");
  if (suppliers >= 0) part = part.slice(0, suppliers);
  return trimPunct(stripTags(part));
}

function nutrition(v) {
  v = String(v).slice(0, 2000);
  const num = (re) => { const m = v.match(re); return m ? parseFloat(m[1].replace(",", ".")) : null; };
  return {
    p: num(/белк[а-я]*\s*([\d.,]+)/iu), f: num(/жир[а-я]*\s*([\d.,]+)/iu), c: num(/углевод[а-я]*\s*([\d.,]+)/iu),
    kcal: num(/([\d.,]+)\s*ккал/iu), sugars: num(/сахар[а-я() ]*[-–—]?\s*([\d.,]+)/iu),
  };
}

// Name: a trailing weight («Творог 5%, 180 г») is split off for compact rows
function splitName(name) {
  const m = /^(.*?),?\s+(\d[\d.,]*\s*(?:г|кг|мл|л|шт)\.?(?:\s*[×x]\s*\d+)?)\s*$/iu.exec(name);
  return m && m[1].length > 2 ? { title: m[1], pack: m[2] } : { title: name, pack: "", whole: true };
}

export function normalize(item) {
  if (!item || item.__vv) return item;
  const name = decode(item.name ?? "").trim();
  const props = (item.properties ?? []).map((p) => ({ name: decode(p.name), raw: p.value, value: firstMaker(p.value) }));
  const prop = (needle) => props.find((p) => p.name.includes(needle));
  const comp = prop("Состав")?.value ?? "";
  const nutr = nutrition(prop("ценность")?.value ?? "");
  const w = item.weight ?? {};
  const grams = item.unit === "кг" ? 1000 : Math.round((w.value || 0) * (w.unit === "кг" ? 1000 : 1));
  const price = item.price?.current ?? 0;
  const old = item.price?.old ?? null;
  const compL = comp.toLowerCase().replace(/ё/g, "е");
  const text = `${name.toLowerCase()} ${compL}`;
  const adds = [...new Set((comp.match(RX.additives) || []).map((s) => s.toLowerCase().replace(/\s+/g, " ")))];
  const { title, pack, whole } = splitName(name);
  return {
    __vv: true,
    // The favourite-product tool sends ids as numeric strings
    id: typeof item.id === "string" && /^\d+$/.test(item.id) ? Number(item.id) : item.id,
    name,
    title,
    pack: pack || (grams && whole && !/\d\s*(г|кг|мл|л)(?![а-яё])/iu.test(name) ? (grams >= 1000 ? `${+(grams / 1000).toFixed(2)} кг` : `${grams} г`) : ""),
    slug: item.slug,
    url: item.url ?? `https://vkusvill.ru/goods/${item.id}/`,
    description: decode(item.description ?? "").trim(),
    brand: item.brand ?? null,
    price,
    old: old && old > price ? old : null,
    off: item.price?.discount_percent ? Math.round(item.price.discount_percent) : old && old > price ? Math.round((1 - price / old) * 100) : 0,
    offInfo: item.price?.discount_info ?? null,
    unit: item.unit ?? "шт",
    grams,
    per100: grams ? Math.round((price / grams) * 1000) / 10 : null,
    rating: item.rating?.average ? Math.round(item.rating.average * 10) / 10 : 0,
    votes: item.rating?.count ?? 0,
    // Most tools send `images` with sizes; the favourite-product tool sends a single `img`
    images: item.images?.length ? item.images.map((i) => i.medium ?? i.small ?? i.large).filter(Boolean) : typeof item.img === "string" ? [item.img] : [],
    thumb: item.images?.[0]?.small ?? item.images?.[0]?.medium ?? (typeof item.img === "string" ? item.img : null),
    category: (item.category ?? []).map((c) => c.name).reverse(),
    props,
    comp,
    ...nutr,
    flags: {
      sugar: RX.sugar.test(compL) && !RX.noSugar.test(name),
      gluten: RX.gluten.test(compL) && !RX.glutenFree.test(name),
      lactose: RX.lactose.test(text) && !RX.lactoseFree.test(name),
      additives: adds.length,
      palm: RX.palm.test(compL),
    },
    additiveList: adds,
    available: item.available_quantity ?? null,
  };
}

// Compact snapshot for the cart and history, without long texts
export function snapshot(p) {
  return {
    id: p.id, name: p.name, title: p.title, pack: p.pack, price: p.price, old: p.old, off: p.off, unit: p.unit, grams: p.grams,
    url: p.url, thumb: p.thumb, images: (p.images ?? []).slice(0, 1), rating: p.rating, votes: p.votes, category: p.category,
    p: p.p, f: p.f, c: p.c, kcal: p.kcal, flags: p.flags, per100: p.per100,
  };
}

// Snapshots come from the state file, which may be hand-edited: strings are cleaned, shapes enforced
export function fromSnapshot(raw) {
  const s = cleanDeep(raw);
  const strings = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === "string") : []);
  return {
    __vv: true, description: "", props: [], comp: "", additiveList: [], offInfo: null,
    ...s,
    title: typeof s.title === "string" ? s.title : s.name,
    images: strings(s.images),
    category: strings(s.category),
    flags: s.flags && typeof s.flags === "object" ? s.flags : {},
  };
}

export const rub = (n) => (n == null ? "—" : `${Math.round(n).toLocaleString("ru-RU").replace(/\u00a0|\u202f/g, " ")} ₽`);
export const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
export const compactNum = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".", ",")} млн` : n >= 1e4 ? `${Math.round(n / 1000)} тыс` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(".", ",")} тыс` : String(n));

export const qtyStep = (p) => (p.unit === "кг" ? 0.1 : 1);
export const qtyText = (p, q) => (p.unit === "кг" ? `${+q.toFixed(2)} кг` : `${q} шт`);
// Line cost: for items sold by weight, price per kg × kg
export const lineTotal = (p, q) => p.price * q;
// Line weight in grams, for the kcal and macro totals
export const lineGrams = (p, q) => (p.unit === "кг" ? q * 1000 : (p.grams || 0) * q);
