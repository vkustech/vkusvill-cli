#!/usr/bin/env node
// VkusVill in the terminal. With no arguments, opens the full-screen interface; with a command, prints plain output for scripts.

// Node 18 is past its end of life, and its experimental fetch prints a warning over the screen
if (+process.versions.node.split(".")[0] < 20) {
  console.error(`Нужен Node.js 20 или новее, а это ${process.versions.node}`);
  process.exit(1);
}

const { main } = await import("../src/main.js");
const { clean } = await import("../src/safe.js");

// `vv search … | head` closes the pipe early; that is not an error
process.stdout.on("error", (e) => { if (e.code === "EPIPE") process.exit(0); throw e; });

main(process.argv.slice(2)).catch((e) => {
  // Messages may quote the server: no control characters reach the terminal
  console.error(clean(e?.message ?? e));
  process.exit(1);
});
