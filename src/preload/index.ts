import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentRuntimeStatus,
  AgentSendResponse,
  MenuSproutApi,
  MenuSproutCustomAgentInput,
  BackgroundTaskUpdate,
  PopoverVisibilityState,
  SqlParams,
} from "../shared/contracts";

const api: MenuSproutApi = {
  recipes: {
    list: () => ipcRenderer.invoke("menu-sprout:recipes:list"),
  },
  git: {
    save: (message?: string) => ipcRenderer.invoke("menu-sprout:git:save", message),
    rollback: () => ipcRenderer.invoke("menu-sprout:git:rollback"),
    status: () => ipcRenderer.invoke("menu-sprout:git:status"),
  },
  agent: {
    send: async (prompt: string) => {
      const response: AgentSendResponse = await ipcRenderer.invoke("menu-sprout:agent:send", prompt);
      if ("failed" in response) throw response.failed;
      return response;
    },
    onStatus: (listener: (status: AgentRuntimeStatus) => void) => {
      const handler = (_event: unknown, status: AgentRuntimeStatus) => listener(status);
      ipcRenderer.on("menu-sprout:agent:status", handler);
      return () => ipcRenderer.removeListener("menu-sprout:agent:status", handler);
    },
    getActiveTurn: () => ipcRenderer.invoke("menu-sprout:agent:active-turn"),
    cancel: () => ipcRenderer.invoke("menu-sprout:agent:cancel"),
    newConversation: () => ipcRenderer.invoke("menu-sprout:agent:new-conversation"),
  },
  capabilities: {
    list: () => ipcRenderer.invoke("menu-sprout:capabilities:list"),
    invoke: (extensionId: string, action: string, input?: unknown) =>
      ipcRenderer.invoke("menu-sprout:capabilities:invoke", extensionId, action, input),
  },
  db: {
    query: (sql: string, params?: SqlParams) => ipcRenderer.invoke("menu-sprout:db:query", sql, params),
    get: (sql: string, params?: SqlParams) => ipcRenderer.invoke("menu-sprout:db:get", sql, params),
    run: (sql: string, params?: SqlParams) => ipcRenderer.invoke("menu-sprout:db:run", sql, params),
    exec: (sql: string) => ipcRenderer.invoke("menu-sprout:db:exec", sql),
  },
  widgets: {
    list: () => ipcRenderer.invoke("menu-sprout:widgets:list"),
  },
  layout: {
    get: () => ipcRenderer.invoke("menu-sprout:layout:get"),
  },
  background: {
    onUpdate: (listener: (event: BackgroundTaskUpdate) => void) => {
      const handler = (_event: unknown, update: BackgroundTaskUpdate) => listener(update);
      ipcRenderer.on("menu-sprout:background:update", handler);
      return () => ipcRenderer.removeListener("menu-sprout:background:update", handler);
    },
  },
  popover: {
    setContentHeight: (height: number) => ipcRenderer.invoke("menu-sprout:popover:set-content-height", height),
    setContentSize: (size: { width: number; height: number }) =>
      ipcRenderer.invoke("menu-sprout:popover:set-content-size", size),
    getVisibility: () => ipcRenderer.invoke("menu-sprout:popover:get-visibility"),
    onVisibility: (listener: (state: PopoverVisibilityState) => void) => {
      const handler = (_event: unknown, state: PopoverVisibilityState) => listener(state);
      ipcRenderer.on("menu-sprout:popover:visibility", handler);
      return () => ipcRenderer.removeListener("menu-sprout:popover:visibility", handler);
    },
  },
  settings: {
    get: () => ipcRenderer.invoke("menu-sprout:settings:get"),
    setOpenAtLogin: (openAtLogin: boolean) => ipcRenderer.invoke("menu-sprout:settings:set-open-at-login", openAtLogin),
    setTheme: (theme: string) => ipcRenderer.invoke("menu-sprout:settings:set-theme", theme),
    setAppearance: (appearance: "light" | "dark" | "system") => ipcRenderer.invoke("menu-sprout:settings:set-appearance", appearance),
    setTelemetryEnabled: (enabled: boolean) => ipcRenderer.invoke("menu-sprout:settings:set-telemetry-enabled", enabled),
    setAgent: (agentName: string) => ipcRenderer.invoke("menu-sprout:settings:set-agent", agentName),
    addAgent: (input: MenuSproutCustomAgentInput) => ipcRenderer.invoke("menu-sprout:settings:add-agent", input),
    updateAgent: (name: string, input: { label?: string; command: string }) =>
      ipcRenderer.invoke("menu-sprout:settings:update-agent", name, input),
    removeAgent: (name: string) => ipcRenderer.invoke("menu-sprout:settings:remove-agent", name),
    setAgentModel: (agentName: string, input: { model?: string; effort?: string }) =>
      ipcRenderer.invoke("menu-sprout:settings:set-agent-model", agentName, input),
    setTurnLimits: (limits: { maxTurnMinutes?: number | null; maxToolCalls?: number | null }) =>
      ipcRenderer.invoke("menu-sprout:settings:set-turn-limits", limits),
  },
  app: {
    quit: () => ipcRenderer.invoke("menu-sprout:app:quit"),
    getUpdateStatus: () => ipcRenderer.invoke("menu-sprout:app:get-update-status"),
    openReleasePage: () => ipcRenderer.invoke("menu-sprout:app:open-release-page"),
  },
};

contextBridge.exposeInMainWorld("menuSprout", api);
