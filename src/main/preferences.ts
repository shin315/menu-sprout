import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isAppearanceMode, isThemeId, type AppearanceMode, type ThemeId } from "../shared/themes";
import {
  normalizeAgentModelOptions,
  normalizeTurnLimits,
  type AgentModelOptions,
  type AgentModelOptionsMap,
  type AgentTurnLimits,
  type BuiltInAgentOptionName,
} from "../shared/agent-options";

export type MenuSproutPreferences = {
  openAtLogin: boolean;
  /** Persisted embedded-agent choice; absent until the user picks one. */
  agentName?: string;
  /** Persisted UI theme; absent until the user picks a known one. */
  theme?: ThemeId;
  /** Persisted appearance; absent until the user picks one. */
  appearance?: AppearanceMode;
  /** Persisted privacy switch; absent until the user flips it, so MENU_SPROUT_TELEMETRY still applies. */
  telemetryEnabled?: boolean;
  /** Per built-in agent model and effort; an absent field is CLI default. */
  agentModels?: AgentModelOptionsMap;
  /** Optional per-turn limits; absent fields are off. */
  turnLimits?: AgentTurnLimits;
};

type LoginItemApp = {
  setLoginItemSettings: (settings: { openAtLogin: boolean }) => void;
};

export type PreferencesService = {
  get: () => Promise<MenuSproutPreferences>;
  setOpenAtLogin: (openAtLogin: boolean) => Promise<MenuSproutPreferences>;
  setAgent: (agentName: string) => Promise<MenuSproutPreferences>;
  setTheme: (theme: string) => Promise<MenuSproutPreferences>;
  setAppearance: (appearance: string) => Promise<MenuSproutPreferences>;
  setTelemetryEnabled: (enabled: boolean) => Promise<MenuSproutPreferences>;
  /** Saves already-validated options for one built-in agent; empty options mean CLI default. */
  setAgentModel: (agentName: BuiltInAgentOptionName, options: AgentModelOptions) => Promise<MenuSproutPreferences>;
  /** Saves already-validated per-turn limits. */
  setTurnLimits: (limits: AgentTurnLimits) => Promise<MenuSproutPreferences>;
  apply: () => Promise<MenuSproutPreferences>;
};

type CreatePreferencesServiceOptions = {
  userDataDir: string;
  app: LoginItemApp;
  defaultOpenAtLogin?: boolean;
  allowOpenAtLogin?: boolean;
};

export function createPreferencesService({
  userDataDir,
  app,
  defaultOpenAtLogin = true,
  allowOpenAtLogin = true,
}: CreatePreferencesServiceOptions): PreferencesService {
  const filePath = join(userDataDir, "preferences.json");

  function normalizePreferences(
    preferences: Omit<MenuSproutPreferences, "theme" | "appearance" | "agentModels" | "turnLimits"> & {
      theme?: string;
      appearance?: string;
      agentModels?: unknown;
      turnLimits?: unknown;
    },
  ): MenuSproutPreferences {
    const agentName = preferences.agentName?.trim();
    const agentModels = normalizeAgentModelOptions(preferences.agentModels);
    const turnLimits = normalizeTurnLimits(preferences.turnLimits);
    return {
      openAtLogin: allowOpenAtLogin && preferences.openAtLogin,
      ...(agentName ? { agentName } : {}),
      ...(isThemeId(preferences.theme) ? { theme: preferences.theme } : {}),
      ...(isAppearanceMode(preferences.appearance) ? { appearance: preferences.appearance } : {}),
      ...(typeof preferences.telemetryEnabled === "boolean" ? { telemetryEnabled: preferences.telemetryEnabled } : {}),
      ...(agentModels ? { agentModels } : {}),
      ...(turnLimits ? { turnLimits } : {}),
    };
  }

  function applyLoginItemSettings(preferences: MenuSproutPreferences): void {
    if (!allowOpenAtLogin) return;
    app.setLoginItemSettings({ openAtLogin: preferences.openAtLogin });
  }

  async function readPreferences(): Promise<MenuSproutPreferences> {
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as Partial<MenuSproutPreferences>;
      return normalizePreferences({
        openAtLogin: parsed.openAtLogin ?? defaultOpenAtLogin,
        agentName: parsed.agentName,
        theme: parsed.theme,
        appearance: parsed.appearance,
        telemetryEnabled: parsed.telemetryEnabled,
        agentModels: parsed.agentModels,
        turnLimits: parsed.turnLimits,
      });
    } catch {
      return normalizePreferences({ openAtLogin: defaultOpenAtLogin });
    }
  }

  async function writePreferences(preferences: MenuSproutPreferences): Promise<MenuSproutPreferences> {
    await mkdir(dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(preferences, null, 2)}\n`, { flag: "wx" });
      await rename(tempPath, filePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
    return preferences;
  }

  let operationQueue = Promise.resolve();

  function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = operationQueue.then(operation);
    operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    get: () => serialize(readPreferences),
    setOpenAtLogin(openAtLogin) {
      return serialize(async () => {
        const current = await readPreferences();
        const preferences = await writePreferences(normalizePreferences({ ...current, openAtLogin }));
        applyLoginItemSettings(preferences);
        return preferences;
      });
    },
    setAgent(agentName) {
      return serialize(async () => {
        const current = await readPreferences();
        return writePreferences(normalizePreferences({ ...current, agentName }));
      });
    },
    setTheme(theme) {
      return serialize(async () => {
        const current = await readPreferences();
        return writePreferences(normalizePreferences({ ...current, theme }));
      });
    },
    setAppearance(appearance) {
      return serialize(async () => {
        const current = await readPreferences();
        return writePreferences(normalizePreferences({ ...current, appearance }));
      });
    },
    setTelemetryEnabled(telemetryEnabled) {
      return serialize(async () => {
        const current = await readPreferences();
        return writePreferences(normalizePreferences({ ...current, telemetryEnabled }));
      });
    },
    setAgentModel(agentName, options) {
      return serialize(async () => {
        const current = await readPreferences();
        const agentModels: AgentModelOptionsMap = { ...current.agentModels, [agentName]: options };
        return writePreferences(normalizePreferences({ ...current, agentModels }));
      });
    },
    setTurnLimits(turnLimits) {
      return serialize(async () => {
        const current = await readPreferences();
        return writePreferences(normalizePreferences({ ...current, turnLimits }));
      });
    },
    apply() {
      return serialize(async () => {
        const preferences = await readPreferences();
        applyLoginItemSettings(preferences);
        return preferences;
      });
    },
  };
}
