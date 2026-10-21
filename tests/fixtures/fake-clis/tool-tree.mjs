import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export async function startToolTree(prompt) {
  const [, exitOnSigterm, detached, pidFile] = prompt.match(/TOOL_TREE(_EXIT)?(_DETACHED)?:(\S+)/) ?? [];
  process.on("SIGTERM", () => {
    if (exitOnSigterm) process.exit(1);
  });
  const tool = spawn(process.execPath, ["-e", `
    const { writeFileSync } = require("node:fs");
    const pidFile = process.argv[1];
    process.on("SIGTERM", () => {});
    let edits = 0;
    setInterval(() => writeFileSync(pidFile + ".edits", String(++edits)), 10);
    writeFileSync(pidFile, JSON.stringify({ toolPid: process.pid, cliPid: process.ppid }));
  `, pidFile], { stdio: "ignore", detached: Boolean(detached) });
  while (!existsSync(pidFile)) await new Promise((resolve) => setTimeout(resolve, 5));
  return tool;
}
