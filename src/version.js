// The package version and the User-Agent every request carries, so VkusVill can tell this client
// and its version apart in their analytics, the way other CLIs do (product/version, then details):
// VkusVill-CLI/1.2.3 (macOS arm64; Node.js 24.1.0)

import { readFileSync } from "node:fs";

export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const OS = { darwin: "macOS", win32: "Windows", linux: "Linux", freebsd: "FreeBSD", openbsd: "OpenBSD" }[process.platform] ?? process.platform;
export const USER_AGENT = `VkusVill-CLI/${VERSION} (${OS} ${process.arch}; Node.js ${process.versions.node})`;
