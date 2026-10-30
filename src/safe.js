// Defense against untrusted data: anything from the network may contain terminal control characters
// (ESC, C1 codes such as \x9b, which is CSI) and bidi override characters that spoof
// the visible text. We clean on input and open outbound links only to known domains.

// \r goes too: in plain command output it would move the cursor back and let a name overwrite a row
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

export const clean = (s) => String(s ?? "").replace(UNSAFE, "").replace(/\t/g, " ");

// No real text from VkusVill comes close; a longer one is cut so wrapping it every frame stays cheap
const STRING_MAX = 10000;

// Recursively cleans every string in a response
export function cleanDeep(v, depth = 0) {
  if (depth > 40) return null;
  if (typeof v === "string") return clean(v.length > STRING_MAX ? v.slice(0, STRING_MAX) + "…" : v);
  if (Array.isArray(v)) return v.map((x) => cleanDeep(x, depth + 1));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      // The key is cleaned first: "__pro\u0000to__" would turn into "__proto__" after the check
      const key = clean(k);
      if (key !== "__proto__" && key !== "constructor" && key !== "prototype") out[key] = cleanDeep(x, depth + 1);
    }
    return out;
  }
  return v;
}

// https only: VkusVill with its subdomains, and Yandex Maps alone (yandex.ru has open redirects
// such as /redir and clck.yandex.ru, which would let a link from the server lead anywhere)
const ALLOW = {
  open: (host, u) => host === "vkusvill.ru" || host.endsWith(".vkusvill.ru") || (host === "yandex.ru" && u.pathname.startsWith("/maps/")),
  image: (host) => host === "vkusvill.ru" || host.endsWith(".vkusvill.ru"),
  cart: (host) => host === "vkusvill.ru" || host.endsWith(".vkusvill.ru"),
};

export function safeUrl(url, kind = "open") {
  try {
    const u = new URL(url);
    // https on its standard port only, no credentials in the address
    if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
    return ALLOW[kind](u.hostname.toLowerCase(), u) ? u.href : null;
  } catch {
    return null;
  }
}

// Reads a response body up to max bytes; a larger one is cut off while streaming, before it is all in
// memory, whatever Content-Length says (or does not say). Returns a Buffer, or null when too large
export async function readCapped(res, max) {
  if (+(res.headers.get("content-length") ?? 0) > max) { res.body?.cancel().catch(() => {}); return null; }
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > max) { res.body.cancel().catch(() => {}); return null; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
