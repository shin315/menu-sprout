import { app as electronApp, ipcMain } from "electron";
import { pathToFileURL } from "node:url";
import type {
  AgentActionResult,
  AgentActiveTurn,
  AgentChatResult,
  AgentSendResponse,
  MenuSproutCustomAgentInput,
  MenuSproutSettings,
  GitActionResult,
  GitSessionSnapshot,
  PopoverVisibilityState,
  RecipeMetadata,
  SqlParams,
  UpdateStatus,
} from "../shared/contracts";
import { getExtensionsDir, getRecipesDir } from "../shared/paths";
import { MenuSproutAgentRuntime, type MenuSproutAgentRuntimeSendOptions } from "./agent-runtime";
import { metricsOfFailedTurn } from "./agent-turn-metrics";
import { createExtensionDatabase, type ExtensionDatabase } from "./extension-database";
import { loadRecipes } from "./recipe-loader";
import { createServerActionRegistry, type ServerActionRegistry } from "./server-action-registry";
import {
  createLayoutModuleRegistry,
  createWidgetModuleRegistry,
  type LayoutModuleRegistry,
  type WidgetModuleRegistry,
} from "./widget-module-registry";

type AgentRuntimeFacade = Pick<
  MenuSproutAgentRuntime,
  "save" | "rollback" | "currentSessionSnapshot" | "currentTurn" | "cancel" | "newConversation"
> & {
  send: (prompt: string, options?: MenuSproutAgentRuntimeSendOptions) => Promise<AgentChatResult>;
};

// `senderId` is the calling webContents id. The popover and the hidden widget
// capture window run the same renderer, so main uses it to keep a capture
// window's size and visibility reports from touching the user's popover.
type PopoverController = {
  setContentHeight: (height: number, senderId?: number) => void | Promise<void>;
  setContentSize: (size: { width: number; height: number }, senderId?: number) => void | Promise<void>;
  getVisibility: (senderId?: number) => PopoverVisibilityState | Promise<PopoverVisibilityState>;
};

type SettingsController = {
  get: () => Promise<MenuSproutSettings> | MenuSproutSettings;
  setOpenAtLogin: (openAtLogin: boolean) => Promise<MenuSproutSettings> | MenuSproutSettings;
  setTheme: (theme: string) => Promise<MenuSproutSettings> | MenuSproutSettings;
  setAppearance: (appearance: string) => Promise<MenuSproutSettings> | MenuSproutSettings;
  setTelemetryEnabled: (enabled: boolean) => Promise<MenuSproutSettings> | MenuSproutSettings;
  setAgent: (agentName: string) => Promise<MenuSproutSettings> | MenuSproutSettings;
  addAgent: (input: MenuSproutCustomAgentInput) => Promise<MenuSproutSettings> | MenuSproutSettings;
  updateAgent: (name: string, input: { label?: string; command: string }) => Promise<MenuSproutSettings> | MenuSproutSettings;
  removeAgent: (name: string) => Promise<MenuSproutSettings> | MenuSproutSettings;
  setAgentModel: (agentName: string, input: { model?: string; effort?: string }) => Promise<MenuSproutSettings> | MenuSproutSettings;
  setTurnLimits: (
    limits: { maxTurnMinutes?: number | null; maxToolCalls?: number | null },
  ) => Promise<MenuSproutSettings> | MenuSproutSettings;
};

type AppController = {
  quit: () => void | Promise<void>;
  getUpdateStatus?: () => UpdateStatus | Promise<UpdateStatus>;
  openReleasePage?: () => void | Promise<void>;
};

type IpcRuntimeOptions = {
  recipesDir?: string;
  database?: ExtensionDatabase;
  layoutModules?: LayoutModuleRegistry;
};

function defaultSettings(): MenuSproutSettings {
  return {
    openAtLogin: false,
    agentName: "",
    agents: [],
    theme: "default",
    appearance: "system",
    telemetry: { enabled: true, source: "default", configured: false },
    agentModels: [],
    turnLimits: {},
  };
}

export function registerIpcHandlers(
  rootDir: string,
  agentRuntime: AgentRuntimeFacade = new MenuSproutAgentRuntime(rootDir),
  serverActions: ServerActionRegistry = createServerActionRegistry({ rootDir, actionRoots: [getExtensionsDir(rootDir)] }),
  widgetModules: WidgetModuleRegistry = createWidgetModuleRegistry(rootDir),
  popover: PopoverController = {
    setContentHeight: () => undefined,
    setContentSize: () => undefined,
    getVisibility: () => ({ visible: false }),
  },
  settings: SettingsController = {
    get: () => defaultSettings(),
    setOpenAtLogin: (openAtLogin) => ({ ...defaultSettings(), openAtLogin }),
    setTheme: (theme) => ({ ...defaultSettings(), theme }),
    setAppearance: () => defaultSettings(),
    setTelemetryEnabled: (enabled) => ({ ...defaultSettings(), telemetry: { enabled, source: "preference", configured: false } }),
    setAgent: (agentName) => ({ ...defaultSettings(), agentName }),
    addAgent: () => defaultSettings(),
    updateAgent: () => defaultSettings(),
    removeAgent: () => defaultSettings(),
    setAgentModel: () => defaultSettings(),
    setTurnLimits: () => defaultSettings(),
  },
  appController: AppController = { quit: () => electronApp.quit() },
  runtimeOptions: IpcRuntimeOptions = {},
) {
  const recipesDir = runtimeOptions.recipesDir ?? getRecipesDir(rootDir);
  const database = runtimeOptions.database ?? createExtensionDatabase(":memory:");
  const layoutModules = runtimeOptions.layoutModules ?? createLayoutModuleRegistry(rootDir);

  ipcMain.handle("menu-sprout:recipes:list", async (): Promise<RecipeMetadata[]> => {
    return loadRecipes(pathToFileURL(`${recipesDir}/`));
  });

  ipcMain.handle("menu-sprout:agent:send", async (event, prompt: string): Promise<AgentSendResponse> => {
    try {
      return await agentRuntime.send(prompt, {
        onStatus: (status) => event.sender.send("menu-sprout:agent:status", status),
      });
    } catch (error) {
      const metrics = metricsOfFailedTurn(error);
      if (!metrics) throw error;
      return { failed: { message: error instanceof Error ? error.message : String(error), metrics } };
    }
  });

  ipcMain.handle("menu-sprout:agent:active-turn", async (): Promise<AgentActiveTurn | null> => {
    return agentRuntime.currentTurn();
  });

  ipcMain.handle("menu-sprout:agent:cancel", async (): Promise<AgentActionResult> => {
    return agentRuntime.cancel();
  });

  ipcMain.handle("menu-sprout:agent:new-conversation", async (): Promise<AgentActionResult> => {
    return agentRuntime.newConversation();
  });

  ipcMain.handle("menu-sprout:git:save", async (_event, message?: string): Promise<GitActionResult> => {
    return agentRuntime.save(message);
  });

  ipcMain.handle("menu-sprout:git:rollback", async (): Promise<GitActionResult> => {
    return agentRuntime.rollback();
  });

  ipcMain.handle("menu-sprout:git:status", async (): Promise<GitSessionSnapshot | null> => {
    return await agentRuntime.currentSessionSnapshot();
  });

  ipcMain.handle("menu-sprout:capabilities:list", async () => {
    return serverActions.list();
  });

  ipcMain.handle("menu-sprout:capabilities:invoke", async (_event, extensionId: string, action: string, input?: unknown) => {
    return serverActions.invoke(extensionId, action, input);
  });

  ipcMain.handle("menu-sprout:db:query", async (_event, sql: string, params?: SqlParams) => {
    return database.query(sql, params);
  });

  ipcMain.handle("menu-sprout:db:get", async (_event, sql: string, params?: SqlParams) => {
    return database.get(sql, params);
  });

  ipcMain.handle("menu-sprout:db:run", async (_event, sql: string, params?: SqlParams) => {
    return database.run(sql, params);
  });

  ipcMain.handle("menu-sprout:db:exec", async (_event, sql: string) => {
    database.exec(sql);
  });

  ipcMain.handle("menu-sprout:widgets:list", async () => {
    return widgetModules.list();
  });

  ipcMain.handle("menu-sprout:layout:get", async () => {
    return layoutModules.get();
  });

  ipcMain.handle("menu-sprout:popover:set-content-height", async (event, height: number) => {
    await popover.setContentHeight(height, event.sender?.id);
    return { ok: true };
  });

  ipcMain.handle("menu-sprout:popover:set-content-size", async (event, size: { width: number; height: number }) => {
    await popover.setContentSize(size, event.sender?.id);
    return { ok: true };
  });

  ipcMain.handle("menu-sprout:popover:get-visibility", async (event) => {
    return popover.getVisibility(event.sender?.id);
  });

  ipcMain.handle("menu-sprout:settings:get", async () => {
    return settings.get();
  });

  ipcMain.handle("menu-sprout:settings:set-open-at-login", async (_event, openAtLogin: boolean) => {
    return settings.setOpenAtLogin(openAtLogin);
  });

  ipcMain.handle("menu-sprout:settings:set-theme", async (_event, theme: string) => {
    return settings.setTheme(theme);
  });

  ipcMain.handle("menu-sprout:settings:set-appearance", async (_event, appearance: string) => {
    return settings.setAppearance(appearance);
  });

  ipcMain.handle("menu-sprout:settings:set-telemetry-enabled", async (_event, enabled: boolean) => {
    return settings.setTelemetryEnabled(enabled === true);
  });

  ipcMain.handle("menu-sprout:settings:set-agent", async (_event, agentName: string) => {
    return settings.setAgent(agentName);
  });

  ipcMain.handle("menu-sprout:settings:add-agent", async (_event, input: MenuSproutCustomAgentInput) => {
    return settings.addAgent(input);
  });

  ipcMain.handle("menu-sprout:settings:update-agent", async (_event, name: string, input: { label?: string; command: string }) => {
    return settings.updateAgent(name, input);
  });

  ipcMain.handle("menu-sprout:settings:remove-agent", async (_event, name: string) => {
    return settings.removeAgent(name);
  });

  ipcMain.handle(
    "menu-sprout:settings:set-agent-model",
    async (_event, agentName: string, input: { model?: string; effort?: string }) => {
      return settings.setAgentModel(agentName, { model: input?.model, effort: input?.effort });
    },
  );

  ipcMain.handle(
    "menu-sprout:settings:set-turn-limits",
    async (_event, limits: { maxTurnMinutes?: number | null; maxToolCalls?: number | null }) => {
      return settings.setTurnLimits({ maxTurnMinutes: limits?.maxTurnMinutes, maxToolCalls: limits?.maxToolCalls });
    },
  );

  ipcMain.handle("menu-sprout:app:quit", async () => {
    await appController.quit();
    return { ok: true };
  });

  ipcMain.handle("menu-sprout:app:get-update-status", async (): Promise<UpdateStatus> => {
    return (
      (await appController.getUpdateStatus?.()) ?? {
        currentVersion: electronApp.getVersion(),
        latestVersion: null,
        updateAvailable: false,
        releaseUrl: null,
      }
    );
  });

  ipcMain.handle("menu-sprout:app:open-release-page", async () => {
    await appController.openReleasePage?.();
    return { ok: true };
  });
}
