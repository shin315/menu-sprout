// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/renderer/App";
import type { AgentChatResult, MenuSproutApi } from "../src/shared/contracts";

function installMenuSproutApi(overrides: Partial<MenuSproutApi> = {}) {
  const baseApi: MenuSproutApi = {
    recipes: {
      list: vi.fn(async () => []),
    },
    git: {
      save: vi.fn(async () => ({ ok: true, commit: "abcdef123456" })),
      rollback: vi.fn(async () => ({ ok: true })),
      status: vi.fn(async () => null),
    },
    agent: {
      send: vi.fn(async (): Promise<AgentChatResult> => ({
        assistantText: "Added a CPU temperature widget",
        session: {
          startedClean: true,
          canSave: true,
          canRollback: true,
          head: "abc123",
          message: "Review the generated repo changes, then Save or Rollback.",
          dirty: true,
          changes: [{ type: "extension", extensionId: "cpu-temp", kind: "created" }],
        },
      })),
      onStatus: vi.fn(() => () => undefined),
      getActiveTurn: vi.fn(async () => null),
      cancel: vi.fn(async () => ({ ok: true })),
      newConversation: vi.fn(async () => ({ ok: true })),
    },
    capabilities: {
      list: vi.fn(async () => []),
      invoke: vi.fn(async () => undefined) as MenuSproutApi["capabilities"]["invoke"],
    },
    db: {
      query: vi.fn(async () => []),
      get: vi.fn(async () => undefined),
      run: vi.fn(async () => ({ changes: 0, lastInsertRowid: 0 })),
      exec: vi.fn(async () => undefined),
    },
    widgets: {
      list: vi.fn(async () => []),
    },
    background: { onUpdate: vi.fn(() => () => undefined) },
    layout: { get: vi.fn(async () => null) },
    popover: {
      setContentHeight: vi.fn(async () => ({ ok: true })),
      setContentSize: vi.fn(async () => ({ ok: true })),
      getVisibility: vi.fn(async () => ({ visible: true })),
      onVisibility: vi.fn(() => () => undefined),
    },
    settings: {
      get: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setOpenAtLogin: vi.fn(async (openAtLogin: boolean) => ({ openAtLogin, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setTheme: vi.fn(async (theme: string) => ({ openAtLogin: false, agentName: "claude", agents: [], theme, appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setAppearance: vi.fn(async (appearance: "light" | "dark" | "system") => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setTelemetryEnabled: vi.fn(async (enabled: boolean) => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled, source: "preference" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setAgent: vi.fn(async (agentName: string) => ({ openAtLogin: false, agentName, agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      addAgent: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      updateAgent: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      removeAgent: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setAgentModel: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setTurnLimits: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
    },
    app: {
      quit: vi.fn(async () => ({ ok: true })),
      getUpdateStatus: vi.fn(async () => ({ currentVersion: "0.0.0", latestVersion: null, updateAvailable: false, releaseUrl: null })),
      openReleasePage: vi.fn(async () => ({ ok: true })),
    },
  };

  const api: MenuSproutApi = {
    ...baseApi,
    ...overrides,
    widgets: overrides.widgets ?? baseApi.widgets,
    popover: overrides.popover ?? baseApi.popover,
    settings: overrides.settings ?? baseApi.settings,
    app: overrides.app ?? baseApi.app,
  };

  window.menuSprout = api;
  return api;
}

describe("Monochrome Lab renderer", () => {
  afterEach(() => {
    cleanup();
    delete window.menuSprout;
    vi.restoreAllMocks();
  });

  it("renders a tray popover surface instead of a chat dashboard", () => {
    installMenuSproutApi();

    render(<App />);

    expect(screen.getByRole("main", { name: "menu_sprout tray popover" })).toBeTruthy();
    expect(
      screen.getByText((_, element) => element?.classList.contains("mark") === true && element.textContent === "menu_sprout"),
    ).toBeTruthy();
    expect(screen.getByPlaceholderText("talk to the sprout")).toBeTruthy();
    expect(screen.queryByLabelText("Agent chat")).toBeNull();
    expect(screen.queryByText("dev-mode menu bar")).toBeNull();
    expect(screen.queryByText("live repo")).toBeNull();
    expect(screen.queryByText(/Save|Rollback|git|commit|files/i)).toBeNull();
  });

  it("uses a RunStrip while the agent works and a Keep/Undo SessionBar after", async () => {
    let finishRun: (result: AgentChatResult) => void = () => undefined;
    const api = installMenuSproutApi({
      agent: {
        send: vi.fn(
          () =>
            new Promise<AgentChatResult>((resolve) => {
              finishRun = resolve;
            }),
        ),
        onStatus: vi.fn(() => () => undefined),
      getActiveTurn: vi.fn(async () => null),
      cancel: vi.fn(async () => ({ ok: true })),
      newConversation: vi.fn(async () => ({ ok: true })),
      },
    });

    render(<App />);

    fireEvent.change(screen.getByPlaceholderText("talk to the sprout"), {
      target: { value: "add a cpu temperature widget" },
    });
    fireEvent.click(screen.getByRole("button", { name: "send" }));

    expect(api.agent.send).toHaveBeenCalledWith("add a cpu temperature widget");
    expect(screen.getByText("› add a cpu temperature widget")).toBeTruthy();
    expect(screen.getByText("Working...")).toBeTruthy();
    expect(screen.queryByPlaceholderText("agent working")).toBeNull();

    finishRun({
      assistantText: "Added a CPU temperature widget",
      session: {
        startedClean: true,
        canSave: true,
        canRollback: true,
        head: "abc123",
        message: "Review the generated repo changes, then Save or Rollback.",
        dirty: true,
        changes: [{ type: "extension", extensionId: "cpu-temp", kind: "created" }],
      },
    });

    // The Keep/Rollback label is derived from the diff, not the agent's prose.
    await screen.findByText("Added the cpu-temp extension");

    expect(screen.getByRole("button", { name: "Keep" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(screen.queryByText(/Save|Rollback|git|commit|files/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Keep" }));

    await waitFor(() => expect(api.git.save).toHaveBeenCalledOnce());
  });

  it("refuses a second run until the current change is kept or undone", async () => {
    const api = installMenuSproutApi();

    render(<App />);

    fireEvent.change(screen.getByPlaceholderText("talk to the sprout"), {
      target: { value: "add a battery widget" },
    });
    fireEvent.click(screen.getByRole("button", { name: "send" }));

    await screen.findByText("Added the cpu-temp extension");

    fireEvent.change(screen.getByPlaceholderText("talk to the sprout"), {
      target: { value: "add weather" },
    });
    fireEvent.click(screen.getByRole("button", { name: "send" }));

    expect(api.agent.send).toHaveBeenCalledOnce();
    expect(screen.getByText("Finish this change first")).toBeTruthy();
    expect(screen.getByText("keep or undo before asking again")).toBeTruthy();
  });
});
