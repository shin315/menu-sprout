import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeDriver } from "../src/adapters/claude/driver";
import { CodexDriver } from "../src/adapters/codex/driver";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === "win32").each([
  ["claude", ClaudeDriver],
  ["codex", CodexDriver],
] as const)("%s owned tool cancellation", (name, Driver) => {
  it.each([
    ["abort", "TOOL_TREE"],
    ["abort", "TOOL_TREE_EXIT"],
    ["abort", "TOOL_TREE_DETACHED"],
    ["abort", "TOOL_TREE_EXIT_DETACHED"],
    ["dispose", "TOOL_TREE"],
    ["dispose", "TOOL_TREE_EXIT"],
    ["dispose", "TOOL_TREE_DETACHED"],
    ["dispose", "TOOL_TREE_EXIT_DETACHED"],
  ])("stops descendants before %s settles with %s", async (action, mode) => {
    const dir = await mkdtemp(join(tmpdir(), `${name}-tool-cancel-`));
    const pidFile = join(dir, "tool.json");
    const driver = new Driver({ command: join(__dirname, "fixtures", "fake-clis", `fake-${name}.mjs`) });
    await driver.start(dir);
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    const prompt = driver.prompt(`${mode}:${pidFile}`, (update) => {
      if (update.sessionUpdate === "agent_message_chunk") ready();
    }, controller.signal);
    let toolPid: number | undefined;
    let cliPid: number | undefined;
    try {
      await started;
      ({ toolPid, cliPid } = JSON.parse(await readFile(pidFile, "utf8")));
      expect(isAlive(toolPid!)).toBe(true);
      expect(isAlive(cliPid!)).toBe(true);
      if (action === "abort") controller.abort();
      else await driver.dispose();
      expect(await prompt).toBe("cancelled");
      expect(isAlive(toolPid!)).toBe(false);
      expect(isAlive(cliPid!)).toBe(false);
      const edits = await readFile(`${pidFile}.edits`, "utf8");
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await readFile(`${pidFile}.edits`, "utf8")).toBe(edits);
      expect(await driver.prompt("hello", () => {}, new AbortController().signal)).toBe("end_turn");
    } finally {
      for (const pid of [cliPid, toolPid]) {
        if (pid !== undefined && isAlive(pid)) process.kill(pid, "SIGKILL");
      }
      await driver.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
