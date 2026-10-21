import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { mockAgentCommand } from "acp-mock";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_STOP_GRACE_MS, MenuSproutAgentRuntime } from "../src/main/agent-runtime";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..");
const acpMockBinPath = join(repoRoot, "node_modules", "acp-mock", "dist", "cli.js");
const refusalAgentPath = join(repoRoot, "tests", "fixtures", "fake-acp-refusal.mjs");
const stubbornAgentPath = join(repoRoot, "tests", "fixtures", "fake-acp-stubborn.mjs");
const usageAgentPath = join(repoRoot, "tests", "fixtures", "fake-acp-usage.mjs");

async function git(cwd: string, args: string[]) {
  return execFileAsync("git", args, { cwd });
}

async function gitText(cwd: string, args: string[]) {
  const { stdout } = await git(cwd, args);
  return stdout.trim();
}

async function createRepo() {
  const repo = await mkdtemp(join(tmpdir(), "menu-sprout-acp-e2e-"));
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "tests@example.com"]);
  await git(repo, ["config", "user.name", "Menu Sprout ACP Tests"]);
  await writeFile(join(repo, "README.md"), "# fixture\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  return repo;
}

async function readJsonLines(filePath: string): Promise<Record<string, unknown>[]> {
  if (!existsSync(filePath)) return [];
  return (await readFile(filePath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readTurnLogs(repo: string): Promise<Record<string, unknown>[]> {
  const logDir = join(repo, ".cache", "menu-sprout", "agent-turns");
  if (!existsSync(logDir)) return [];
  const files = await readdir(logDir);
  return Promise.all(files.map((file) => readFile(join(logDir, file), "utf8").then((text) => JSON.parse(text) as Record<string, unknown>)));
}

function buildMockCommand(eventLogPath: string) {
  return mockAgentCommand({
    bin: acpMockBinPath,
    eventLogPath,
    agentMessageJson: {
      summary: "mock acp turn completed",
      changed: ["README.md"],
    },
    appendFile: {
      path: "../README.md",
      text: "- edited by acp-mock\n",
    },
  });
}

function buildSlowMockCommand(eventLogPath: string) {
  return mockAgentCommand({
    bin: acpMockBinPath,
    eventLogPath,
    promptDelayMs: 1_000,
  });
}

describe("MenuSproutAgentRuntime ACP e2e", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it.skipIf(process.platform === "win32")("closes the eventual startup process before completing cancellation", async () => {
    const repo = await createRepo();
    tempDirs.push(repo);
    await writeFile(join(repo, ".gitignore"), ".cache/\n");
    await git(repo, ["add", ".gitignore"]);
    await git(repo, ["commit", "-m", "ignore runtime cache"]);
    const controlDir = join(repo, ".cache", "control");
    await mkdir(controlDir, { recursive: true });
    const runtime = new MenuSproutAgentRuntime(repo, {
      agentName: "stubborn",
      registryOverrides: { stubborn: `node ${JSON.stringify(stubbornAgentPath)} ${JSON.stringify(controlDir)}` },
    });
    const sent = runtime.send("make an edit");
    let settled = false;
    void sent.then(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(existsSync(join(controlDir, "startup-started"))).toBe(true));
      const { pid } = JSON.parse(await readFile(join(controlDir, "startup-started"), "utf8"));
      expect(runtime.cancel()).toEqual({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      expect(await runtime.currentSessionSnapshot()).toBeNull();
      expect((await runtime.send("another turn")).assistantText).toContain("already running");
      await writeFile(join(controlDir, "release-startup"), "yes");
      expect((await sent).cancelled).toBe(true);
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
      expect(existsSync(join(controlDir, "edits"))).toBe(false);
      expect(await runtime.newConversation()).toEqual({ ok: true });
    } finally {
      await writeFile(join(controlDir, "release-startup"), "yes");
      await writeFile(join(controlDir, "release-turn"), "yes");
      await sent;
      await runtime.close();
    }
  }, 30_000);

  it.skipIf(process.platform === "win32")("terminates an agent that ignores Cancel within the grace period and offers its partial edits for Keep/Undo", async () => {
    const repo = await createRepo();
    tempDirs.push(repo);
    await writeFile(join(repo, ".gitignore"), ".cache/\n");
    await git(repo, ["add", ".gitignore"]);
    await git(repo, ["commit", "-m", "ignore runtime cache"]);
    const controlDir = join(repo, ".cache", "control");
    await mkdir(controlDir, { recursive: true });
    await writeFile(join(controlDir, "release-startup"), "yes");
    const runtime = new MenuSproutAgentRuntime(repo, {
      agentName: "stubborn",
      registryOverrides: { stubborn: `node ${JSON.stringify(stubbornAgentPath)} ${JSON.stringify(controlDir)}` },
    });
    const sent = runtime.send("make an edit");
    try {
      await vi.waitFor(() => expect(existsSync(join(controlDir, "edits"))).toBe(true));
      const { pid } = JSON.parse(await readFile(join(controlDir, "startup-started"), "utf8"));
      const cancelledAt = Date.now();
      expect(runtime.cancel()).toEqual({ ok: true });
      await vi.waitFor(() => expect(existsSync(join(controlDir, "cancel-requested"))).toBe(true));
      expect(await runtime.currentSessionSnapshot()).toBeNull();
      const result = await sent;
      expect(Date.now() - cancelledAt).toBeGreaterThanOrEqual(AGENT_STOP_GRACE_MS);
      expect(Date.now() - cancelledAt).toBeLessThan(AGENT_STOP_GRACE_MS + 5_000);
      expect(() => process.kill(pid, 0)).toThrow();
      const edits = await readFile(join(controlDir, "edits"), "utf8");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await readFile(join(controlDir, "edits"), "utf8")).toBe(edits);
      expect(result).toMatchObject({ cancelled: true, session: { dirty: true, canSave: true, canRollback: true } });
      expect(await runtime.currentSessionSnapshot()).toMatchObject({ dirty: true });
      expect((await runtime.rollback()).ok).toBe(true);
    } finally {
      await writeFile(join(controlDir, "release-turn"), "yes");
      await sent;
      await runtime.close();
    }
  }, 30_000);

  it.skipIf(process.platform === "win32")("terminates an agent whose session startup outlasts the Cancel grace period", async () => {
    const repo = await createRepo();
    tempDirs.push(repo);
    await writeFile(join(repo, ".gitignore"), ".cache/\n");
    await git(repo, ["add", ".gitignore"]);
    await git(repo, ["commit", "-m", "ignore runtime cache"]);
    const controlDir = join(repo, ".cache", "control");
    await mkdir(controlDir, { recursive: true });
    const runtime = new MenuSproutAgentRuntime(repo, {
      agentName: "stubborn",
      registryOverrides: { stubborn: `node ${JSON.stringify(stubbornAgentPath)} ${JSON.stringify(controlDir)}` },
    });
    const sent = runtime.send("make an edit");
    try {
      await vi.waitFor(() => expect(existsSync(join(controlDir, "startup-started"))).toBe(true));
      const { pid } = JSON.parse(await readFile(join(controlDir, "startup-started"), "utf8"));
      expect(runtime.cancel()).toEqual({ ok: true });
      expect((await sent).cancelled).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(existsSync(join(controlDir, "edits"))).toBe(false);
      expect(await runtime.newConversation()).toEqual({ ok: true });
    } finally {
      await writeFile(join(controlDir, "release-startup"), "yes");
      await writeFile(join(controlDir, "release-turn"), "yes");
      await sent;
      await runtime.close();
    }
  }, 30_000);

  it.skipIf(process.platform === "win32")(
    "runs a prompt through real acpx against acp-mock and records a change session",
    async () => {
      const repo = await createRepo();
      tempDirs.push(repo);
      const logDir = await mkdtemp(join(tmpdir(), "menu-sprout-acp-logs-"));
      tempDirs.push(logDir);
      const mockLogPath = join(logDir, "mock-acp.jsonl");

      const runtime = new MenuSproutAgentRuntime(repo, {
        agentName: "mock-target",
        registryOverrides: {
          "mock-target": buildMockCommand(mockLogPath),
        },
      });

      const result = await runtime.send("Add a simple test line");
      const readme = await readFile(join(repo, "README.md"), "utf8");
      const events = (await readJsonLines(mockLogPath)).map((entry) => entry.event);
      const turnLogs = await readTurnLogs(repo);

      expect(result.assistantText).toContain("mock acp turn completed");
      expect(result.session).toMatchObject({
        startedClean: true,
        canSave: true,
        canRollback: true,
      });
      expect(readme).toContain("edited by acp-mock");
      expect(events).toContain("agent:initialize");
      expect(events).toContain("agent:newSession");
      expect(events).toContain("agent:prompt:start");
      expect(events).toContain("agent:prompt:done");
      expect(events).toContain("workspace:changed");
      expect(turnLogs).toHaveLength(1);
      expect(turnLogs[0]).toMatchObject({
        agentName: "mock-target",
        status: "completed",
      });
      expect(turnLogs[0]?.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text_delta" })]));

      const save = await runtime.save("Accept acp-mock changes");
      expect(save.ok).toBe(true);
      expect(await gitText(repo, ["rev-list", "--count", "HEAD"])).toBe("2");
      expect(await gitText(repo, ["log", "-1", "--pretty=%s"])).toBe("Accept acp-mock changes");
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "returns an ACP refusal reply, records failure, and closes its clean change session",
    async () => {
      const repo = await createRepo();
      tempDirs.push(repo);
      await writeFile(join(repo, ".gitignore"), ".cache/\n");
      await git(repo, ["add", ".gitignore"]);
      await git(repo, ["commit", "-m", "ignore runtime cache"]);

      const runtime = new MenuSproutAgentRuntime(repo, {
        agentName: "refusal-agent",
        registryOverrides: {
          "refusal-agent": `node ${JSON.stringify(refusalAgentPath)}`,
        },
      });

      await expect(runtime.send("make an edit")).resolves.toMatchObject({
        refused: true,
        assistantText: "Agent refused the request.",
        reply: "Bearer secret-provider-detail",
      });
      expect(await runtime.currentSessionSnapshot()).toBeNull();
      expect(await gitText(repo, ["status", "--porcelain"])).toBe("");

      const turnLogs = await readTurnLogs(repo);
      expect(turnLogs).toHaveLength(1);
      expect(turnLogs[0]).toMatchObject({
        status: "failed",
        error: {
          message: "Agent refused the request.",
          code: "AGENT_REFUSED",
        },
      });
      expect(JSON.stringify(turnLogs[0])).not.toContain("secret-provider-detail");
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "reports the turn's tool calls, and tokens only when the agent reported them over ACP",
    async () => {
      const repo = await createRepo();
      tempDirs.push(repo);
      await writeFile(join(repo, ".gitignore"), ".cache/\n");
      await git(repo, ["add", ".gitignore"]);
      await git(repo, ["commit", "-m", "ignore runtime cache"]);

      const runtime = new MenuSproutAgentRuntime(repo, {
        agentName: "usage-agent",
        registryOverrides: { "usage-agent": `node ${JSON.stringify(usageAgentPath)}` },
      });
      try {
        const reported = await runtime.send("REPORT_USAGE please");
        expect(reported.metrics).toEqual({
          durationMs: expect.any(Number),
          toolCalls: 2,
          tokens: { inputTokens: 2310, outputTokens: 40, totalTokens: 2350, cachedReadTokens: 300, cachedWriteTokens: 2000 },
        });

        const unreported = await runtime.send("no usage this time");
        expect(unreported.metrics).toEqual({ durationMs: expect.any(Number), toolCalls: 2 });
      } finally {
        await runtime.close();
      }
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "keeps partial workspace changes reviewable when an ACP refusal follows an edit",
    async () => {
      const repo = await createRepo();
      tempDirs.push(repo);
      await writeFile(join(repo, ".gitignore"), ".cache/\n");
      await git(repo, ["add", ".gitignore"]);
      await git(repo, ["commit", "-m", "ignore runtime cache"]);

      const runtime = new MenuSproutAgentRuntime(repo, {
        agentName: "refusal-agent",
        registryOverrides: {
          "refusal-agent": `node ${JSON.stringify(refusalAgentPath)}`,
        },
      });

      await expect(runtime.send("PARTIAL_EDIT then fail")).resolves.toMatchObject({
        refused: true,
        assistantText: "Agent refused the request.",
        reply: "Bearer secret-provider-detail",
      });

      expect(existsSync(join(repo, "extensions", "partial-widget", "widget.tsx"))).toBe(true);
      expect(await runtime.currentSessionSnapshot()).toMatchObject({
        canSave: true,
        canRollback: true,
        dirty: true,
        changes: [{ type: "extension", extensionId: "partial-widget", kind: "created" }],
      });

      expect((await runtime.rollback()).ok).toBe(true);
      expect(existsSync(join(repo, "extensions", "partial-widget"))).toBe(false);
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "recovers a stale persisted session after a restart instead of failing the turn",
    async () => {
      const repo = await createRepo();
      tempDirs.push(repo);
      // Source mode gitignores runtime state; without this the untracked .cache
      // files (turn logs, session store) would dirty the tree before the restart.
      await writeFile(join(repo, ".gitignore"), ".cache/\n");
      await git(repo, ["add", ".gitignore"]);
      await git(repo, ["commit", "-m", "ignore runtime cache"]);
      const logDir = await mkdtemp(join(tmpdir(), "menu-sprout-acp-logs-"));
      tempDirs.push(logDir);
      const mockLogPath = join(logDir, "mock-acp.jsonl");

      const makeRuntime = () =>
        new MenuSproutAgentRuntime(repo, {
          agentName: "mock-target",
          registryOverrides: { "mock-target": buildMockCommand(mockLogPath) },
        });

      // First launch: run a turn and accept it so the tree is clean for the restart.
      const first = makeRuntime();
      await first.send("first turn");
      await first.save("accept first");
      await first.close();

      // acpx persisted the session record to disk; a fresh process will try to resume it.
      const sessionFile = join(repo, ".cache", "menu-sprout", "acp-sessions", "sessions", "menu-sprout-agent-chat.json");
      expect(existsSync(sessionFile)).toBe(true);

      // Restart: acp-mock reports loadSession:false, so resuming the stale record
      // fails with SESSION_RESUME_REQUIRED. The runtime must discard it and start
      // fresh rather than surfacing "Agent unavailable".
      const second = makeRuntime();
      const result = await second.send("second turn after restart");
      await second.close();

      expect(result.assistantText).toContain("mock acp turn completed");

      const turnLogs = await readTurnLogs(repo);
      const failed = turnLogs.find((log) => log.status === "failed");
      // The failed attempt proves the restart actually hit the resume path (not that
      // resume silently worked) and that the reason is now recorded in the log.
      expect(failed?.error).toMatchObject({ detailCode: "SESSION_RESUME_REQUIRED" });
      expect(turnLogs.filter((log) => log.status === "completed")).toHaveLength(2);
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "rolls back changes produced through acpx and acp-mock",
    async () => {
      const repo = await createRepo();
      tempDirs.push(repo);
      const logDir = await mkdtemp(join(tmpdir(), "menu-sprout-acp-logs-"));
      tempDirs.push(logDir);
      const mockLogPath = join(logDir, "mock-acp.jsonl");

      const runtime = new MenuSproutAgentRuntime(repo, {
        agentName: "mock-target",
        registryOverrides: {
          "mock-target": buildMockCommand(mockLogPath),
        },
      });

      await runtime.send("Add a line that should be reverted");
      expect(await readFile(join(repo, "README.md"), "utf8")).toContain("edited by acp-mock");

      const rollback = await runtime.rollback();

      expect(rollback.ok).toBe(true);
      expect(await readFile(join(repo, "README.md"), "utf8")).toBe("# fixture\n");
      expect(await gitText(repo, ["status", "--porcelain"])).toBe("");
      expect(await gitText(repo, ["rev-list", "--count", "HEAD"])).toBe("1");
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "blocks agent switching while generated changes are pending review",
    async () => {
      const repo = await createRepo();
      tempDirs.push(repo);
      const logDir = await mkdtemp(join(tmpdir(), "menu-sprout-acp-logs-"));
      tempDirs.push(logDir);
      const mockLogPath = join(logDir, "mock-acp.jsonl");

      const runtime = new MenuSproutAgentRuntime(repo, {
        agentName: "mock-target",
        registryOverrides: {
          "mock-target": buildMockCommand(mockLogPath),
          "next-agent": buildMockCommand(mockLogPath),
        },
      });

      await runtime.send("Add a line before switching");

      await expect(runtime.setAgent("next-agent")).rejects.toThrow("Save or Rollback the current agent changes before switching agents.");
      expect(runtime.currentAgent).toBe("mock-target");
      expect(await runtime.rollback()).toMatchObject({ ok: true });
      expect(await readFile(join(repo, "README.md"), "utf8")).toBe("# fixture\n");
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "blocks agent switching while a turn is running",
    async () => {
      const repo = await createRepo();
      tempDirs.push(repo);
      const logDir = await mkdtemp(join(tmpdir(), "menu-sprout-acp-logs-"));
      tempDirs.push(logDir);
      const mockLogPath = join(logDir, "mock-acp.jsonl");

      const runtime = new MenuSproutAgentRuntime(repo, {
        agentName: "mock-target",
        registryOverrides: {
          "mock-target": buildSlowMockCommand(mockLogPath),
          "next-agent": buildMockCommand(mockLogPath),
        },
      });

      const turn = runtime.send("Keep the agent busy");

      await expect(runtime.setAgent("next-agent")).rejects.toThrow("Agent is running. Wait for it to finish before switching agents.");
      expect(runtime.currentAgent).toBe("mock-target");
      await turn;
      expect(await runtime.rollback()).toMatchObject({ ok: true });
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "blocks ACP startup when the repo is dirty so rollback remains safe",
    async () => {
      const repo = await createRepo();
      tempDirs.push(repo);
      const logDir = await mkdtemp(join(tmpdir(), "menu-sprout-acp-logs-"));
      tempDirs.push(logDir);
      const mockLogPath = join(logDir, "mock-acp.jsonl");
      await writeFile(join(repo, "README.md"), "# user changed this first\n");

      const runtime = new MenuSproutAgentRuntime(repo, {
        agentName: "mock-target",
        registryOverrides: {
          "mock-target": buildMockCommand(mockLogPath),
        },
      });

      const result = await runtime.send("Try to edit anyway");
      const events = await readJsonLines(mockLogPath);

      expect(result.assistantText).toContain("working tree is already dirty");
      expect(result.session).toMatchObject({
        startedClean: false,
        canSave: false,
        canRollback: false,
      });
      expect(events).toEqual([]);
    },
    30_000,
  );

  it.skipIf(process.platform === "win32")(
    "returns a recoverable session when an ACP turn times out",
    async () => {
      const repo = await createRepo();
      tempDirs.push(repo);
      const logDir = await mkdtemp(join(tmpdir(), "menu-sprout-acp-logs-"));
      tempDirs.push(logDir);
      const mockLogPath = join(logDir, "mock-acp.jsonl");

      const runtime = new MenuSproutAgentRuntime(repo, {
        agentName: "mock-target",
        requestTimeoutMs: 100,
        registryOverrides: {
          "mock-target": buildSlowMockCommand(mockLogPath),
        },
      });

      const result = await runtime.send("Take too long");

      expect(result.assistantText).toContain("timed out");
      expect(result.assistantText).toContain("mock-target agent");
      expect(result.assistantText).toContain("100ms");
      expect(result.session).toMatchObject({
        startedClean: true,
        canSave: true,
        canRollback: true,
      });
    },
    30_000,
  );
});
