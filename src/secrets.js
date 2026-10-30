// Where the client secret and the tokens live: the OS credential store when there is one, a private
// file otherwise — the same trade-off as gh or docker, never less safe than npm's ~/.npmrc.
//
// - macOS: the login Keychain through `security -i`. The commands go to its stdin and the secret is
//   passed hex-encoded (-X), so it never appears in process arguments (visible to others in `ps`).
// - Windows: a file encrypted with DPAPI for the current Windows user (the mechanism behind the
//   Credential Manager), through PowerShell; data on stdin, no native modules.
// - Linux desktop: the Secret Service (GNOME Keyring, KWallet) through `secret-tool`, secret on stdin.
//   Only tried with a D-Bus session: over SSH, in containers or WSL it would only stall.
// - Anything else, or a store that refuses: auth.json, owner-only (0600; %APPDATA% on Windows).
// VV_SECRETS=file|keychain|dpapi|secret-service forces a backend.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import path from "node:path";
import { CONFIG_DIR, writePrivate } from "./paths.js";

// The service name goes into the `security -i` command line: only plain names are accepted
const SERVICE = /^[\w.-]{1,64}$/.test(process.env.VV_KEYCHAIN_SERVICE ?? "") ? process.env.VV_KEYCHAIN_SERVICE : "vkusvill-cli";
const ACCOUNT = "auth";
const LABEL = "ВкусВилл в терминале";

const run = (cmd, args, input, timeout = 10e3) => {
  try {
    return spawnSync(cmd, args, { input, encoding: "utf8", timeout, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch {
    return { status: -1, stdout: "", stderr: "", error: true };
  }
};

// Helpers are run by full path, never looked up. On macOS and Linux npx puts node_modules/.bin first
// in PATH, and any package there may ship a "security" or "secret-tool" that would get the secrets
const SECURITY = "/usr/bin/security";
const SECRET_TOOL = ["/usr/bin/secret-tool", "/usr/local/bin/secret-tool", "/bin/secret-tool"].find((f) => existsSync(f)) ?? null;

// Windows looks for a bare program name in the current folder first: a powershell.exe planted
// there would get the secrets on stdin. System tools are always called by their full path
export const POWERSHELL = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

// PowerShell one-liners for DPAPI; base64 in and out keeps code pages out of the way
const PS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
const dpapi = (op) => `Add-Type -AssemblyName System.Security; $d = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); `
  + `$r = [Security.Cryptography.ProtectedData]::${op}($d, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); `
  + `[Console]::Out.Write([Convert]::ToBase64String($r))`;
const DPAPI_FILE = path.join(CONFIG_DIR, "secrets.dpapi");

const hasDbus = () => !!process.env.DBUS_SESSION_BUS_ADDRESS || (!!process.env.XDG_RUNTIME_DIR && existsSync(path.join(process.env.XDG_RUNTIME_DIR, "bus")));

const BACKENDS = {
  keychain: {
    label: "связка ключей macOS",
    available: () => process.platform === "darwin" && existsSync(SECURITY),
    get() {
      const r = run(SECURITY, ["find-generic-password", "-a", ACCOUNT, "-s", SERVICE, "-w"]);
      return r.status === 0 ? r.stdout.trim() : null;
    },
    set(text) {
      const hex = Buffer.from(text, "utf8").toString("hex");
      const r = run(SECURITY, ["-i"], `add-generic-password -U -a ${ACCOUNT} -s ${SERVICE} -l "${LABEL}" -X ${hex}\n`);
      // `security -i` exits 0 even when a command fails; read the value back to be sure
      return r.status === 0 && this.get() === text;
    },
    remove() { run(SECURITY, ["delete-generic-password", "-a", ACCOUNT, "-s", SERVICE]); },
  },
  dpapi: {
    label: "файл, зашифрованный Windows (DPAPI)",
    available: () => process.platform === "win32" && !run(POWERSHELL, [...PS, "exit 0"], "", 15e3).error,
    get() {
      let blob;
      try { blob = readFileSync(DPAPI_FILE, "utf8").trim(); } catch { return null; }
      const r = run(POWERSHELL, [...PS, dpapi("Unprotect")], blob, 15e3);
      return r.status === 0 && r.stdout ? Buffer.from(r.stdout.trim(), "base64").toString("utf8") : null;
    },
    set(text) {
      const r = run(POWERSHELL, [...PS, dpapi("Protect")], Buffer.from(text, "utf8").toString("base64"), 15e3);
      if (r.status !== 0 || !r.stdout) return false;
      mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
      const tmp = `${DPAPI_FILE}.${process.pid}.tmp`;
      writePrivate(tmp, r.stdout.trim());
      renameSync(tmp, DPAPI_FILE);
      return this.get() === text;
    },
    remove() { try { unlinkSync(DPAPI_FILE); } catch {} },
  },
  "secret-service": {
    label: "Secret Service (связка ключей)",
    available: () => process.platform === "linux" && hasDbus() && !!SECRET_TOOL,
    get() {
      const r = run(SECRET_TOOL, ["lookup", "service", SERVICE, "account", ACCOUNT]);
      return r.status === 0 && r.stdout ? r.stdout.trim() : null;
    },
    set(text) {
      const r = run(SECRET_TOOL, ["store", `--label=${LABEL}`, "service", SERVICE, "account", ACCOUNT], text);
      return r.status === 0 && this.get() === text;
    },
    remove() { run(SECRET_TOOL, ["clear", "service", SERVICE, "account", ACCOUNT]); },
  },
};

const NATIVE = { darwin: "keychain", win32: "dpapi", linux: "secret-service" };
let chosen; // undefined: not decided yet; null: the file

function vault() {
  if (chosen !== undefined) return chosen;
  const forced = process.env.VV_SECRETS;
  if (forced === "file") return (chosen = null);
  const name = forced && BACKENDS[forced] ? forced : NATIVE[process.platform];
  chosen = name && BACKENDS[name].available() ? BACKENDS[name] : null;
  return chosen;
}

export function storageLabel() { return vault()?.label ?? "файл auth.json (только для вас)"; }

// Where exactly the secrets are, for people who want to look: a Keychain item, an encrypted file…
export function location() {
  const v = vault();
  if (v === BACKENDS.keychain) return `«Связка ключей» → login → «${LABEL}» (служба ${SERVICE})`;
  if (v === BACKENDS.dpapi) return DPAPI_FILE;
  if (v === BACKENDS["secret-service"]) return `Secret Service → «${LABEL}» (service=${SERVICE})`;
  return null;
}

// Why the secrets are in a file, and what would move them to a store; null when nothing can be done
export function fileHint() {
  if (process.env.VV_SECRETS === "file") return "так задано в VV_SECRETS=file";
  if (process.platform === "linux") {
    if (!hasDbus()) return "без сеанса рабочего стола (SSH, WSL, контейнер) связки ключей нет — файл 0600, как ~/.npmrc у npm";
    if (!SECRET_TOOL) return "поставьте secret-tool (пакет libsecret-tools), чтобы хранить секреты в связке ключей";
  }
  if (process.platform === "win32") return "PowerShell с DPAPI недоступен — файл в %APPDATA%, доступный только вам";
  return null;
}

// The secrets as an object, or null when the store holds none
export function load() {
  const v = vault();
  if (!v) return null;
  const text = v.get();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// True when the store took them; false means the caller keeps them in the file for now.
// A refusal (a locked keychain, an unanswered unlock prompt) is not final: the store is tried
// again on a later write, at most every RETRY ms, and the secrets move back out of the file
const RETRY = 5 * 60e3;
let refusedAt = 0;
export function save(secrets) {
  const v = vault();
  if (!v || Date.now() - refusedAt < RETRY) return false;
  if (v.set(JSON.stringify(secrets))) { refusedAt = 0; return true; }
  refusedAt = Date.now();
  return false;
}

// The store exists but refused the last write: the secrets are in the file until it accepts them
export function refused() { return refusedAt > 0; }

export function remove() { vault()?.remove(); }
