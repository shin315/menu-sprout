import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcpRuntimeEvent, AcpRuntimeTurn } from "acpx/runtime";
import { resolveAgentCatalog } from "../src/main/agent-catalog";
import { metricsOfFailedTurn } from "../src/main/agent-turn-metrics";
import {
  AGENT_STOP_GRACE_MS,
  AgentTimeoutError,
  AgentTurnFailedError,
  MenuSproutAgentRuntime,
  type MenuSproutAgentRuntimeOptions,
  agentRuntimeStatusForEvent,
  buildMenuSproutAgentPrompt,
  collectAgentTurnOutput,
  getAgentRuntimeCwd,
  resolveAgentTimeoutMs,
  resolveDefaultAgentName,
  withAgentTimeout,
} from "../src/main/agent-runtime";

function available(commands: string[]) {
  const commandSet = new Set(commands);
  return (command: string) => commandSet.has(command);
}

function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(condition: () => boolean, timeoutMs = 1000) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for condition");
    await wait(1);
  }
}

function fakeTurn({
  events,
  result = Promise.resolve({ status: "completed" as const }),
  cancel = vi.fn(async () => undefined),
  closeStream = vi.fn(async () => undefined),
}: {
  events: AsyncIterable<AcpRuntimeEvent>;
  result?: AcpRuntimeTurn["result"];
  cancel?: AcpRuntimeTurn["cancel"];
  closeStream?: AcpRuntimeTurn["closeStream"];
}): AcpRuntimeTurn {
  return {
    requestId: "test-turn",
    events,
    result,
    cancel,
    closeStream,
  };
}

describe("agent runtime defaults", () => {
  it("honors MENU_SPROUT_AGENT before auto-detecting local agents", () => {
    expect(
      resolveDefaultAgentName({
        env: { MENU_SPROUT_AGENT: "mock-target" },
        commandExists: available(["codex", "claude"]),
      }),
    ).toBe("mock-target");
  });

  it("prefers Claude before Codex for the default ACP path", () => {
    expect(
      resolveDefaultAgentName({
        env: {},
        commandExists: available(["codex", "claude", "npx"]),
      }),
    ).toBe("claude");
  });

  it("uses Codex when Claude is unavailable", () => {
    expect(
      resolveDefaultAgentName({
        env: {},
        commandExists: available(["codex", "npx"]),
      }),
    ).toBe("codex");
  });

  it("uses Codex when it is the only preferred local agent available", () => {
    expect(
      resolveDefaultAgentName({
        env: {},
        commandExists: available(["codex"]),
      }),
    ).toBe("codex");
  });

  it("falls back to Claude instead of OpenCode when no preferred CLI is detected", () => {
    expect(
      resolveDefaultAgentName({
        env: {},
        commandExists: available([]),
      }),
    ).toBe("claude");
  });

  it("auto-detects Antigravity after Claude and Codex", () => {
    const catalog = resolveAgentCatalog();
    const detect = (...commands: string[]) =>
      resolveDefaultAgentName({ env: {}, catalog, commandExists: available(commands) });
    expect(detect("claude", "codex", "agy")).toBe("claude");
    expect(detect("codex", "agy")).toBe("codex");
    expect(detect("agy")).toBe("antigravity");
  });

  it("uses a bounded default request timeout", () => {
    expect(resolveAgentTimeoutMs({})).toBe(300_000);
  });

  it("launches embedded agents from the tracked extension workspace by default", () => {
    expect(getAgentRuntimeCwd("/repo")).toBe("/repo/extensions");
  });

  it("launches embedded agents from extensions-dev when dev mode provides one", () => {
    expect(getAgentRuntimeCwd("/repo", { MENU_SPROUT_EXTENSIONS_DIR: "/repo/extensions-dev" })).toBe(
      "/repo/extensions-dev",
    );
  });

  it("resolves relative dev extension workspaces inside the repo", () => {
    expect(getAgentRuntimeCwd("/repo", { MENU_SPROUT_EXTENSIONS_DIR: "extensions-dev" })).toBe(
      "/repo/extensions-dev",
    );
  });

  it("allows MENU_SPROUT_AGENT_TIMEOUT_MS to override the request timeout", () => {
    expect(resolveAgentTimeoutMs({ MENU_SPROUT_AGENT_TIMEOUT_MS: "45000" })).toBe(45_000);
  });

  it("rejects and runs cleanup when an agent operation times out", async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn();
    const pending = new Promise<string>(() => undefined);

    const timed = withAgentTimeout(pending, {
      timeoutMs: 25,
      phase: "starting agent session",
      onTimeout: cleanup,
    });
    const assertion = expect(timed).rejects.toThrow("Agent request timed out after 25ms while starting agent session");

    await vi.advanceTimersByTimeAsync(25);

    await assertion;
    expect(cleanup).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("keeps waiting while an ACP turn emits activity before the idle timeout", async () => {
    vi.useFakeTimers();

    async function* events(): AsyncIterable<AcpRuntimeEvent> {
      yield { type: "tool_call", text: "shell: git status" };
      await wait(40);
      yield { type: "text_delta", stream: "thought", text: "thinking" };
      await wait(40);
      yield { type: "text_delta", stream: "output", text: "done" };
    }

    const collected = collectAgentTurnOutput(fakeTurn({ events: events() }), { idleTimeoutMs: 50 });

    await vi.advanceTimersByTimeAsync(40);
    await vi.advanceTimersByTimeAsync(40);

    await expect(collected).resolves.toBe("done");
    vi.useRealTimers();
  });

  it("rejects a completed ACP refusal without exposing its output as an error", async () => {
    async function* events(): AsyncIterable<AcpRuntimeEvent> {
      yield { type: "text_delta", stream: "output", text: "Bearer secret-provider-detail" };
    }

    const collected = collectAgentTurnOutput(
      fakeTurn({
        events: events(),
        result: Promise.resolve({ status: "completed", stopReason: "refusal" }),
      }),
      { idleTimeoutMs: 50 },
    );

    await expect(collected).rejects.toMatchObject({
      name: "AgentTurnFailedError",
      code: "AGENT_REFUSED",
      message: "Agent refused the request.",
    });
    await expect(collected).rejects.not.toThrow(/secret-provider-detail/);
  });

  it("cancels the ACP turn when it produces no activity before the idle timeout", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(async () => undefined);
    const closeStream = vi.fn(async () => undefined);

    async function* events(): AsyncIterable<AcpRuntimeEvent> {
      await wait(1_000);
      yield { type: "text_delta", stream: "output", text: "too late" };
    }

    const collected = collectAgentTurnOutput(fakeTurn({ events: events(), cancel, closeStream }), {
      idleTimeoutMs: 25,
    });
    const assertion = expect(collected).rejects.toThrow(AgentTimeoutError);

    await vi.advanceTimersByTimeAsync(25);

    expect(closeStream).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(975);
    await assertion;
    expect(cancel).toHaveBeenCalledWith({ reason: "timeout" });
    vi.useRealTimers();
  });

  it("only turns assistant output text into user-facing status text", () => {
    expect(
      agentRuntimeStatusForEvent({
        type: "tool_call",
        text: "shell command",
        title: "checking GitHub",
      } as AcpRuntimeEvent),
    ).toBeNull();
    expect(
      agentRuntimeStatusForEvent({ type: "status", text: "usage updated: 100 tokens" } as AcpRuntimeEvent),
    ).toBeNull();
    expect(
      agentRuntimeStatusForEvent({ type: "text_delta", stream: "thought", text: "thinking" } as AcpRuntimeEvent),
    ).toBeNull();
    expect(
      agentRuntimeStatusForEvent({ type: "text_delta", stream: "output", text: "final answer" } as AcpRuntimeEvent),
    ).toEqual({ text: "final answer", eventType: "text_delta" });
  });

  it("does not publish partial streamed assistant chunks as status", async () => {
    const statuses: string[] = [];

    async function* events(): AsyncIterable<AcpRuntimeEvent> {
      yield { type: "text_delta", stream: "output", text: "Built the" };
      yield { type: "text_delta", stream: "output", text: " widget." };
    }

    const collected = collectAgentTurnOutput(fakeTurn({ events: events() }), {
      idleTimeoutMs: 50,
      onStatus: (status) => {
        statuses.push(status.text);
      },
    });

    await expect(collected).resolves.toBe("Built the widget.");
    expect(statuses).toEqual(["Built the widget."]);
  });

  it("tells agents to keep new widget capabilities hot reloadable", () => {
    const prompt = buildMenuSproutAgentPrompt("Build a Codex quota widget");

    expect(prompt).toContain("Build a Codex quota widget");
    expect(prompt).toContain("self-contained extensions");
    expect(prompt).toContain("current extension workspace");
    expect(prompt).toContain("Do not modify files outside your current extension workspace");
    expect(prompt).toContain("stable window.menuSprout bridge");
    expect(prompt).toContain("window.menuSprout.capabilities.invoke");
    expect(prompt).toContain("server.ts");
    expect(prompt).toContain("Do not add new preload methods");
    expect(prompt).toContain("server action");
    expect(prompt).toContain("recipes/");
  });

  it("aligns runtime guidance with extension-only verification", () => {
    const prompt = buildMenuSproutAgentPrompt("Build a Codex quota widget");

    expect(prompt).not.toContain("test-driven");
    expect(prompt).not.toContain("Run relevant tests");
    expect(prompt).toContain("Do not write test files");
    expect(prompt).toContain("do not write README or other documentation files");
  });

  it("requires grounding live/system data widgets in the real source before writing code, and verifying against real data before reporting done", () => {
    const prompt = buildMenuSproutAgentPrompt("Build a Codex quota widget");

    expect(prompt).toContain("inspect that actual source directly");
    expect(prompt).toContain("before writing any parsing or rendering code");
    expect(prompt).toContain("targeted, read-only check against a specific known source");
    expect(prompt).toContain("not permission to run broad or recursive searches");
    expect(prompt).toMatch(/never guess or pattern-complete/i);
    expect(prompt).toContain("verify the finished widget against that same live data");
    expect(prompt).toContain("print only non-secret metadata or explicitly redacted placeholders");
    expect(prompt).toContain("never echo raw tokens, credential blobs, cookies, auth headers");
    expect(prompt).not.toContain(
      "Verify extension work by reasoning through widget render output and server action return shapes.",
    );
  });

  describe("visual self-check instructions", () => {
    const capture = { url: "http://127.0.0.1:51234", token: "tok-abc123" };

    it("tells the agent to capture and look at its widget before reporting done", () => {
      const prompt = buildMenuSproutAgentPrompt("Build a Codex quota widget", { capture });

      expect(prompt).toContain('curl -sS -H "Authorization: Bearer tok-abc123" "http://127.0.0.1:51234/capture?widget=<widget-id>"');
      expect(prompt).toContain("Before reporting the work done, also look at the finished widget as it actually renders");
      expect(prompt).toContain("open that PNG file with your image-viewing or file-reading tool");
      expect(prompt).toMatch(/layout/);
      expect(prompt).toMatch(/clipping/);
      expect(prompt).toMatch(/empty or error state/);
      expect(prompt).toContain("expected value is visible");
      expect(prompt).toContain("capture again");
      expect(prompt).toContain("outside your extension workspace on purpose");
    });

    it("keeps the live-data verification rule alongside the visual check", () => {
      const prompt = buildMenuSproutAgentPrompt("Build a Codex quota widget", { capture });

      expect(prompt).toContain("verify the finished widget against that same live data");
      expect(prompt).toContain("inspect that actual source directly");
    });

    it("never puts the capture token into the prompt when the host offers no capture endpoint", () => {
      const prompt = buildMenuSproutAgentPrompt("Build a Codex quota widget");

      expect(prompt).not.toContain("/capture");
      expect(prompt).not.toContain("Bearer");
    });

    it("builds the runtime prompt with the endpoint the host started", () => {
      const runtime = new MenuSproutAgentRuntime("/tmp/menu-sprout-capture-prompt", { agentName: "codex", capture });
      const prompt = (runtime as unknown as { buildPrompt(prompt: string): string }).buildPrompt("Build it");

      expect(prompt).toContain("http://127.0.0.1:51234/capture");
    });
  });

  it("rejects a second send while an agent turn is already running", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "menu-sprout-agent-runtime-"));
    const extensionsDir = join(rootDir, "extensions-dev");
    const runtime = new MenuSproutAgentRuntime(rootDir, {
      agentName: "mock-agent",
      paths: {
        extensionsDir,
        agentStateDir: join(rootDir, ".cache", "acp-sessions"),
        snapshotDir: join(rootDir, ".cache", "snapshots"),
      },
    });
    const pendingOutputs: Array<(output: string) => void> = [];
    const runtimeInternals = runtime as unknown as {
      ensureAgentRuntimeCwd: () => Promise<string>;
      beginChangeSession: () => Promise<{
        startedClean: boolean;
        canSave: boolean;
        canRollback: boolean;
        snapshot: (message?: string) => { startedClean: boolean; canSave: boolean; canRollback: boolean; head: string | null; message?: string };
        save: () => Promise<{ ok: boolean }>;
        rollback: () => Promise<{ ok: boolean }>;
      }>;
      ensureRuntime: () => Promise<{
        ensureSession: () => Promise<object>;
        startTurn: () => AcpRuntimeTurn;
      }>;
      collectTurnOutput: () => Promise<string>;
    };
    runtimeInternals.ensureAgentRuntimeCwd = vi.fn(async () => extensionsDir);
    runtimeInternals.beginChangeSession = vi.fn(async () => ({
      startedClean: true,
      canSave: true,
      canRollback: true,
      snapshot: (message?: string) => ({ startedClean: true, canSave: true, canRollback: true, head: "HEAD", message }),
      save: vi.fn(async () => ({ ok: true })),
      rollback: vi.fn(async () => ({ ok: true })),
    }));
    runtimeInternals.ensureRuntime = vi.fn(async () => ({
      ensureSession: vi.fn(async () => ({})),
      startTurn: vi.fn(() => fakeTurn({ events: (async function* () {})() })),
    }));
    runtimeInternals.collectTurnOutput = vi.fn(
      () => new Promise<string>((resolve) => pendingOutputs.push(resolve)),
    );

    const firstSend = runtime.send("first widget");
    await waitUntil(() => pendingOutputs.length === 1);

    const secondSend = runtime.send("second widget");
    const secondResult = await Promise.race([
      secondSend,
      wait(25).then(() => "still-running" as const),
    ]);

    for (const resolve of pendingOutputs) resolve("first done");
    await Promise.allSettled([firstSend, secondSend]);

    expect(secondResult).not.toBe("still-running");
    expect(secondResult).toMatchObject({
      assistantText: expect.stringContaining("already running"),
    });
    expect(runtimeInternals.beginChangeSession).toHaveBeenCalledOnce();
    expect(runtimeInternals.collectTurnOutput).toHaveBeenCalledOnce();
  });
});

describe("agent runtime GUI shell PATH", () => {
  const originalPath = process.env.PATH;
  const originalAgent = process.env.MENU_SPROUT_AGENT;

  afterEach(() => {
    process.env.PATH = originalPath;
    if (originalAgent === undefined) delete process.env.MENU_SPROUT_AGENT;
    else process.env.MENU_SPROUT_AGENT = originalAgent;
  });

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it("waits for the expanded PATH before starting an agent turn", async () => {
    const shellPath = deferred();
    const runtime = new MenuSproutAgentRuntime("/repo", { agentName: "claude", shellPathReady: shellPath.promise });
    const internals = runtime as unknown as {
      ensureAgentRuntimeCwd: () => Promise<string>;
      beginChangeSession: () => Promise<object>;
    };
    internals.ensureAgentRuntimeCwd = vi.fn(async () => "/repo/extensions");
    internals.beginChangeSession = vi.fn(async () => ({
      startedClean: false,
      snapshot: (message?: string) => ({ startedClean: false, canSave: false, canRollback: false, head: null, message }),
    }));

    const send = runtime.send("build a widget");
    await wait(20);
    expect(internals.ensureAgentRuntimeCwd).not.toHaveBeenCalled();

    shellPath.resolve();
    await send;
    expect(internals.beginChangeSession).toHaveBeenCalledOnce();
  });

  it("re-detects a default agent once the expanded PATH exposes its CLI", async () => {
    delete process.env.MENU_SPROUT_AGENT;
    const shimDir = await mkdtemp(join(tmpdir(), "menu-sprout-shims-"));
    await writeFile(join(shimDir, "codex"), "#!/bin/sh\n", { mode: 0o755 });
    process.env.PATH = "/bin";
    const shellPath = deferred();
    const runtime = new MenuSproutAgentRuntime("/repo", { shellPathReady: shellPath.promise });
    expect(runtime.currentAgent).toBe("claude");

    process.env.PATH = `/bin:${shimDir}`;
    shellPath.resolve();
    await vi.waitFor(() => expect(runtime.currentAgent).toBe("codex"));
  });

  it("keeps an agent the user chose while the PATH was still expanding", async () => {
    delete process.env.MENU_SPROUT_AGENT;
    const shimDir = await mkdtemp(join(tmpdir(), "menu-sprout-shims-"));
    await writeFile(join(shimDir, "codex"), "#!/bin/sh\n", { mode: 0o755 });
    process.env.PATH = "/bin";
    const shellPath = deferred();
    const runtime = new MenuSproutAgentRuntime("/repo", { shellPathReady: shellPath.promise });
    await runtime.setAgent("claude");

    process.env.PATH = `/bin:${shimDir}`;
    shellPath.resolve();
    await shellPath.promise;
    await wait(0);
    expect(runtime.currentAgent).toBe("claude");
  });
});

describe("agent runtime switching", () => {
  function buildRuntime() {
    const runtime = new MenuSproutAgentRuntime("/repo", { agentName: "claude" });
    const internals = runtime as unknown as {
      runtime: { close: ReturnType<typeof vi.fn> } | null;
      handle: object | null;
      activeSession: object | null;
    };
    return { runtime, internals };
  }

  it("reports the configured agent as the current agent", () => {
    const { runtime } = buildRuntime();
    expect(runtime.currentAgent).toBe("claude");
  });

  it("ignores a switch to the same or empty agent", async () => {
    const { runtime, internals } = buildRuntime();
    const close = vi.fn(async () => undefined);
    internals.runtime = { close };
    internals.handle = {};

    await runtime.setAgent("claude");
    await runtime.setAgent("   ");

    expect(close).not.toHaveBeenCalled();
    expect(runtime.currentAgent).toBe("claude");
  });

  it("switches agent and resets the live session with discarded state", async () => {
    const { runtime, internals } = buildRuntime();
    const close = vi.fn(async () => undefined);
    internals.runtime = { close };
    internals.handle = { sessionKey: "menu-sprout-agent-chat" };
    internals.activeSession = { startedClean: true };

    await runtime.setAgent("codex");

    expect(close).toHaveBeenCalledWith({
      handle: { sessionKey: "menu-sprout-agent-chat" },
      reason: "agent-switch",
      discardPersistentState: true,
    });
    expect(runtime.currentAgent).toBe("codex");
    expect(internals.runtime).toBeNull();
    expect(internals.handle).toBeNull();
    expect(internals.activeSession).toBeNull();
  });

  it("switches agent even when no runtime is active yet", async () => {
    const { runtime } = buildRuntime();
    await runtime.setAgent("codex");
    expect(runtime.currentAgent).toBe("codex");
  });

  it("setRegistryOverrides replaces the overrides used to build the next runtime", async () => {
    const runtime = new MenuSproutAgentRuntime("/repo", { agentName: "claude", registryOverrides: { claude: "old" } });
    const internals = runtime as unknown as { registryOverrides: Record<string, string> | undefined };
    expect(internals.registryOverrides).toEqual({ claude: "old" });

    await runtime.setRegistryOverrides({ claude: "old", gemini: "gemini acp" });
    expect(internals.registryOverrides).toEqual({ claude: "old", gemini: "gemini acp" });

    // Empty/undefined collapses to undefined so createAgentRegistry gets no overrides.
    await runtime.setRegistryOverrides({});
    expect(internals.registryOverrides).toBeUndefined();
  });

  it("setRegistryOverrides closes an active runtime without discarding persistent state", async () => {
    const { runtime, internals } = buildRuntime();
    const close = vi.fn(async () => undefined);
    internals.runtime = { close };
    internals.handle = { sessionKey: "menu-sprout-agent-chat" };

    await runtime.setRegistryOverrides({ claude: "updated command" });

    expect(close).toHaveBeenCalledWith({
      handle: { sessionKey: "menu-sprout-agent-chat" },
      reason: "registry-overrides-change",
      discardPersistentState: undefined,
    });
    expect(internals.runtime).toBeNull();
    expect(internals.handle).toBeNull();
  });

  it("setRegistryOverrides keeps the active agent running when only another agent's command changed", async () => {
    const runtime = new MenuSproutAgentRuntime("/repo", { agentName: "claude", registryOverrides: { claude: "claude-adapter" } });
    const internals = runtime as unknown as { runtime: { close: ReturnType<typeof vi.fn> } | null; handle: object | null };
    const close = vi.fn(async () => undefined);
    internals.runtime = { close };
    internals.handle = { sessionKey: "menu-sprout-agent-chat" };

    await runtime.setRegistryOverrides({ claude: "claude-adapter", codex: "codex-adapter --effort high" });

    expect(close).not.toHaveBeenCalled();
    expect(internals.runtime).not.toBeNull();
  });

  it("setRegistryOverrides waits to close the runtime until a pending change session is resolved", async () => {
    const { runtime, internals } = buildRuntime();
    const close = vi.fn(async () => undefined);
    internals.runtime = { close };
    internals.handle = { sessionKey: "menu-sprout-agent-chat" };
    internals.activeSession = {
      canSave: true,
      canRollback: true,
      save: vi.fn(async () => ({ ok: true })),
    };

    await runtime.setRegistryOverrides({ claude: "updated command" });

    expect(close).not.toHaveBeenCalled();

    await runtime.save();

    expect(close).toHaveBeenCalledWith({
      handle: { sessionKey: "menu-sprout-agent-chat" },
      reason: "registry-overrides-change",
      discardPersistentState: undefined,
    });
    expect(internals.runtime).toBeNull();
    expect(internals.handle).toBeNull();
  });
});

describe("agent runtime change-session snapshot", () => {
  function buildRuntime() {
    const runtime = new MenuSproutAgentRuntime("/repo", { agentName: "claude" });
    const internals = runtime as unknown as {
      activeSession: unknown;
      activeTurn: boolean;
      activeTurnInfo: { title: string; startedAt: number } | null;
    };
    return { runtime, internals };
  }

  it("returns null when no change session is open", async () => {
    const { runtime } = buildRuntime();
    expect(await runtime.currentSessionSnapshot()).toBeNull();
  });

  it("returns null when the open session can no longer be saved or rolled back", async () => {
    const { runtime, internals } = buildRuntime();
    const snapshot = vi.fn();
    internals.activeSession = { canSave: false, canRollback: false, snapshot };
    expect(await runtime.currentSessionSnapshot()).toBeNull();
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("returns the active session snapshot, enriched with the diff, so the renderer can re-hydrate", async () => {
    const { runtime, internals } = buildRuntime();
    const snap = { startedClean: true, canSave: true, canRollback: true, head: null, message: "m" };
    const changes = [{ type: "extension", extensionId: "battery", kind: "updated" }];
    internals.activeSession = {
      canSave: true,
      canRollback: true,
      snapshot: vi.fn(() => ({ ...snap })),
      describeChanges: vi.fn(async () => changes),
      hasChanges: vi.fn(async () => true),
    };
    expect(await runtime.currentSessionSnapshot()).toEqual({ ...snap, changes, dirty: true });
  });

  it("does not leave a saveable session open after a no-change turn", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "menu-sprout-runtime-"));
    const runtime = new MenuSproutAgentRuntime(rootDir, { agentName: "claude" });
    const internals = runtime as unknown as {
      activeSession: unknown;
      activeTurn: boolean;
      activeTurnInfo: { title: string; startedAt: number } | null;
    };
    const session = {
      startedClean: true,
      canSave: true,
      canRollback: true,
      snapshot: vi.fn((message?: string) => ({ startedClean: true, canSave: true, canRollback: true, head: "HEAD", message })),
      describeChanges: vi.fn(async () => []),
      hasChanges: vi.fn(async () => false),
      save: vi.fn(async () => ({ ok: true })),
      rollback: vi.fn(async () => ({ ok: true })),
    };
    const sendInternals = runtime as unknown as {
      ensureAgentRuntimeCwd: () => Promise<string>;
      beginChangeSession: () => Promise<unknown>;
      ensureRuntime: () => Promise<unknown>;
      collectTurnOutput: () => Promise<string>;
    };
    sendInternals.ensureAgentRuntimeCwd = vi.fn(async () => join(rootDir, "extensions"));
    sendInternals.beginChangeSession = vi.fn(async () => session);
    sendInternals.ensureRuntime = vi.fn(async () => ({
      ensureSession: vi.fn(async () => ({})),
      startTurn: vi.fn(() => fakeTurn({ events: (async function* () {})() })),
    }));
    sendInternals.collectTurnOutput = vi.fn(async () => "No edits needed.");

    const result = await runtime.send("make no edits");

    expect(result.session?.dirty).toBe(false);
    expect(session.save).toHaveBeenCalledOnce();
    expect(internals.activeSession).toBeNull();
    expect(runtime.agentSwitchDisabledReason).toBeUndefined();
  });

  it("does NOT report a saveable snapshot while a turn is still running", async () => {
    const { runtime, internals } = buildRuntime();
    // The change session is created at the start of a turn, so it is saveable the
    // whole time the build runs - but the renderer must not show Keep/Rollback yet.
    const snapshot = vi.fn();
    internals.activeSession = { canSave: true, canRollback: true, snapshot };
    internals.activeTurn = true;
    expect(await runtime.currentSessionSnapshot()).toBeNull();
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("exposes the running turn so the renderer can restore the run strip", () => {
    const { runtime, internals } = buildRuntime();
    expect(runtime.currentTurn()).toBeNull();
    const info = { title: "add a codex widget", startedAt: 1_700_000_000_000 };
    internals.activeTurnInfo = info;
    expect(runtime.currentTurn()).toBe(info);
  });
});

describe("agent runtime telemetry", () => {
  function recordingTelemetry() {
    const events: Array<{ name: string; fields: Record<string, unknown> }> = [];
    return {
      events,
      client: {
        track: (name: string, fields: Record<string, unknown> = {}) => {
          events.push({ name, fields });
        },
        pageview: () => {},
        close: async () => {},
      },
    };
  }

  type SendInternals = {
    ensureAgentRuntimeCwd: () => Promise<string>;
    beginChangeSession: () => Promise<unknown>;
    ensureRuntime: () => Promise<unknown>;
    collectTurnOutput: () => Promise<string>;
  };

  function stubCleanSend(runtime: MenuSproutAgentRuntime, extensionsDir: string, collect: () => Promise<string>) {
    const internals = runtime as unknown as SendInternals;
    internals.ensureAgentRuntimeCwd = vi.fn(async () => extensionsDir);
    internals.beginChangeSession = vi.fn(async () => ({
      startedClean: true,
      canSave: true,
      canRollback: true,
      snapshot: (message?: string) => ({ startedClean: true, canSave: true, canRollback: true, head: "HEAD", message }),
      save: vi.fn(async () => ({ ok: true })),
      rollback: vi.fn(async () => ({ ok: true })),
    }));
    internals.ensureRuntime = vi.fn(async () => ({
      ensureSession: vi.fn(async () => ({})),
      startTurn: vi.fn(() => fakeTurn({ events: (async function* () {})() })),
    }));
    internals.collectTurnOutput = vi.fn(collect);
  }

  it("reports an agent_switch event when the active agent changes", async () => {
    const telemetry = recordingTelemetry();
    const runtime = new MenuSproutAgentRuntime("/repo", { agentName: "claude", telemetry: telemetry.client });

    await runtime.setAgent("codex");

    expect(telemetry.events).toContainEqual({ name: "agent_switch", fields: { agent: "codex" } });
  });

  it("reports custom instead of user-defined agent names", async () => {
    const telemetry = recordingTelemetry();
    const runtime = new MenuSproutAgentRuntime("/repo", { agentName: "claude", telemetry: telemetry.client });

    await runtime.setAgent("my-private-agent");

    expect(telemetry.events).toContainEqual({ name: "agent_switch", fields: { agent: "custom" } });
  });

  it("does not report agent_switch for a no-op switch", async () => {
    const telemetry = recordingTelemetry();
    const runtime = new MenuSproutAgentRuntime("/repo", { agentName: "claude", telemetry: telemetry.client });

    await runtime.setAgent("claude");

    expect(telemetry.events).toHaveLength(0);
  });

  it("reports a successful agent_turn after a completed send", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "menu-sprout-telemetry-"));
    const extensionsDir = join(rootDir, "extensions-dev");
    const telemetry = recordingTelemetry();
    const runtime = new MenuSproutAgentRuntime(rootDir, {
      agentName: "mock-agent",
      telemetry: telemetry.client,
      paths: {
        extensionsDir,
        agentStateDir: join(rootDir, ".cache", "acp-sessions"),
        snapshotDir: join(rootDir, ".cache", "snapshots"),
      },
    });
    stubCleanSend(runtime, extensionsDir, async () => "built a widget");

    await runtime.send("add a widget");

    expect(telemetry.events).toContainEqual({
      name: "agent_turn",
      fields: { agent: "custom", status: "success" },
    });
  });

  it("reports a failed agent_turn when the turn throws", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "menu-sprout-telemetry-"));
    const extensionsDir = join(rootDir, "extensions-dev");
    const telemetry = recordingTelemetry();
    const runtime = new MenuSproutAgentRuntime(rootDir, {
      agentName: "mock-agent",
      telemetry: telemetry.client,
      paths: {
        extensionsDir,
        agentStateDir: join(rootDir, ".cache", "acp-sessions"),
        snapshotDir: join(rootDir, ".cache", "snapshots"),
      },
    });
    stubCleanSend(runtime, extensionsDir, async () => {
      throw new Error("boom");
    });

    await expect(runtime.send("add a widget")).rejects.toThrow("boom");

    expect(telemetry.events).toContainEqual({
      name: "agent_turn",
      fields: { agent: "custom", status: "error" },
    });
  });

  it("records a failed diagnostic when agent startup throws", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "menu-sprout-startup-log-"));
    const extensionsDir = join(rootDir, "extensions-dev");
    const runtime = new MenuSproutAgentRuntime(rootDir, {
      agentName: "codex",
      paths: {
        extensionsDir,
        agentStateDir: join(rootDir, ".cache", "acp-sessions"),
        snapshotDir: join(rootDir, ".cache", "snapshots"),
      },
    });
    const internals = runtime as unknown as SendInternals;
    internals.ensureAgentRuntimeCwd = vi.fn(async () => extensionsDir);
    internals.beginChangeSession = vi.fn(async () => ({
      startedClean: true,
      canSave: true,
      canRollback: true,
      snapshot: (message?: string) => ({ startedClean: true, canSave: true, canRollback: true, head: "HEAD", message }),
      hasChanges: vi.fn(async () => false),
      save: vi.fn(async () => ({ ok: true })),
      rollback: vi.fn(async () => ({ ok: true })),
    }));
    internals.ensureRuntime = vi.fn(async () => {
      throw new AgentTurnFailedError({
        message: "Codex authentication failed. Sign in and try again.",
        code: "AUTHENTICATION",
        detailCode: "ACP_START_FAILED",
      });
    });

    const error = await runtime.send("add a widget").catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("Codex authentication failed");
    expect(metricsOfFailedTurn(error)).toBeUndefined();

    const logDir = join(rootDir, ".cache", "menu-sprout", "agent-turns");
    const logFiles = await readdir(logDir);
    expect(logFiles).toHaveLength(1);
    const log = JSON.parse(await readFile(join(logDir, logFiles[0]!), "utf8"));
    expect(log).toMatchObject({
      agentName: "codex",
      status: "failed",
      error: {
        message: "Codex authentication failed. Sign in and try again.",
        code: "AUTHENTICATION",
        detailCode: "ACP_START_FAILED",
      },
    });
  });
});

describe("agent runtime session resume recovery", () => {
  function failedTurn(error: {
    message: string;
    code?: string;
    detailCode?: string;
    retryable?: boolean;
  }): AcpRuntimeTurn {
    return {
      requestId: "failed-turn",
      events: (async function* () {})(),
      result: Promise.resolve({ status: "failed", error }),
      cancel: vi.fn(async () => undefined),
      closeStream: vi.fn(async () => undefined),
    };
  }

  it("throws a structured AgentTurnFailedError carrying the acpx detail code", async () => {
    const turn = failedTurn({
      message: "Persistent ACP session 810619c3 could not be resumed: agent does not support session/load",
      code: "RUNTIME",
      detailCode: "SESSION_RESUME_REQUIRED",
      retryable: true,
    });

    await expect(collectAgentTurnOutput(turn, { idleTimeoutMs: 50 })).rejects.toMatchObject({
      name: "AgentTurnFailedError",
      detailCode: "SESSION_RESUME_REQUIRED",
      retryable: true,
    });
  });

  type RecoveryInternals = {
    ensureAgentRuntimeCwd: () => Promise<string>;
    beginChangeSession: () => Promise<unknown>;
    ensureRuntime: () => Promise<unknown>;
    collectTurnOutput: () => Promise<string>;
  };

  async function buildRecoveryRuntime(collectImpls: Array<() => Promise<string>>) {
    const rootDir = await mkdtemp(join(tmpdir(), "menu-sprout-resume-"));
    const extensionsDir = join(rootDir, "extensions-dev");
    const agentStateDir = join(rootDir, ".cache", "acp-sessions");
    const sessionFile = join(agentStateDir, "sessions", "menu-sprout-agent-chat.json");
    await mkdir(join(agentStateDir, "sessions"), { recursive: true });
    await writeFile(sessionFile, JSON.stringify({ stale: true }), "utf8");

    const telemetry: Array<{ name: string; fields: Record<string, unknown> }> = [];
    const runtime = new MenuSproutAgentRuntime(rootDir, {
      agentName: "codex",
      telemetry: {
        track: (name: string, fields: Record<string, unknown> = {}) => telemetry.push({ name, fields }),
        pageview: () => {},
        close: async () => {},
      },
      paths: { extensionsDir, agentStateDir, snapshotDir: join(rootDir, ".cache", "snapshots") },
    });

    const internals = runtime as unknown as RecoveryInternals;
    internals.ensureAgentRuntimeCwd = vi.fn(async () => extensionsDir);
    internals.beginChangeSession = vi.fn(async () => ({
      startedClean: true,
      canSave: true,
      canRollback: true,
      snapshot: (message?: string) => ({ startedClean: true, canSave: true, canRollback: true, head: "HEAD", message }),
      save: vi.fn(async () => ({ ok: true })),
      rollback: vi.fn(async () => ({ ok: true })),
    }));
    internals.ensureRuntime = vi.fn(async () => ({
      ensureSession: vi.fn(async () => ({})),
      startTurn: vi.fn(() => fakeTurn({ events: (async function* () {})() })),
    }));
    const collect = vi.fn();
    for (const impl of collectImpls) collect.mockImplementationOnce(impl);
    internals.collectTurnOutput = collect;

    return { runtime, telemetry, sessionFile, collect };
  }

  it("recovers from SESSION_RESUME_REQUIRED by discarding the persisted session and retrying once", async () => {
    const { runtime, telemetry, sessionFile, collect } = await buildRecoveryRuntime([
      async () => {
        throw new AgentTurnFailedError({
          message: "Persistent ACP session could not be resumed: agent does not support session/load",
          code: "RUNTIME",
          detailCode: "SESSION_RESUME_REQUIRED",
          retryable: true,
        });
      },
      async () => "built the widget after a fresh session",
    ]);

    expect(existsSync(sessionFile)).toBe(true);

    const result = await runtime.send("add a widget");

    expect(result.assistantText).toContain("built the widget after a fresh session");
    expect(collect).toHaveBeenCalledTimes(2);
    // The stale persisted session record is deleted so the retry starts fresh.
    expect(existsSync(sessionFile)).toBe(false);
    // A recovered turn reports success, not error.
    expect(telemetry).toContainEqual({ name: "agent_turn", fields: { agent: "codex", status: "success" } });
    expect(telemetry).not.toContainEqual({ name: "agent_turn", fields: { agent: "codex", status: "error" } });
  });

  it("does not discard the session or retry for an unrelated turn failure", async () => {
    const { runtime, telemetry, sessionFile, collect } = await buildRecoveryRuntime([
      async () => {
        throw new AgentTurnFailedError({ message: "model error", code: "RUNTIME", detailCode: "ACP_TURN_FAILED" });
      },
    ]);

    await expect(runtime.send("add a widget")).rejects.toThrow("model error");

    expect(collect).toHaveBeenCalledTimes(1);
    expect(existsSync(sessionFile)).toBe(true);
    expect(telemetry).toContainEqual({ name: "agent_turn", fields: { agent: "codex", status: "error" } });
  });

  it("does not retry resume recovery when the persisted session cannot be removed", async () => {
    const { runtime, sessionFile, collect } = await buildRecoveryRuntime([
      async () => { throw new AgentTurnFailedError({ detailCode: "SESSION_RESUME_REQUIRED" }); },
      async () => "must not run",
    ]);
    await rm(sessionFile);
    await mkdir(sessionFile);
    await writeFile(join(sessionFile, "private-record"), "old conversation");

    await expect(runtime.send("add a widget")).rejects.toThrow("Could not reset the saved agent conversation.");
    expect(collect).toHaveBeenCalledOnce();
    expect(await readFile(join(sessionFile, "private-record"), "utf8")).toBe("old conversation");
  });
});

describe("agent runtime final reply, cancel, and new conversation", () => {
  function deferredOperation<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
  }

  type TurnInternals = {
    ensureAgentRuntimeCwd: () => Promise<string>;
    beginChangeSession: () => Promise<unknown>;
    ensureRuntime: () => Promise<unknown>;
    stopAgentProcesses: (runtime: unknown) => Promise<void>;
    runtime: unknown;
    handle: unknown;
  };

  function changeSession({ dirty }: { dirty: boolean }) {
    return {
      startedClean: true,
      canSave: true,
      canRollback: true,
      snapshot: vi.fn((message?: string) => ({ startedClean: true, canSave: true, canRollback: true, head: "HEAD", message })),
      describeChanges: vi.fn(async () =>
        dirty ? [{ type: "extension" as const, extensionId: "battery", kind: "updated" as const }] : [],
      ),
      hasChanges: vi.fn(async () => dirty),
      save: vi.fn(async () => ({ ok: true })),
      rollback: vi.fn(async () => ({ ok: true })),
    };
  }

  // A controllable ACP turn: events are pushed by the test, and turn.cancel
  // settles the turn as cancelled the way the bundled adapters do.
  function controllableTurn({ honorCancel = true }: { honorCancel?: boolean } = {}) {
    const queue: AcpRuntimeEvent[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    let settle!: (result: Awaited<AcpRuntimeTurn["result"]>) => void;
    const result = new Promise<Awaited<AcpRuntimeTurn["result"]>>((resolve) => {
      settle = resolve;
    });
    const end = (value: Awaited<AcpRuntimeTurn["result"]>) => {
      ended = true;
      wake?.();
      settle(value);
    };
    const events = (async function* () {
      while (true) {
        while (queue.length) yield queue.shift()!;
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    })();
    const cancel = vi.fn(async () => {
      if (honorCancel) end({ status: "cancelled", stopReason: "cancelled" });
    });
    const closeStream = vi.fn(async () => {
      ended = true;
      wake?.();
    });
    return {
      turn: { requestId: "controllable", events, result, cancel, closeStream } satisfies AcpRuntimeTurn,
      push(event: AcpRuntimeEvent) {
        queue.push(event);
        wake?.();
      },
      complete(stopReason: "end_turn" | "refusal" = "end_turn") {
        end({ status: "completed", stopReason });
      },
      fail(error: { message: string; code?: string }) {
        end({ status: "failed", error } as Awaited<AcpRuntimeTurn["result"]>);
      },
      cancel,
      closeStream,
    };
  }

  async function buildTurnRuntime(
    session: ReturnType<typeof changeSession>,
    turn: AcpRuntimeTurn,
    budget: Pick<MenuSproutAgentRuntimeOptions, "turnLimits" | "agentOptions"> = {},
  ) {
    const rootDir = await mkdtemp(join(tmpdir(), "menu-sprout-cancel-"));
    const extensionsDir = join(rootDir, "extensions-dev");
    const agentStateDir = join(rootDir, ".cache", "acp-sessions");
    const telemetry: Array<{ name: string; fields: Record<string, unknown> }> = [];
    const runtime = new MenuSproutAgentRuntime(rootDir, {
      ...budget,
      agentName: "codex",
      telemetry: {
        track: (name: string, fields: Record<string, unknown> = {}) => telemetry.push({ name, fields }),
        pageview: () => {},
        close: async () => {},
      },
      paths: { extensionsDir, agentStateDir, snapshotDir: join(rootDir, ".cache", "snapshots") },
    });
    const close = vi.fn(async () => undefined);
    const startTurn = vi.fn(() => turn);
    const internals = runtime as unknown as TurnInternals;
    internals.ensureAgentRuntimeCwd = vi.fn(async () => extensionsDir);
    internals.beginChangeSession = vi.fn(async () => session);
    const acpRuntime = {
      ensureSession: vi.fn(async () => ({ sessionKey: "menu-sprout-agent-chat" })),
      startTurn,
      close,
    };
    internals.ensureRuntime = vi.fn(async () => {
      internals.runtime = acpRuntime;
      return acpRuntime;
    });
    return { runtime, telemetry, close, startTurn, agentStateDir, rootDir };
  }

  it("returns only the agent's final message as the reply, not its earlier narration", async () => {
    const control = controllableTurn();
    const { runtime } = await buildTurnRuntime(changeSession({ dirty: false }), control.turn);

    const sent = runtime.send("what can you build?");
    control.push({ type: "text_delta", text: "Let me look at the workspace first.", stream: "output" });
    control.push({ type: "tool_call", text: "Read files", toolCallId: "t1", status: "completed" });
    control.push({ type: "text_delta", text: "thinking quietly", stream: "thought" });
    control.push({ type: "text_delta", text: "Which battery source should the widget read: ", stream: "output" });
    control.push({ type: "text_delta", text: "pmset or ioreg?", stream: "output" });
    control.complete();
    const result = await sent;

    expect(result.reply).toBe("Which battery source should the widget read: pmset or ioreg?");
    expect(result.cancelled).toBeUndefined();
  });

  it("omits the reply when the agent said nothing", async () => {
    const control = controllableTurn();
    const { runtime } = await buildTurnRuntime(changeSession({ dirty: false }), control.turn);

    const sent = runtime.send("tidy up");
    control.push({ type: "tool_call", text: "Edit file", toolCallId: "t1", status: "completed" });
    control.complete();

    expect((await sent).reply).toBeUndefined();
  });

  it.each(["end_turn", "refusal"] as const)("omits pre-tool narration when %s ends without another message", async (stopReason) => {
    const control = controllableTurn();
    const { runtime } = await buildTurnRuntime(changeSession({ dirty: false }), control.turn);
    const sent = runtime.send("tidy up");
    control.push({ type: "text_delta", text: "Let me read the workspace.", stream: "output" });
    control.push({ type: "tool_call", text: "Read files", toolCallId: "t1", status: "completed" });
    control.complete(stopReason);

    expect((await sent).reply).toBeUndefined();
  });

  it.each([false, true])("returns the refusal's bounded final reply and failed status with dirty=%s", async (dirty) => {
    const control = controllableTurn();
    const session = changeSession({ dirty });
    const { runtime, telemetry, rootDir } = await buildTurnRuntime(session, control.turn);
    const sent = runtime.send("make an edit");
    control.push({ type: "text_delta", text: "Let me look first.", stream: "output" });
    control.push({ type: "tool_call", text: "Read files", toolCallId: "t1", status: "completed" });
    const reply = `I cannot complete that request. ${"x".repeat(4_000)}`;
    control.push({ type: "text_delta", text: reply, stream: "output" });
    control.complete("refusal");

    const result = await sent;
    expect(result).toMatchObject({ refused: true, assistantText: "Agent refused the request.", session: { dirty } });
    expect(result.reply).toBe(`${reply.slice(0, 3_997)}...`);
    expect(result.reply).toHaveLength(4_000);
    expect(telemetry).toContainEqual({ name: "agent_turn", fields: { agent: "codex", status: "error" } });
    const logs = join(rootDir, ".cache", "menu-sprout", "agent-turns");
    const files = await readdir(logs);
    const log = JSON.parse(await readFile(join(logs, files[0]!), "utf8"));
    expect(log).toMatchObject({ status: "failed", error: { code: "AGENT_REFUSED", message: "Agent refused the request." } });
    if (dirty) {
      expect(session.save).not.toHaveBeenCalled();
      expect(await runtime.currentSessionSnapshot()).toMatchObject({ dirty: true, canSave: true, canRollback: true });
    } else {
      expect(session.save).toHaveBeenCalledOnce();
      expect(await runtime.currentSessionSnapshot()).toBeNull();
    }
  });

  it("returns only the bounded notice for a refusal without text", async () => {
    const control = controllableTurn();
    const { runtime } = await buildTurnRuntime(changeSession({ dirty: false }), control.turn);
    const sent = runtime.send("make an edit");
    control.complete("refusal");
    const result = await sent;
    expect(result).toMatchObject({ refused: true, assistantText: "Agent refused the request." });
    expect(result.reply).toBeUndefined();
  });

  it("cancels the running ACP turn and leaves partial changes open for Keep or Undo", async () => {
    const control = controllableTurn();
    const session = changeSession({ dirty: true });
    const { runtime, telemetry, startTurn } = await buildTurnRuntime(session, control.turn);

    const sent = runtime.send("add a battery widget");
    await waitUntil(() => startTurn.mock.calls.length === 1);
    control.push({ type: "text_delta", text: "Writing the widget now.", stream: "output" });

    expect(runtime.cancel()).toEqual({ ok: true });
    const result = await sent;

    expect(control.cancel).toHaveBeenCalledOnce();
    expect(result.cancelled).toBe(true);
    expect(result.reply).toBeUndefined();
    expect(result.session).toMatchObject({ canSave: true, canRollback: true, dirty: true });
    expect(session.save).not.toHaveBeenCalled();
    expect(await runtime.currentSessionSnapshot()).toMatchObject({ dirty: true });
    expect(runtime.currentTurn()).toBeNull();
    expect(telemetry).toContainEqual({ name: "agent_turn", fields: { agent: "codex", status: "cancelled" } });
  });

  it("reports measured duration and tool calls, and no tokens when the agent reported none", async () => {
    const control = controllableTurn();
    const { runtime, startTurn } = await buildTurnRuntime(changeSession({ dirty: true }), control.turn);

    const sent = runtime.send("add a battery widget");
    await waitUntil(() => startTurn.mock.calls.length === 1);
    control.push({ type: "tool_call", text: "Read", tag: "tool_call", toolCallId: "t1", status: "in_progress" });
    control.push({ type: "tool_call", text: "Read", tag: "tool_call_update", toolCallId: "t1", status: "completed" });
    control.push({ type: "tool_call", text: "Edit", tag: "tool_call", toolCallId: "t2", status: "in_progress" });
    control.complete();
    const result = await sent;

    expect(result.metrics).toEqual({ durationMs: expect.any(Number), toolCalls: 2 });
    expect(result.metrics).not.toHaveProperty("tokens");
    expect(result.stoppedBy).toBeUndefined();
  });

  it("keeps the measured numbers of a turn that ran and then failed on its error", async () => {
    const control = controllableTurn();
    const { runtime, startTurn } = await buildTurnRuntime(changeSession({ dirty: true }), control.turn);

    const sent = runtime.send("add a battery widget").catch((error: unknown) => error);
    await waitUntil(() => startTurn.mock.calls.length === 1);
    control.push({ type: "tool_call", text: "Read", tag: "tool_call", toolCallId: "t1", status: "in_progress" });
    control.push({ type: "tool_call", text: "Edit", tag: "tool_call", toolCallId: "t2", status: "in_progress" });
    control.fail({ message: "Rate limit reached", code: "RATE_LIMITED" });
    const error = await sent;

    expect(error).toBeInstanceOf(AgentTurnFailedError);
    expect((error as Error).message).toBe("Rate limit reached");
    expect(metricsOfFailedTurn(error)).toEqual({ durationMs: expect.any(Number), toolCalls: 2 });
  });

  it("stops a turn at the tool-call limit through Cancel and keeps partial changes for Keep or Undo", async () => {
    const control = controllableTurn();
    const session = changeSession({ dirty: true });
    const { runtime, telemetry, startTurn } = await buildTurnRuntime(session, control.turn, { turnLimits: { maxToolCalls: 2 } });

    const sent = runtime.send("add a battery widget");
    await waitUntil(() => startTurn.mock.calls.length === 1);
    for (const id of ["t1", "t2", "t3"]) {
      control.push({ type: "tool_call", text: "Bash", tag: "tool_call", toolCallId: id, status: "in_progress" });
    }
    const result = await sent;

    expect(control.cancel).toHaveBeenCalledWith({ reason: "user-cancel" });
    expect(result).toMatchObject({
      assistantText: "The agent turn was stopped at its tool-call limit.",
      stoppedBy: "tool-call-limit",
      metrics: { toolCalls: 3 },
      session: { canSave: true, canRollback: true, dirty: true },
    });
    expect(result.cancelled).toBeUndefined();
    expect(session.save).not.toHaveBeenCalled();
    expect(telemetry).toContainEqual({ name: "agent_turn", fields: { agent: "codex", status: "limit_stopped" } });
  });

  it("stops a turn at the time limit, forcing the agent down if it ignores the stop", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const control = controllableTurn({ honorCancel: false });
      const session = changeSession({ dirty: true });
      const { runtime, startTurn } = await buildTurnRuntime(session, control.turn, { turnLimits: { maxTurnMinutes: 1 } });
      const internals = runtime as unknown as TurnInternals;
      const stopAgentProcesses = vi.fn(async () => undefined);
      internals.stopAgentProcesses = stopAgentProcesses;

      const sent = runtime.send("add a battery widget");
      // vi.waitFor would advance the fake clock; yield to real I/O instead.
      while (startTurn.mock.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(59_999);
      expect(control.cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(control.cancel).toHaveBeenCalledWith({ reason: "user-cancel" });
      await vi.advanceTimersByTimeAsync(AGENT_STOP_GRACE_MS);
      expect(stopAgentProcesses).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(AGENT_STOP_GRACE_MS);
      const result = await sent;

      expect(result.stoppedBy).toBe("time-limit");
      expect(result.metrics?.durationMs).toBeGreaterThanOrEqual(60_000 + 2 * AGENT_STOP_GRACE_MS);
      expect(result.session).toMatchObject({ dirty: true, canSave: true, canRollback: true });
      expect(session.save).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the user's Cancel decide the outcome even if a limit is reached while it stops", async () => {
    const control = controllableTurn({ honorCancel: false });
    const { runtime, startTurn } = await buildTurnRuntime(changeSession({ dirty: true }), control.turn, {
      turnLimits: { maxToolCalls: 1 },
    });

    const sent = runtime.send("add a battery widget");
    await waitUntil(() => startTurn.mock.calls.length === 1);
    runtime.cancel();
    control.push({ type: "tool_call", text: "Bash", tag: "tool_call", toolCallId: "t1" });
    control.push({ type: "tool_call", text: "Bash", tag: "tool_call", toolCallId: "t2" });
    control.push({ type: "tool_call", text: "Bash", tag: "tool_call", toolCallId: "t3" });
    control.complete();
    const result = await sent;

    expect(result.cancelled).toBe(true);
    expect(result.stoppedBy).toBeUndefined();
    expect(result.metrics?.toolCalls).toBe(3);
  });

  it("refuses to start a turn while the active agent's saved effort is not one it can pass", async () => {
    const control = controllableTurn();
    const { runtime, startTurn } = await buildTurnRuntime(changeSession({ dirty: false }), control.turn, {
      agentOptions: { codex: { effort: "turbo" } },
    });

    await expect(runtime.send("add a battery widget")).rejects.toThrow(
      /Codex effort "turbo" is not one Menu Sprout can pass \(.*\)\. Choose another level in Settings, or CLI default\./,
    );
    expect(startTurn).not.toHaveBeenCalled();
    expect(runtime.currentTurn()).toBeNull();

    runtime.setAgentOptions({ codex: { effort: "high" } });
    const sent = runtime.send("add a battery widget");
    await waitUntil(() => startTurn.mock.calls.length === 1);
    control.complete();
    await expect(sent).resolves.toMatchObject({ metrics: { toolCalls: 0 } });
  });

  it("closes the change session cleanly when a cancelled turn changed nothing", async () => {
    const control = controllableTurn();
    const session = changeSession({ dirty: false });
    const { runtime, startTurn } = await buildTurnRuntime(session, control.turn);

    const sent = runtime.send("add a battery widget");
    await waitUntil(() => startTurn.mock.calls.length === 1);
    runtime.cancel();
    const result = await sent;

    expect(result.cancelled).toBe(true);
    expect(result.session?.dirty).toBe(false);
    expect(session.save).toHaveBeenCalledOnce();
    expect(await runtime.currentSessionSnapshot()).toBeNull();
  });

  it.each(["cancel", "timeout"] as const)("awaits %s startup cleanup before admitting another session", async (reason) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
    const control = controllableTurn();
    const session = changeSession({ dirty: false });
    const { runtime, startTurn, agentStateDir } = await buildTurnRuntime(session, control.turn);
    const startup = deferredOperation<object>();
    const closing = deferredOperation<void>();
    const internals = runtime as unknown as TurnInternals;
    const lateHandle = { sessionKey: "menu-sprout-agent-chat" };
    const sessionFile = join(agentStateDir, "sessions", "menu-sprout-agent-chat.json");
    await mkdir(join(agentStateDir, "sessions"), { recursive: true });
    const close = vi.fn(async () => {
      await closing.promise;
      await writeFile(sessionFile, JSON.stringify({ conversation: "closed" }));
    });
    const acpRuntime = {
      ensureSession: vi.fn(async () => {
        const handle = await startup.promise;
        await writeFile(sessionFile, JSON.stringify({ conversation: "old" }));
        return handle;
      }),
      startTurn,
      close,
    };
    internals.ensureRuntime = vi.fn(async () => {
      internals.runtime = acpRuntime;
      return acpRuntime;
    });

    const sent = runtime.send("add a battery widget");
    let settled = false;
    void sent.then(() => { settled = true; });
    await vi.waitFor(() => expect(acpRuntime.ensureSession).toHaveBeenCalledOnce());
    if (reason === "cancel") runtime.cancel();
    else await vi.advanceTimersByTimeAsync(300_000);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(runtime.currentTurn()).not.toBeNull();
    expect(await runtime.currentSessionSnapshot()).toBeNull();
    expect((await runtime.send("another turn")).assistantText).toContain("already running");
    expect(await runtime.newConversation()).toMatchObject({ ok: false });
    expect(await runtime.save()).toMatchObject({ ok: false });
    expect(await runtime.rollback()).toMatchObject({ ok: false });
    startup.resolve(lateHandle);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    closing.resolve();
    const result = await sent;
    expect(internals.runtime).toBeNull();
    expect(await runtime.newConversation()).toEqual({ ok: true });
    if (reason === "cancel") expect(result.cancelled).toBe(true);
    else expect(result.assistantText).toContain("timed out");
    expect(startTurn).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledExactlyOnceWith({ handle: lateHandle, reason });
    const newerRuntime = {
      ensureSession: vi.fn(async () => {
        await writeFile(sessionFile, JSON.stringify({ conversation: "new" }));
        return lateHandle;
      }),
      startTurn,
      close: vi.fn(async () => undefined),
    };
    internals.ensureRuntime = vi.fn(async () => { internals.runtime = newerRuntime; return newerRuntime; });
    control.complete();
    await runtime.send("new turn");
    expect(JSON.parse(await readFile(sessionFile, "utf8"))).toEqual({ conversation: "new" });
    expect(newerRuntime.close).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes an assigned startup handle when cancellation wins before startTurn", async () => {
    const control = controllableTurn();
    const { runtime, close, startTurn } = await buildTurnRuntime(changeSession({ dirty: false }), control.turn);
    const internals = runtime as unknown as TurnInternals;
    let assigned: unknown;
    Object.defineProperty(internals, "handle", {
      configurable: true,
      get: () => assigned,
      set: (value: unknown) => {
        assigned = value;
        if (value) runtime.cancel();
      },
    });

    expect((await runtime.send("make an edit")).cancelled).toBe(true);
    expect(startTurn).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledExactlyOnceWith({ handle: { sessionKey: "menu-sprout-agent-chat" }, reason: "cancel" });
    expect(internals.runtime).toBeNull();
    expect(internals.handle).toBeNull();
  });

  // Steps fake time until the request timeout fires, so the grace period is
  // measured from the stop request itself.
  async function advanceToRequestTimeout(condition: () => boolean) {
    await vi.advanceTimersByTimeAsync(299_000);
    while (!condition()) await vi.advanceTimersByTimeAsync(1);
  }

  it.each([false, true])("force-stops an agent that ignores the stop request after the grace period with timeout=%s", async (timedOut) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const control = controllableTurn({ honorCancel: false });
      const session = changeSession({ dirty: true });
      const { runtime, startTurn } = await buildTurnRuntime(session, control.turn);
      const internals = runtime as unknown as TurnInternals;
      const stopAgentProcesses = vi.fn(async () => undefined);
      internals.stopAgentProcesses = stopAgentProcesses;

      const sent = runtime.send("add a battery widget");
      let settled = false;
      void sent.then(() => { settled = true; });
      await vi.waitFor(() => expect(startTurn).toHaveBeenCalledOnce());
      if (timedOut) await advanceToRequestTimeout(() => control.cancel.mock.calls.length > 0);
      else expect(runtime.cancel()).toEqual({ ok: true });
      expect(control.cancel).toHaveBeenCalledWith({ reason: timedOut ? "timeout" : "user-cancel" });
      await vi.advanceTimersByTimeAsync(AGENT_STOP_GRACE_MS - 1);
      expect(settled).toBe(false);
      expect(stopAgentProcesses).not.toHaveBeenCalled();
      expect(await runtime.currentSessionSnapshot()).toBeNull();
      expect(await runtime.save()).toMatchObject({ ok: false });
      await vi.advanceTimersByTimeAsync(1);
      expect(stopAgentProcesses).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(AGENT_STOP_GRACE_MS);
      const result = await sent;
      if (timedOut) expect(result.assistantText).toContain("timed out");
      else expect(result.cancelled).toBe(true);
      expect(result.session).toMatchObject({ dirty: true, canSave: true, canRollback: true });
      expect(session.save).not.toHaveBeenCalled();
      expect(runtime.currentTurn()).toBeNull();
      expect(await runtime.currentSessionSnapshot()).toMatchObject({ dirty: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["cancel", "timeout"] as const)("force-stops a session startup that outlasts the %s grace period", async (reason) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const control = controllableTurn();
      const session = changeSession({ dirty: true });
      const { runtime, startTurn, close } = await buildTurnRuntime(session, control.turn);
      const internals = runtime as unknown as TurnInternals;
      let failStartup!: (error: Error) => void;
      const acpRuntime = {
        ensureSession: vi.fn(() => new Promise<object>((_resolve, reject) => { failStartup = reject; })),
        startTurn,
        close,
      };
      internals.ensureRuntime = vi.fn(async () => {
        internals.runtime = acpRuntime;
        return acpRuntime;
      });
      const stopAgentProcesses = vi.fn(async () => failStartup(new Error("agent process stopped")));
      internals.stopAgentProcesses = stopAgentProcesses;

      const sent = runtime.send("add a battery widget");
      let settled = false;
      void sent.then(() => { settled = true; });
      await vi.waitFor(() => expect(acpRuntime.ensureSession).toHaveBeenCalledOnce());
      if (reason === "cancel") runtime.cancel();
      else await advanceToRequestTimeout(() => internals.runtime === null);
      await vi.advanceTimersByTimeAsync(AGENT_STOP_GRACE_MS - 1);
      expect(settled).toBe(false);
      expect(stopAgentProcesses).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      const result = await sent;
      expect(stopAgentProcesses).toHaveBeenCalledExactlyOnceWith(acpRuntime);
      if (reason === "cancel") expect(result.cancelled).toBe(true);
      else expect(result.assistantText).toContain("timed out");
      expect(result.session).toMatchObject({ dirty: true });
      expect(startTurn).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(internals.runtime).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishes a conversation reset before a concurrent send writes its session", async () => {
    const control = controllableTurn();
    const { runtime, startTurn, agentStateDir } = await buildTurnRuntime(changeSession({ dirty: false }), control.turn);
    const sessionFile = join(agentStateDir, "sessions", "menu-sprout-agent-chat.json");
    await mkdir(join(agentStateDir, "sessions"), { recursive: true });
    await writeFile(sessionFile, JSON.stringify({ conversation: "old" }));
    const closing = deferredOperation<void>();
    const close = vi.fn(() => closing.promise);
    const internals = runtime as unknown as TurnInternals;
    internals.runtime = { close };
    internals.handle = { sessionKey: "menu-sprout-agent-chat" };
    const ensureSession = vi.fn(async () => {
      expect(existsSync(sessionFile)).toBe(false);
      await writeFile(sessionFile, JSON.stringify({ conversation: "new" }));
      return { sessionKey: "menu-sprout-agent-chat" };
    });
    internals.ensureRuntime = vi.fn(async () => ({ ensureSession, startTurn, close }));

    const reset = runtime.newConversation();
    const sent = runtime.send("new turn");
    await waitUntil(() => close.mock.calls.length === 1);
    expect(ensureSession).not.toHaveBeenCalled();
    expect(startTurn).not.toHaveBeenCalled();
    closing.resolve();
    expect(await reset).toEqual({ ok: true });
    await waitUntil(() => startTurn.mock.calls.length === 1);
    control.complete();
    await sent;
    expect(JSON.parse(await readFile(sessionFile, "utf8"))).toEqual({ conversation: "new" });
  });

  it("refuses to cancel when no turn is running", () => {
    const runtime = new MenuSproutAgentRuntime("/repo", { agentName: "claude" });
    expect(runtime.cancel()).toEqual({ ok: false, reason: expect.stringMatching(/no agent turn/i) });
  });

  it("starts a new conversation by discarding the persisted session", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "menu-sprout-new-conversation-"));
    const agentStateDir = join(rootDir, ".cache", "acp-sessions");
    const sessionFile = join(agentStateDir, "sessions", "menu-sprout-agent-chat.json");
    await mkdir(join(agentStateDir, "sessions"), { recursive: true });
    await writeFile(sessionFile, "{}", "utf8");
    const runtime = new MenuSproutAgentRuntime(rootDir, {
      agentName: "claude",
      paths: { extensionsDir: join(rootDir, "extensions-dev"), agentStateDir, snapshotDir: join(rootDir, "snapshots") },
    });
    const internals = runtime as unknown as { runtime: { close: ReturnType<typeof vi.fn> } | null; handle: object | null };
    const close = vi.fn(async () => undefined);
    internals.runtime = { close };
    internals.handle = { sessionKey: "menu-sprout-agent-chat" };

    expect(await runtime.newConversation()).toEqual({ ok: true });

    expect(close).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "new-conversation", discardPersistentState: true }),
    );
    expect(existsSync(sessionFile)).toBe(false);
    expect(internals.runtime).toBeNull();
  });

  it("returns a sanitized reset failure and allows a retry after deletion becomes possible", async () => {
    const { runtime, agentStateDir } = await buildTurnRuntime(changeSession({ dirty: false }), controllableTurn().turn);
    const sessionFile = join(agentStateDir, "sessions", "menu-sprout-agent-chat.json");
    await mkdir(sessionFile, { recursive: true });
    await writeFile(join(sessionFile, "private-record"), "old conversation");

    expect(await runtime.newConversation()).toEqual({ ok: false, reason: "Could not reset the saved agent conversation." });
    expect(await readFile(join(sessionFile, "private-record"), "utf8")).toBe("old conversation");
    await rm(sessionFile, { recursive: true });
    await writeFile(sessionFile, "{}");
    expect(await runtime.newConversation()).toEqual({ ok: true });
    expect(existsSync(sessionFile)).toBe(false);
    expect(await runtime.newConversation()).toEqual({ ok: true });
  });

  it("refuses a new conversation while a turn runs or a change is pending", async () => {
    const runtime = new MenuSproutAgentRuntime("/repo", { agentName: "claude" });
    const internals = runtime as unknown as { activeTurn: boolean; activeSession: object | null };

    internals.activeTurn = true;
    expect(await runtime.newConversation()).toEqual({ ok: false, reason: expect.stringMatching(/running/i) });

    internals.activeTurn = false;
    internals.activeSession = { canSave: true, canRollback: true };
    expect(await runtime.newConversation()).toEqual({ ok: false, reason: expect.stringMatching(/keep or undo/i) });
  });
});
