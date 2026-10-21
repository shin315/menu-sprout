import { beforeEach, describe, expect, it, vi } from "vitest";

const exposeInMainWorld = vi.fn();
const invoke = vi.fn();
const on = vi.fn();
const removeListener = vi.fn();

vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener },
}));

describe("preload capabilities bridge", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    invoke.mockResolvedValue(undefined);
  });

  it("exposes stable capability list and invoke helpers", async () => {
    await import("../src/preload/index");
    const api = exposeInMainWorld.mock.calls[0]?.[1];

    await api.capabilities.list();
    expect(invoke).toHaveBeenCalledWith("menu-sprout:capabilities:list");

    await api.capabilities.invoke("demo", "ping", { ok: true });
    expect(invoke).toHaveBeenCalledWith("menu-sprout:capabilities:invoke", "demo", "ping", { ok: true });

    await api.widgets.list();
    expect(invoke).toHaveBeenCalledWith("menu-sprout:widgets:list");

    await api.db.query("SELECT 1", [1]);
    expect(invoke).toHaveBeenCalledWith("menu-sprout:db:query", "SELECT 1", [1]);

    await api.db.get("SELECT 1");
    expect(invoke).toHaveBeenCalledWith("menu-sprout:db:get", "SELECT 1", undefined);

    await api.db.run("INSERT INTO t VALUES (?)", ["x"]);
    expect(invoke).toHaveBeenCalledWith("menu-sprout:db:run", "INSERT INTO t VALUES (?)", ["x"]);

    await api.db.exec("CREATE TABLE t (a)");
    expect(invoke).toHaveBeenCalledWith("menu-sprout:db:exec", "CREATE TABLE t (a)");

    await api.popover.setContentHeight(333);
    expect(invoke).toHaveBeenCalledWith("menu-sprout:popover:set-content-height", 333);

    await api.popover.getVisibility();
    expect(invoke).toHaveBeenCalledWith("menu-sprout:popover:get-visibility");

    await api.settings.get();
    expect(invoke).toHaveBeenCalledWith("menu-sprout:settings:get");

    await api.settings.setOpenAtLogin(true);
    expect(invoke).toHaveBeenCalledWith("menu-sprout:settings:set-open-at-login", true);

    await api.settings.setTelemetryEnabled(false);
    expect(invoke).toHaveBeenCalledWith("menu-sprout:settings:set-telemetry-enabled", false);

    await api.app.quit();
    expect(invoke).toHaveBeenCalledWith("menu-sprout:app:quit");
  });

  it("exposes popover visibility events from the main process", async () => {
    await import("../src/preload/index");
    const api = exposeInMainWorld.mock.calls[0]?.[1];
    const listener = vi.fn();

    const unsubscribe = api.popover.onVisibility(listener);
    const handler = on.mock.calls.at(-1)?.[1];
    handler({}, { visible: false });

    expect(on).toHaveBeenCalledWith("menu-sprout:popover:visibility", expect.any(Function));
    expect(listener).toHaveBeenCalledWith({ visible: false });

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith("menu-sprout:popover:visibility", handler);
  });

  it("resolves a sent turn's result and rejects with a failed turn's message and metrics", async () => {
    await import("../src/preload/index");
    const api = exposeInMainWorld.mock.calls[0]?.[1];
    const failed = { message: "Rate limit reached", metrics: { durationMs: 4_000, toolCalls: 7 } };

    invoke.mockResolvedValueOnce({ assistantText: "done", metrics: { durationMs: 1_000, toolCalls: 1 } });
    await expect(api.agent.send("add a widget")).resolves.toEqual({
      assistantText: "done",
      metrics: { durationMs: 1_000, toolCalls: 1 },
    });
    expect(invoke).toHaveBeenCalledWith("menu-sprout:agent:send", "add a widget");

    invoke.mockResolvedValueOnce({ failed });
    await expect(api.agent.send("add a widget")).rejects.toEqual(failed);

    invoke.mockRejectedValueOnce(new Error("Codex authentication failed."));
    await expect(api.agent.send("add a widget")).rejects.toThrow("Codex authentication failed.");
  });

  it("exposes agent cancel and new-conversation commands", async () => {
    await import("../src/preload/index");
    const api = exposeInMainWorld.mock.calls[0]?.[1];

    await api.agent.cancel();
    expect(invoke).toHaveBeenCalledWith("menu-sprout:agent:cancel");

    await api.agent.newConversation();
    expect(invoke).toHaveBeenCalledWith("menu-sprout:agent:new-conversation");
  });

  it("exposes agent status events from the main process", async () => {
    await import("../src/preload/index");
    const api = exposeInMainWorld.mock.calls[0]?.[1];
    const listener = vi.fn();

    const unsubscribe = api.agent.onStatus(listener);
    const handler = on.mock.calls[0]?.[1];
    handler({}, { text: "I built the widget", eventType: "text_delta" });

    expect(on).toHaveBeenCalledWith("menu-sprout:agent:status", expect.any(Function));
    expect(listener).toHaveBeenCalledWith({ text: "I built the widget", eventType: "text_delta" });

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith("menu-sprout:agent:status", handler);
  });
});
