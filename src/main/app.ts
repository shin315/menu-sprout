import { app, BrowserWindow, screen, shell, nativeTheme, type Rectangle } from "electron";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MenuSproutCustomAgentInput, MenuSproutSettings } from "../shared/contracts";
import { getRepoRoot } from "../shared/paths";
import { DEFAULT_APPEARANCE, DEFAULT_THEME } from "../shared/themes";
import {
  adapterArgsForOptions,
  agentModelSettings,
  validateAgentOptionsInput,
  validateTurnLimitsInput,
  type BuiltInAgentOptionName,
} from "../shared/agent-options";
import { createAgentCatalogController } from "./agent-catalog-controller";
import { MenuSproutAgentRuntime, commandExists } from "./agent-runtime";
import { resolveMenuSproutRuntimePaths } from "./app-paths";
import { seedExtensionWorkspace } from "./extension-seeder";
import { registerIpcHandlers } from "./ipc";
import {
  DEFAULT_POPOVER_SIZE,
  calculatePopoverBounds,
  createPopoverOptions,
  loadPopoverRenderer,
  responsivePopoverSize,
  type Size,
} from "./popover";
import { createBackgroundTaskScheduler } from "./background-task-scheduler";
import { createExtensionDatabase } from "./extension-database";
import { createNotifier } from "./notifier";
import { createPreferencesService } from "./preferences";
import { createMenuBarItemManager } from "./menu-bar-items";
import {
  createBackgroundTaskSource,
  createMenuBarItemSource,
  createServerActionRegistry,
  createServerModuleLoader,
} from "./server-action-registry";
import { attachRendererRecovery } from "./renderer-recovery";
import { getDefaultTelemetry, initDefaultTelemetry } from "./telemetry";
import { expandProcessPathForGuiLaunch } from "./shell-path";
import { createUpdateChecker } from "./update-checker";
import { createMenuBarItemView, createMenuSproutTray, type MenuSproutTray } from "./tray";
import { createLayoutModuleRegistry, createWidgetModuleRegistry } from "./widget-module-registry";
import { registerMenuSproutProtocolHandlers, registerMenuSproutProtocolSchemes } from "./widget-protocol";
import { assertOutsideDir, createWidgetCapturer } from "./widget-capture";
import { startWidgetCaptureServer, type WidgetCaptureServer } from "./widget-capture-server";
import { createElectronCaptureSurfaces, type CaptureWindowRegistry } from "./widget-capture-window";

if (process.platform === "darwin") {
  app.commandLine.appendSwitch("use-mock-keychain");
}

const remoteDebuggingPort = Number(process.env.MENU_SPROUT_REMOTE_DEBUGGING_PORT);
if (Number.isInteger(remoteDebuggingPort) && remoteDebuggingPort >= 1 && remoteDebuggingPort <= 65_535) {
  app.commandLine.appendSwitch("remote-debugging-port", String(remoteDebuggingPort));
}

registerMenuSproutProtocolSchemes();

let popoverWindow: BrowserWindow | null = null;
let restartPopoverRenderer: (() => void) | null = null;
let activeTray: MenuSproutTray | null = null;
let latestTrayBounds: Rectangle | null = null;
let latestPopoverSize: Size = DEFAULT_POPOVER_SIZE;

export function getActiveMenuSproutTray(): MenuSproutTray | null {
  return activeTray;
}

function currentDirname(): string {
  return typeof __dirname === "string" ? __dirname : fileURLToPath(new URL(".", import.meta.url));
}

async function createPopoverWindow(): Promise<BrowserWindow> {
  if (popoverWindow && !popoverWindow.isDestroyed()) return popoverWindow;

  const dirname = currentDirname();
  popoverWindow = new BrowserWindow(createPopoverOptions(join(dirname, "../preload/index.cjs")));
  popoverWindow.on("blur", () => {
    if (process.env.MENU_SPROUT_KEEP_POPOVER_OPEN === "1") return;
    popoverWindow?.hide();
  });
  // Tell the renderer when the popover is shown or hidden so view refresh can pause
  // while nobody is looking. Main owns the authoritative signal: the Page Visibility
  // API is unreliable here (the popover is created show:false, and the gating would
  // silently break if backgroundThrottling were ever disabled).
  popoverWindow.on("show", () => sendPopoverVisibility(true));
  // Once the popover is hidden, drop back to accessory mode so the dock icon disappears again.
  // See setPopoverKeyWindowActive for why the popover becomes a regular-policy app while visible.
  popoverWindow.on("hide", () => {
    setPopoverKeyWindowActive(false);
    sendPopoverVisibility(false);
  });
  restartPopoverRenderer = attachRendererRecovery(popoverWindow.webContents).restart;

  await loadPopoverRenderer(
    popoverWindow,
    process.env.ELECTRON_RENDERER_URL,
    join(dirname, "../renderer/index.html"),
    { isPackaged: app.isPackaged },
  );

  return popoverWindow;
}

async function togglePopover(trayBounds: Rectangle): Promise<void> {
  // Set before creating the window: the first renderer size report arrives while it loads.
  latestTrayBounds = trayBounds;
  const window = await createPopoverWindow();
  if (window.isVisible()) {
    window.hide();
    return;
  }
  await showPopover(trayBounds);
}

async function showPopover(trayBounds: Rectangle): Promise<void> {
  latestTrayBounds = trayBounds;
  const window = await createPopoverWindow();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  window.setBounds(calculatePopoverBounds(trayBounds, display.workArea, latestPopoverSize));
  setPopoverKeyWindowActive(true);
  window.show();
  window.focus();
  // The popover is menu-sprout's single screen, so opening it is the app's page
  // view. Send a Umami pageview (empty event name) so the dashboard's Views /
  // Visitors / Pages reports populate, and keep the named event for funnels.
  const telemetry = getDefaultTelemetry();
  telemetry.pageview("/popover");
  telemetry.track("popover_open");
}

// menu-sprout runs as a macOS accessory app (dock hidden) so it has no permanent dock icon. But an
// accessory app's windows never become the macOS "key window", and macOS only does CSS cursor-rect
// tracking for the key window - so as an accessory app the popover's cursor never updates correctly
// (it stays the default arrow, or updates unstably and flickers). Switching to the "regular"
// activation policy while the popover is visible lets it become the key window so the cursor tracks
// correctly; switching back to "accessory" on hide keeps the dock icon from lingering. Net effect:
// the dock icon is only present for the brief moment the popover is open.
function setPopoverKeyWindowActive(active: boolean): void {
  if (process.platform !== "darwin") return;
  app.setActivationPolicy(active ? "regular" : "accessory");
  if (active) app.focus({ steal: true });
}

// Tray menu Reload: restarts the renderer in a fresh process, so it works even
// when the popover UI is unusable or hung (its own Reload button lives inside
// that UI).
function reloadPopover(): void {
  restartPopoverRenderer?.();
}

function sendToPopover(channel: string, payload: unknown): void {
  if (!popoverWindow || popoverWindow.isDestroyed()) return;
  popoverWindow.webContents.send(channel, payload);
}

function sendPopoverVisibility(visible: boolean): void {
  sendToPopover("menu-sprout:popover:visibility", { visible });
}

function setPopoverContentSize(size: { width: number; height: number }) {
  const workArea = latestTrayBounds
    ? screen.getDisplayNearestPoint({ x: latestTrayBounds.x, y: latestTrayBounds.y }).workArea
    : undefined;
  latestPopoverSize = responsivePopoverSize(size, workArea);
  if (!latestTrayBounds || !popoverWindow || popoverWindow.isDestroyed()) return;

  const display = screen.getDisplayNearestPoint({ x: latestTrayBounds.x, y: latestTrayBounds.y });
  popoverWindow.setBounds(calculatePopoverBounds(latestTrayBounds, display.workArea, latestPopoverSize));
}

// Retained for the height-only bridge call; keeps the current width and lets the
// new width+height path own the full adaptive sizing.
function setPopoverContentHeight(height: number) {
  setPopoverContentSize({ width: latestPopoverSize.width, height });
}

export async function startMenuSproutApp(): Promise<void> {
  const shellPathReady = expandProcessPathForGuiLaunch();
  await app.whenReady();

  const sourceRoot = getRepoRoot();
  const paths = resolveMenuSproutRuntimePaths(sourceRoot);
  // Seeding the bundled defaults is best-effort: it touches a user-owned
  // workspace that can be a read-only or managed (home-manager / Nix) symlink,
  // and the embedded agent self-heals it later anyway. A failure here must never
  // prevent the tray from appearing, so it is contained rather than fatal.
  try {
    await seedExtensionWorkspace({ extensionsDir: paths.extensionsDir, templateDir: paths.bundledExtensionTemplateDir });
  } catch (error) {
    console.error("[menu-sprout] extension workspace seeding failed; continuing startup", error);
  }
  registerMenuSproutProtocolHandlers({ widgetCacheDir: paths.widgetCacheDir });

  if (process.platform === "darwin") {
    app.dock?.hide();
  }

  // app.isPackaged is also true for local Menu Sprout Dev bundles. Only the
  // production product may register or mutate the user's macOS login item.
  const allowOpenAtLogin = paths.isPackaged && basename(app.getPath("exe")) === "Menu Sprout";
  const preferences = createPreferencesService({
    userDataDir: paths.appDataRoot,
    app,
    defaultOpenAtLogin: allowOpenAtLogin,
    allowOpenAtLogin,
  });
  const persistedPreferences = await preferences.apply();

  // Load the saved privacy choice before the first event, so startup respects
  // the opt-out; configuration and precedence are documented in PRIVACY.md.
  const telemetry = initDefaultTelemetry({
    app: "menu-sprout",
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    preference: persistedPreferences.telemetryEnabled,
  });
  telemetry.track("app_start");

  // themeSource drives `prefers-color-scheme` in every renderer and native
  // controls, so the theme.css light/dark variants follow the user's choice.
  nativeTheme.themeSource = persistedPreferences.appearance ?? DEFAULT_APPEARANCE;

  // Visual self-check: the agent asks this loopback endpoint for a PNG of its
  // rendered widget. Best-effort, like seeding: without it the agent simply gets
  // no capture instructions and the rest of the app is unaffected.
  const captureRegistry: CaptureWindowRegistry = { has: () => false, resize: () => undefined };
  let captureServer: WidgetCaptureServer | null = null;
  try {
    const captureDir = join(paths.cacheDir, "captures");
    // Captures must never land in the tracked/snapshotted extension workspace,
    // or they would show up as agent changes in Keep/Undo.
    assertOutsideDir(captureDir, paths.extensionsDir);
    const dirname = currentDirname();
    const surfaces = createElectronCaptureSurfaces({
      preloadPath: join(dirname, "../preload/index.cjs"),
      rendererUrl: process.env.ELECTRON_RENDERER_URL,
      rendererFile: join(dirname, "../renderer/index.html"),
      isPackaged: app.isPackaged,
      getSize: () => latestPopoverSize,
    });
    Object.assign(captureRegistry, surfaces.registry);
    captureServer = await startWidgetCaptureServer({
      capturer: createWidgetCapturer({ outputDir: captureDir, createSurface: surfaces.createSurface }),
    });
  } catch (error) {
    console.error("[menu-sprout] widget capture unavailable; continuing without it", error);
  }

  // Built-in claude/codex/antigravity agents are driven by the bundled
  // clean-room ACP adapters. Run them with the bundled Electron as Node (ELECTRON_RUN_AS_NODE)
  // so there is no dependency on a separately-installed `node` - the same class
  // of PATH fragility that made the agent look "unavailable" before.
  const adapterLauncher = ["env", "ELECTRON_RUN_AS_NODE=1", process.execPath];
  // The catalog is a live runtime service: it owns agents.json and pushes
  // rebuilt registry overrides into the runtime so UI-added custom agents apply
  // immediately. agentRuntime is referenced through closures (assigned just below)
  // and only invoked after startup, so the forward reference is safe.
  let agentRuntime: MenuSproutAgentRuntime;
  // Settings model and effort per built-in agent, passed to its adapter as
  // launch arguments; read live so a change rebuilds the launch command.
  let agentModels = persistedPreferences.agentModels;
  const agentCatalog = createAgentCatalogController({
    agentsJsonPath: join(paths.appDataRoot, "agents.json"),
    resolveAdapterPath: (adapter) => join(paths.adaptersDir, adapter, "index.mjs"),
    adapterLauncher,
    commandExists,
    getActiveAgentName: () => agentRuntime.currentAgent,
    onOverridesChange: (overrides) => agentRuntime.setRegistryOverrides(overrides),
    adapterArgs: (adapter) => adapterArgsForOptions(adapter, agentModels?.[adapter]),
  });
  await agentCatalog.load();

  agentRuntime = new MenuSproutAgentRuntime(paths.appDataRoot, {
    agentName: persistedPreferences.agentName,
    registryOverrides: Object.keys(agentCatalog.overrides).length > 0 ? agentCatalog.overrides : undefined,
    capture: captureServer ? { url: captureServer.url, token: captureServer.token } : undefined,
    telemetry,
    shellPathReady,
    agentOptions: agentModels,
    turnLimits: persistedPreferences.turnLimits,
    paths: {
      extensionsDir: paths.extensionsDir,
      agentStateDir: paths.agentStateDir,
      snapshotDir: paths.devExtensionSnapshotDir,
      isPackaged: paths.isPackaged,
    },
  });
  const database = createExtensionDatabase(paths.databasePath);
  const notify = createNotifier();

  // Does not wait for the interactive shell PATH probe, so Settings opened in the
  // first seconds of a GUI launch can briefly show an nvm/asdf/volta-only CLI as
  // unavailable. Reopening shows it correctly; agent runs always await the probe.
  async function buildSettings(): Promise<MenuSproutSettings> {
    const current = await preferences.get();
    return {
      openAtLogin: current.openAtLogin,
      agentName: agentRuntime.currentAgent,
      agentSwitchDisabledReason: agentRuntime.agentSwitchDisabledReason,
      agents: agentCatalog.options(),
      theme: current.theme ?? DEFAULT_THEME,
      appearance: current.appearance ?? DEFAULT_APPEARANCE,
      telemetry: telemetry.status(),
      agentModels: agentModelSettings(current.agentModels),
      turnLimits: current.turnLimits ?? {},
    };
  }

  const settingsController = {
    get: buildSettings,
    async setOpenAtLogin(openAtLogin: boolean) {
      await preferences.setOpenAtLogin(openAtLogin);
      return buildSettings();
    },
    async setTheme(theme: string) {
      await preferences.setTheme(theme);
      return buildSettings();
    },
    async setAppearance(appearance: string) {
      const saved = await preferences.setAppearance(appearance);
      nativeTheme.themeSource = saved.appearance ?? DEFAULT_APPEARANCE;
      return buildSettings();
    },
    async setTelemetryEnabled(enabled: boolean) {
      const saved = await preferences.setTelemetryEnabled(enabled);
      telemetry.setPreference(saved.telemetryEnabled ?? enabled);
      return buildSettings();
    },
    async setAgent(agentName: string) {
      await agentRuntime.setAgent(agentName);
      await preferences.setAgent(agentName);
      return buildSettings();
    },
    async addAgent(input: MenuSproutCustomAgentInput) {
      await agentCatalog.addAgent(input);
      return buildSettings();
    },
    async updateAgent(name: string, input: { label?: string; command: string }) {
      await agentCatalog.updateAgent(name, input);
      return buildSettings();
    },
    async removeAgent(name: string) {
      await agentCatalog.removeAgent(name);
      return buildSettings();
    },
    async setAgentModel(agentName: string, input: { model?: string; effort?: string }) {
      const options = validateAgentOptionsInput(agentName, input);
      const saved = await preferences.setAgentModel(agentName as BuiltInAgentOptionName, options);
      agentModels = saved.agentModels;
      agentRuntime.setAgentOptions(agentModels);
      // A new launch command restarts the agent from its next turn; the runtime
      // defers that while a turn runs or a change waits for Keep or Undo.
      await agentCatalog.refresh();
      return buildSettings();
    },
    async setTurnLimits(input: { maxTurnMinutes?: number | null; maxToolCalls?: number | null }) {
      const saved = await preferences.setTurnLimits(validateTurnLimitsInput(input));
      agentRuntime.setTurnLimits(saved.turnLimits);
      return buildSettings();
    },
  };

  // Actions, background tasks, and menu-bar items compile the same server.ts files into
  // one cache dir, so they share a loader that compiles each file once.
  const serverModules = createServerModuleLoader({ cacheDir: paths.serverActionCacheDir });
  const serverActions = createServerActionRegistry({
    rootDir: paths.appDataRoot,
    actionRoots: [paths.extensionsDir],
    loader: serverModules,
    db: database,
    notify,
  });
  const widgetRegistryOptions = {
    rootDir: paths.appDataRoot,
    extensionsDir: paths.extensionsDir,
    mode: (paths.isPackaged ? "compiled" : "vite") as "compiled" | "vite",
    widgetCacheDir: paths.widgetCacheDir,
  };
  const widgetModules = createWidgetModuleRegistry(widgetRegistryOptions);
  const layoutModules = createLayoutModuleRegistry(widgetRegistryOptions);

  const updateChecker = createUpdateChecker({
    currentVersion: app.getVersion(),
    openExternal: (url) => shell.openExternal(url),
    // Dev/source builds are never "behind" a release, so force the indicator on
    // there to make it visible while developing. Packaged builds do the real check.
    simulateUpdate: !app.isPackaged,
  });

  registerIpcHandlers(
    paths.appDataRoot,
    agentRuntime,
    serverActions,
    widgetModules,
    {
      // The hidden capture windows run the same renderer. They size themselves and
      // count as visible so widgets refresh, but never move the user's popover.
      setContentHeight: (height, senderId) => {
        if (senderId !== undefined && captureRegistry.has(senderId)) return;
        setPopoverContentHeight(height);
      },
      setContentSize: (size, senderId) => {
        if (senderId !== undefined && captureRegistry.has(senderId)) {
          captureRegistry.resize(senderId, responsivePopoverSize(size, screen.getPrimaryDisplay().workArea));
          return;
        }
        setPopoverContentSize(size);
      },
      getVisibility: (senderId) =>
        senderId !== undefined && captureRegistry.has(senderId)
          ? { visible: true }
          : { visible: popoverWindow?.isVisible() ?? false },
    },
    settingsController,
    {
      quit: () => app.quit(),
      getUpdateStatus: () => updateChecker.getStatus(),
      openReleasePage: () => updateChecker.openReleasePage(),
    },
    { recipesDir: paths.recipesDir, database, layoutModules },
  );
  activeTray = createMenuSproutTray(
    (bounds) => {
      void togglePopover(bounds);
    },
    {
      iconPath: paths.trayIconPath,
      menu: {
        open: () => {
          if (activeTray) void showPopover(activeTray.getBounds());
        },
        reload: reloadPopover,
        quit: () => app.quit(),
      },
    },
  );

  if (process.env.MENU_SPROUT_OPEN_POPOVER_ON_START === "1") {
    await togglePopover(activeTray.getBounds());
  }

  // Background tasks run on their own cadence in the main process, regardless of whether
  // the popover is open, and notify open widgets to re-read when a run completes.
  const backgroundTasks = createBackgroundTaskScheduler({
    source: createBackgroundTaskSource({
      rootDir: paths.appDataRoot,
      actionRoots: [paths.extensionsDir],
      loader: serverModules,
    }),
    context: { rootDir: paths.appDataRoot, db: database, notify },
    watchDir: paths.extensionsDir,
    onTaskRun: (extensionId) => {
      if (!popoverWindow?.isVisible()) return;
      sendToPopover("menu-sprout:background:update", { extensionId });
    },
  });
  void backgroundTasks.start();

  // Widgets that declare `export const menuBar` in server.ts get their own live item in
  // the macOS menu bar. Items follow the extension workspace, so removing a widget,
  // undoing a turn, or editing the code is picked up without a restart.
  const menuBarItems = createMenuBarItemManager({
    source: createMenuBarItemSource({
      rootDir: paths.appDataRoot,
      actionRoots: [paths.extensionsDir],
      loader: serverModules,
    }),
    context: { rootDir: paths.appDataRoot, db: database, notify },
    createView: createMenuBarItemView,
    watchDir: paths.extensionsDir,
    onActivate: (bounds) => {
      void togglePopover(bounds);
    },
  });
  menuBarItems.start().catch((error) => {
    console.error("[menu-sprout] menu-bar items failed to start", error);
  });

  app.on("activate", () => undefined);
  app.on("window-all-closed", () => undefined);
  app.on("before-quit", () => {
    backgroundTasks.stop();
    menuBarItems.stop();
    void captureServer?.close();
    database.close();
    void telemetry.close(1_000);
  });
}

if (!process.env.VITEST) {
  // Last-resort guard: an unhandled rejection here would otherwise leave a dead
  // app with a lingering dock icon and no tray, with no diagnostic in the logs.
  startMenuSproutApp().catch((error) => {
    console.error("[menu-sprout] fatal startup error", error);
  });
}
