import { mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuSproutAgentRuntimeSendOptions } from "../src/main/agent-runtime";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const ipcMain = {
  handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(channel, handler);
  }),
};

vi.mock("electron", () => ({ ipcMain }));

describe("capabilities IPC", () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("lists recipes from the active extension workspace", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "menu-sprout-ipc-recipes-"));
    const recipesDir = join(rootDir, "extensions-dev", "recipes");
    await mkdir(recipesDir, { recursive: true });
    await writeFile(
      join(recipesDir, "daily-standup.html"),
      `<html><head><title>Daily Standup</title></head><body><h1>Fallback</h1></body></html>\n`,
    );
    const { registerIpcHandlers } = await import("../src/main/ipc");
    const agentRuntime = {
      send: vi.fn(),
      save: vi.fn(),
      rollback: vi.fn(),
      currentSessionSnapshot: vi.fn(),
      currentTurn: vi.fn(),
      cancel: vi.fn(),
      newConversation: vi.fn(),
    };

    registerIpcHandlers(rootDir, agentRuntime, undefined, undefined, undefined, undefined, undefined, { recipesDir });

    await expect(handlers.get("menu-sprout:recipes:list")?.({})).resolves.toEqual([
      {
        id: "daily-standup",
        title: "Daily Standup",
        fileName: "daily-standup.html",
        path: join(recipesDir, "daily-standup.html"),
      },
    ]);
  });

  it("registers stable capability list and invoke channels", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc");
    const agentRuntime = {
      send: vi.fn(),
      save: vi.fn(),
      rollback: vi.fn(),
      currentSessionSnapshot: vi.fn(),
      currentTurn: vi.fn(),
      cancel: vi.fn(),
      newConversation: vi.fn(),
    };
    const serverActions = {
      list: vi.fn(async () => [{ id: "demo.ping", extensionId: "demo", action: "ping" }]),
      invoke: vi.fn(async (extensionId: string, action: string, input: unknown) => ({ extensionId, action, input })),
    };

    registerIpcHandlers("/repo", agentRuntime, serverActions);

    await expect(handlers.get("menu-sprout:capabilities:list")?.({})).resolves.toEqual([
      { id: "demo.ping", extensionId: "demo", action: "ping" },
    ]);
    await expect(
      handlers.get("menu-sprout:capabilities:invoke")?.({}, "demo", "ping", { ok: true }),
    ).resolves.toEqual({ extensionId: "demo", action: "ping", input: { ok: true } });
    expect(serverActions.invoke).toHaveBeenCalledWith("demo", "ping", { ok: true });
  });

  it("discovers capability server actions from the dev extension workspace", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "menu-sprout-ipc-capabilities-"));
    const actionDir = join(rootDir, "extensions-dev", "demo");
    await mkdir(actionDir, { recursive: true });
    await writeFile(
      join(actionDir, "server.mjs"),
      `export const actions = { ping: async (input, context) => ({ input, rootDir: context.rootDir }) };\n`,
    );
    const { registerIpcHandlers } = await import("../src/main/ipc");
    const { createServerActionRegistry } = await import("../src/main/server-action-registry");
    const agentRuntime = {
      send: vi.fn(),
      save: vi.fn(),
      rollback: vi.fn(),
      currentSessionSnapshot: vi.fn(),
      currentTurn: vi.fn(),
      cancel: vi.fn(),
      newConversation: vi.fn(),
    };

    registerIpcHandlers(
      rootDir,
      agentRuntime,
      createServerActionRegistry({ rootDir, actionRoots: [join(rootDir, "extensions-dev")] }),
    );

    await expect(handlers.get("menu-sprout:capabilities:list")?.({})).resolves.toEqual([
      { id: "demo.ping", extensionId: "demo", action: "ping" },
    ]);
    await expect(handlers.get("menu-sprout:capabilities:invoke")?.({}, "demo", "ping", { ok: true })).resolves.toEqual({
      input: { ok: true },
      rootDir,
    });
  });

  it("forwards agent runtime status events to the requesting renderer", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc");
    const sender = { send: vi.fn() };
    const agentRuntime = {
      send: vi.fn(async (_prompt: string, options?: MenuSproutAgentRuntimeSendOptions) => {
        await options?.onStatus?.({ text: "I built the widget", eventType: "text_delta" });
        return { assistantText: "done" };
      }),
      save: vi.fn(),
      rollback: vi.fn(),
      currentSessionSnapshot: vi.fn(),
      currentTurn: vi.fn(),
      cancel: vi.fn(),
      newConversation: vi.fn(),
    };

    registerIpcHandlers("/repo", agentRuntime);

    await handlers.get("menu-sprout:agent:send")?.({ sender }, "build a widget");

    expect(agentRuntime.send).toHaveBeenCalledWith("build a widget", { onStatus: expect.any(Function) });
    expect(sender.send).toHaveBeenCalledWith("menu-sprout:agent:status", {
      text: "I built the widget",
      eventType: "text_delta",
    });
  });

  it("returns a failed turn's message and metrics over the send route, and rethrows a failure before any turn", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc");
    const { recordFailedTurnMetrics } = await import("../src/main/agent-turn-metrics");
    const turnError = new Error("Rate limit reached");
    recordFailedTurnMetrics(turnError, { durationMs: 4_000, toolCalls: 7 });
    const agentRuntime = {
      send: vi
        .fn()
        .mockRejectedValueOnce(turnError)
        .mockRejectedValueOnce(new Error("Codex authentication failed.")),
      save: vi.fn(),
      rollback: vi.fn(),
      currentSessionSnapshot: vi.fn(),
      currentTurn: vi.fn(),
      cancel: vi.fn(),
      newConversation: vi.fn(),
    };

    registerIpcHandlers("/repo", agentRuntime);
    const send = handlers.get("menu-sprout:agent:send")!;

    await expect(send({ sender: { send: vi.fn() } }, "add a widget")).resolves.toEqual({
      failed: { message: "Rate limit reached", metrics: { durationMs: 4_000, toolCalls: 7 } },
    });
    await expect(send({ sender: { send: vi.fn() } }, "add a widget")).rejects.toThrow("Codex authentication failed.");
  });

  it("routes Cancel and New conversation through shared agent channels", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc");
    const agentRuntime = {
      send: vi.fn(),
      save: vi.fn(),
      rollback: vi.fn(),
      currentSessionSnapshot: vi.fn(),
      currentTurn: vi.fn(),
      cancel: vi.fn(() => ({ ok: true })),
      newConversation: vi.fn(async () => ({ ok: false, reason: "Keep or Undo the current change first." })),
    };

    registerIpcHandlers("/repo", agentRuntime);

    await expect(handlers.get("menu-sprout:agent:cancel")?.({})).resolves.toEqual({ ok: true });
    expect(agentRuntime.cancel).toHaveBeenCalledOnce();
    await expect(handlers.get("menu-sprout:agent:new-conversation")?.({})).resolves.toEqual({
      ok: false,
      reason: "Keep or Undo the current change first.",
    });
    expect(agentRuntime.newConversation).toHaveBeenCalledOnce();
  });

  it("registers SQL database channels backed by a shared store", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc");
    const { createExtensionDatabase } = await import("../src/main/extension-database");
    const agentRuntime = { send: vi.fn(), save: vi.fn(), rollback: vi.fn(), currentSessionSnapshot: vi.fn(), currentTurn: vi.fn(), cancel: vi.fn(), newConversation: vi.fn() };
    const database = createExtensionDatabase(":memory:");

    registerIpcHandlers("/repo", agentRuntime, undefined, undefined, undefined, undefined, undefined, { database });

    await handlers.get("menu-sprout:db:exec")?.({}, "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)");
    await expect(handlers.get("menu-sprout:db:run")?.({}, "INSERT INTO notes (body) VALUES (?)", ["hi"])).resolves.toEqual({
      changes: 1,
      lastInsertRowid: 1,
    });
    await expect(handlers.get("menu-sprout:db:query")?.({}, "SELECT body FROM notes")).resolves.toEqual([{ body: "hi" }]);
    await expect(handlers.get("menu-sprout:db:get")?.({}, "SELECT body FROM notes WHERE id = ?", [1])).resolves.toEqual({
      body: "hi",
    });
  });

  it("registers a widget module discovery channel", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc");
    const agentRuntime = {
      send: vi.fn(),
      save: vi.fn(),
      rollback: vi.fn(),
      currentSessionSnapshot: vi.fn(),
      currentTurn: vi.fn(),
      cancel: vi.fn(),
      newConversation: vi.fn(),
    };
    const widgetModules = {
      list: vi.fn(async () => [{ id: "cpu-temp.widget", extensionId: "cpu-temp", moduleUrl: "/@fs/cpu-temp/widget.tsx" }]),
    };

    registerIpcHandlers("/repo", agentRuntime, undefined, widgetModules);

    await expect(handlers.get("menu-sprout:widgets:list")?.({})).resolves.toEqual([
      { id: "cpu-temp.widget", extensionId: "cpu-temp", moduleUrl: "/@fs/cpu-temp/widget.tsx" },
    ]);
    expect(widgetModules.list).toHaveBeenCalledOnce();
  });

  it("registers popover state channels", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc");
    const agentRuntime = {
      send: vi.fn(),
      save: vi.fn(),
      rollback: vi.fn(),
      currentSessionSnapshot: vi.fn(),
      currentTurn: vi.fn(),
      cancel: vi.fn(),
      newConversation: vi.fn(),
    };
    const popover = {
      setContentHeight: vi.fn(),
      setContentSize: vi.fn(),
      getVisibility: vi.fn(() => ({ visible: false })),
    };

    registerIpcHandlers("/repo", agentRuntime, undefined, undefined, popover);

    await expect(handlers.get("menu-sprout:popover:set-content-height")?.({}, 333)).resolves.toEqual({ ok: true });
    expect(popover.setContentHeight).toHaveBeenCalledWith(333, undefined);
    await expect(handlers.get("menu-sprout:popover:set-content-size")?.({}, { width: 820, height: 400 })).resolves.toEqual({
      ok: true,
    });
    expect(popover.setContentSize).toHaveBeenCalledWith({ width: 820, height: 400 }, undefined);
    await expect(handlers.get("menu-sprout:popover:get-visibility")?.({})).resolves.toEqual({ visible: false });
  });

  it("tells the popover controller which webContents sent a popover report", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc");
    const agentRuntime = {
      send: vi.fn(),
      save: vi.fn(),
      rollback: vi.fn(),
      currentSessionSnapshot: vi.fn(),
      currentTurn: vi.fn(),
      cancel: vi.fn(),
      newConversation: vi.fn(),
    };
    const popover = {
      setContentHeight: vi.fn(),
      setContentSize: vi.fn(),
      getVisibility: vi.fn(() => ({ visible: true })),
    };

    registerIpcHandlers("/repo", agentRuntime, undefined, undefined, popover);
    const event = { sender: { id: 7 } };

    await handlers.get("menu-sprout:popover:set-content-height")?.(event, 333);
    await handlers.get("menu-sprout:popover:set-content-size")?.(event, { width: 820, height: 400 });
    await handlers.get("menu-sprout:popover:get-visibility")?.(event);

    expect(popover.setContentHeight).toHaveBeenCalledWith(333, 7);
    expect(popover.setContentSize).toHaveBeenCalledWith({ width: 820, height: 400 }, 7);
    expect(popover.getVisibility).toHaveBeenCalledWith(7);
  });

  it("registers an app quit channel", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc");
    const agentRuntime = {
      send: vi.fn(),
      save: vi.fn(),
      rollback: vi.fn(),
      currentSessionSnapshot: vi.fn(),
      currentTurn: vi.fn(),
      cancel: vi.fn(),
      newConversation: vi.fn(),
    };
    const appController = { quit: vi.fn() };

    registerIpcHandlers("/repo", agentRuntime, undefined, undefined, undefined, undefined, appController);

    await expect(handlers.get("menu-sprout:app:quit")?.({})).resolves.toEqual({ ok: true });
    expect(appController.quit).toHaveBeenCalledOnce();
  });

  it("registers app update-status and open-release-page channels", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc");
    const agentRuntime = {
      send: vi.fn(),
      save: vi.fn(),
      rollback: vi.fn(),
      currentSessionSnapshot: vi.fn(),
      currentTurn: vi.fn(),
      cancel: vi.fn(),
      newConversation: vi.fn(),
    };
    const status = {
      currentVersion: "0.1.7",
      latestVersion: "0.2.0",
      updateAvailable: true,
      releaseUrl: "https://github.com/shin315/menu-sprout/releases/tag/v0.2.0",
    };
    const appController = {
      quit: vi.fn(),
      getUpdateStatus: vi.fn(async () => status),
      openReleasePage: vi.fn(),
    };

    registerIpcHandlers("/repo", agentRuntime, undefined, undefined, undefined, undefined, appController);

    await expect(handlers.get("menu-sprout:app:get-update-status")?.({})).resolves.toEqual(status);
    expect(appController.getUpdateStatus).toHaveBeenCalledOnce();
    await expect(handlers.get("menu-sprout:app:open-release-page")?.({})).resolves.toEqual({ ok: true });
    expect(appController.openReleasePage).toHaveBeenCalledOnce();
  });

  it("registers settings channels for open-at-login", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc");
    const agentRuntime = {
      send: vi.fn(),
      save: vi.fn(),
      rollback: vi.fn(),
      currentSessionSnapshot: vi.fn(),
      currentTurn: vi.fn(),
      cancel: vi.fn(),
      newConversation: vi.fn(),
    };
    const settings = {
      get: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setOpenAtLogin: vi.fn(async (openAtLogin: boolean) => ({ openAtLogin, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setTheme: vi.fn(async (theme: string) => ({ openAtLogin: false, agentName: "claude", agents: [], theme, appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setAppearance: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "dark" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setTelemetryEnabled: vi.fn(async (enabled: boolean) => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled, source: "preference" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setAgent: vi.fn(async (agentName: string) => ({ openAtLogin: false, agentName, agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      addAgent: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      updateAgent: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      removeAgent: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setAgentModel: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setTurnLimits: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
    };

    registerIpcHandlers("/repo", agentRuntime, undefined, undefined, undefined, settings);

    await expect(handlers.get("menu-sprout:settings:get")?.({})).resolves.toEqual({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system", telemetry: { enabled: true, source: "default", configured: false }, agentModels: [], turnLimits: {} });
    await expect(handlers.get("menu-sprout:settings:set-open-at-login")?.({}, true)).resolves.toEqual({ openAtLogin: true, agentName: "claude", agents: [], theme: "default", appearance: "system", telemetry: { enabled: true, source: "default", configured: false }, agentModels: [], turnLimits: {} });
    expect(settings.setOpenAtLogin).toHaveBeenCalledWith(true);
    await expect(handlers.get("menu-sprout:settings:set-theme")?.({}, "nature-wood")).resolves.toEqual({ openAtLogin: false, agentName: "claude", agents: [], theme: "nature-wood", appearance: "system", telemetry: { enabled: true, source: "default", configured: false }, agentModels: [], turnLimits: {} });
    expect(settings.setTheme).toHaveBeenCalledWith("nature-wood");
    await expect(handlers.get("menu-sprout:settings:set-appearance")?.({}, "dark")).resolves.toEqual({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "dark", telemetry: { enabled: true, source: "default", configured: false }, agentModels: [], turnLimits: {} });
    expect(settings.setAppearance).toHaveBeenCalledWith("dark");
    await expect(handlers.get("menu-sprout:settings:set-agent")?.({}, "codex")).resolves.toEqual({ openAtLogin: false, agentName: "codex", agents: [], theme: "default", appearance: "system", telemetry: { enabled: true, source: "default", configured: false }, agentModels: [], turnLimits: {} });
    expect(settings.setAgent).toHaveBeenCalledWith("codex");
    await expect(handlers.get("menu-sprout:settings:set-telemetry-enabled")?.({}, false)).resolves.toMatchObject({
      telemetry: { enabled: false, source: "preference" },
    });
    expect(settings.setTelemetryEnabled).toHaveBeenCalledWith(false);
    // Only a literal true turns telemetry on; anything else from the renderer is treated as off.
    await handlers.get("menu-sprout:settings:set-telemetry-enabled")?.({}, "yes");
    expect(settings.setTelemetryEnabled).toHaveBeenLastCalledWith(false);
  });

  it("registers settings channels for custom agent management", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc");
    const agentRuntime = { send: vi.fn(), save: vi.fn(), rollback: vi.fn(), currentSessionSnapshot: vi.fn(), currentTurn: vi.fn(), cancel: vi.fn(), newConversation: vi.fn() };
    const result = { openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} };
    const settings = {
      get: vi.fn(async () => result),
      setOpenAtLogin: vi.fn(async () => result),
      setTheme: vi.fn(async () => result),
      setAppearance: vi.fn(async () => result),
      setTelemetryEnabled: vi.fn(async () => result),
      setAgent: vi.fn(async () => result),
      addAgent: vi.fn(async () => result),
      updateAgent: vi.fn(async () => result),
      removeAgent: vi.fn(async () => result),
      setAgentModel: vi.fn(async () => result),
      setTurnLimits: vi.fn(async () => result),
    };

    registerIpcHandlers("/repo", agentRuntime, undefined, undefined, undefined, settings);

    const input = { name: "gemini", label: "Gemini", command: "gemini acp" };
    await expect(handlers.get("menu-sprout:settings:add-agent")?.({}, input)).resolves.toEqual(result);
    expect(settings.addAgent).toHaveBeenCalledWith(input);

    await expect(handlers.get("menu-sprout:settings:update-agent")?.({}, "gemini", { command: "gemini acp --beta" })).resolves.toEqual(result);
    expect(settings.updateAgent).toHaveBeenCalledWith("gemini", { command: "gemini acp --beta" });

    await expect(handlers.get("menu-sprout:settings:remove-agent")?.({}, "gemini")).resolves.toEqual(result);
    expect(settings.removeAgent).toHaveBeenCalledWith("gemini");
  });

  it("registers settings channels for agent model, effort, and turn limits", async () => {
    const { registerIpcHandlers } = await import("../src/main/ipc");
    const agentRuntime = { send: vi.fn(), save: vi.fn(), rollback: vi.fn(), currentSessionSnapshot: vi.fn(), currentTurn: vi.fn(), cancel: vi.fn(), newConversation: vi.fn() };
    const result = { openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: { maxToolCalls: 25 } };
    const settings = {
      get: vi.fn(async () => result),
      setOpenAtLogin: vi.fn(async () => result),
      setTheme: vi.fn(async () => result),
      setAppearance: vi.fn(async () => result),
      setTelemetryEnabled: vi.fn(async () => result),
      setAgent: vi.fn(async () => result),
      addAgent: vi.fn(async () => result),
      updateAgent: vi.fn(async () => result),
      removeAgent: vi.fn(async () => result),
      setAgentModel: vi.fn(async () => result),
      setTurnLimits: vi.fn(async () => result),
    };

    registerIpcHandlers("/repo", agentRuntime, undefined, undefined, undefined, settings);

    await expect(
      handlers.get("menu-sprout:settings:set-agent-model")?.({}, "codex", { model: "gpt-5.5", effort: "high", extra: "dropped" }),
    ).resolves.toEqual(result);
    expect(settings.setAgentModel).toHaveBeenCalledWith("codex", { model: "gpt-5.5", effort: "high" });

    await expect(
      handlers.get("menu-sprout:settings:set-turn-limits")?.({}, { maxTurnMinutes: null, maxToolCalls: 25, extra: 1 }),
    ).resolves.toEqual(result);
    expect(settings.setTurnLimits).toHaveBeenCalledWith({ maxTurnMinutes: null, maxToolCalls: 25 });
  });
});
