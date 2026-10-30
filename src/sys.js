// System integration: open a link in the browser, copy to the clipboard.

import { spawn } from "node:child_process";
import path from "node:path";
import { safeUrl } from "./safe.js";
import { POWERSHELL } from "./secrets.js";

// Windows tools by full path: a bare name is looked up in the current folder first
const SYSTEM32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");

let onBlocked = () => {};
export function onUrlBlocked(fn) { onBlocked = fn; }

// Opens only https links to known hosts. No shell is involved: on Windows `cmd /c start` would
// interpret `&` and `|` inside the URL, so rundll32 gets the URL as a plain argument instead.
export function openUrl(url) {
  const safe = safeUrl(url, "open");
  if (!safe) { onBlocked(url); return false; }
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [safe]]
    : process.platform === "win32" ? [path.join(SYSTEM32, "rundll32.exe"), ["url.dll,FileProtocolHandler", safe]]
    : ["xdg-open", [safe]];
  try { spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch {}
  return true;
}

// System clipboard first; OSC 52 as a fallback (works over SSH in most terminals).
export function copy(text) {
  const tryCmd = (cmd, args) => new Promise((resolve) => {
    try {
      const p = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
      p.on("error", () => resolve(false));
      p.on("close", (code) => resolve(code === 0));
      p.stdin.end(text);
    } catch { resolve(false); }
  });
  const osc = () => { if (process.stdout.isTTY) process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`); return true; };
  if (process.platform === "darwin") return tryCmd("pbcopy", []).then((ok) => ok || osc());
  // clip.exe reads the console code page and garbles Cyrillic; PowerShell gets UTF-8 as base64
  if (process.platform === "win32") {
    const ps = "$t = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())); Set-Clipboard -Value $t";
    const viaPs = () => new Promise((resolve) => {
      try {
        const p = spawn(POWERSHELL, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ps], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
        p.on("error", () => resolve(false));
        p.on("close", (code) => resolve(code === 0));
        p.stdin.end(Buffer.from(text, "utf8").toString("base64"));
      } catch { resolve(false); }
    });
    return viaPs().then((ok) => ok || tryCmd(path.join(SYSTEM32, "clip.exe"), [])).then((ok) => ok || osc());
  }
  return tryCmd("wl-copy", []).then((ok) => ok || tryCmd("xclip", ["-selection", "clipboard"])).then((ok) => ok || osc());
}
