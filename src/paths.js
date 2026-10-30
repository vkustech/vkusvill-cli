// Where vkusvill keeps its files. Config (state, sign-in) is private to the user; the cache is disposable.

import { homedir } from "node:os";
import path from "node:path";
import { lstatSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";

function configBase() {
  if (process.env.XDG_CONFIG_HOME) return process.env.XDG_CONFIG_HOME;
  if (process.platform === "win32" && process.env.APPDATA) return process.env.APPDATA;
  return path.join(homedir(), ".config");
}

function cacheBase() {
  if (process.env.XDG_CACHE_HOME) return process.env.XDG_CACHE_HOME;
  if (process.platform === "darwin") return path.join(homedir(), "Library", "Caches");
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA;
  return path.join(homedir(), ".cache");
}

export const CONFIG_DIR = process.env.VV_CONFIG_DIR ?? path.join(configBase(), "vv-cli");
export const CACHE_DIR = process.env.VV_CACHE_DIR ?? path.join(cacheBase(), "vv-cli");

// The folder must be a real folder of this user: VV_CONFIG_DIR or XDG_* may point somewhere shared,
// where someone else could have created it first, or put a symlink in its place
const checked = new Set();
export function ownDir(dir) {
  if (checked.has(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) throw new Error(`${dir} — не ваша папка или ссылка, файлы туда не пишу`);
  checked.add(dir);
}

// Writes a private (0600) file for a later rename. Exclusive create: a symlink planted at the
// temp name makes the write fail instead of writing through it
export function writePrivate(file, data) {
  ownDir(path.dirname(file));
  try { unlinkSync(file); } catch {}
  writeFileSync(file, data, { mode: 0o600, flag: "wx" });
}
