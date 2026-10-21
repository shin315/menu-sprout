import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Rectangle } from "electron";

const trayInstance = {
  tray: {},
  getBounds: vi.fn(),
};

const electronApp = {
  commandLine: { appendSwitch: vi.fn() },
  dock: { hide: vi.fn() },
  getPath: vi.fn((name: string): string => {
    if (name === "home") return "/home/test-user";
    if (name === "exe") return "/tmp/Menu Sprout Dev.app/Contents/MacOS/Menu Sprout Dev";
    return "/tmp";
  }),
  getVersion: vi.fn(() => "0.0.0-test"),
  getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
  setLoginItemSettings: vi.fn(),
  setActivationPolicy: vi.fn(),
  focus: vi.fn(),
  isPackaged: false,
  on: vi.fn(),
  quit: vi.fn(),
  whenReady: vi.fn(async () => undefined),
};

const createMenuSproutTray = vi.fn((_onClick: (bounds: Rectangle) => void, _options?: unknown) => trayInstance);
const expandProcessPathForGuiLaunch = vi.fn(() => Promise.resolve());
const browserWindowInstance = {
  isDestroyed: vi.fn(() => false),
  isVisible: vi.fn(() => false),
  setBounds: vi.fn(),
  show: vi.fn(),
  focus: vi.fn(),
  hide: vi.fn(),
  on: vi.fn(),
  loadFile: vi.fn(async () => undefined),
  loadURL: vi.fn(async () => undefined),
  webContents: { send: vi.fn(), on: vi.fn(), reload: vi.fn(), forcefullyCrashRenderer: vi.fn(), isCrashed: vi.fn(() => false), isDestroyed: vi.fn(() => false) },
};
const BrowserWindow = vi.fn(function BrowserWindowMock() {
  return browserWindowInstance;
});
const getDisplayNearestPoint = vi.fn(() => ({
  workArea: { x: 0, y: 0, width: 1440, height: 900 },
}));
const protocol = {
  registerSchemesAsPrivileged: vi.fn(),
  handle: vi.fn(),
};
const registerIpcHandlers = vi.fn();
const nativeTheme = { themeSource: "system" };
const telemetryClient = {
  track: vi.fn(),
  pageview: vi.fn(),
  close: vi.fn(async () => undefined),
  status: vi.fn(() => ({ enabled: true, source: "default", configured: false })),
  setPreference: vi.fn(),
};

vi.mock("electron", () => ({
  app: electronApp,
  BrowserWindow,
  protocol,
  screen: { getDisplayNearestPoint },
  shell: { openExternal: vi.fn(async () => undefined) },
  nativeTheme,
}));

vi.mock("../src/main/ipc", () => ({
  registerIpcHandlers,
}));

vi.mock("../src/main/telemetry", () => ({
  initDefaultTelemetry: vi.fn(() => telemetryClient),
  getDefaultTelemetry: vi.fn(() => telemetryClient),
}));

vi.mock("../src/main/agent-runtime", () => ({
  MenuSproutAgentRuntime: vi.fn(),
  commandExists: vi.fn(() => false),
}));

vi.mock("../src/main/extension-seeder", () => ({
  seedExtensionWorkspace: vi.fn(async () => undefined),
}));

vi.mock("../src/main/server-action-registry", () => ({
  createServerActionRegistry: vi.fn(() => ({})),
  createBackgroundTaskSource: vi.fn(() => ({ list: vi.fn(async () => []) })),
  createMenuBarItemSource: vi.fn(() => ({ list: vi.fn(async () => []) })),
  createServerModuleLoader: vi.fn(() => ({ load: vi.fn(), prune: vi.fn() })),
}));
vi.mock("../src/main/menu-bar-items", () => ({
  createMenuBarItemManager: vi.fn(() => ({
    start: vi.fn(async () => undefined),
    resync: vi.fn(async () => undefined),
    stop: vi.fn(),
  })),
}));

vi.mock("../src/main/background-task-scheduler", () => ({
  createBackgroundTaskScheduler: vi.fn(() => ({
    start: vi.fn(async () => undefined),
    resync: vi.fn(async () => undefined),
    stop: vi.fn(),
  })),
}));

vi.mock("../src/main/extension-database", () => ({
  createExtensionDatabase: vi.fn(() => ({
    query: vi.fn(() => []),
    get: vi.fn(),
    run: vi.fn(() => ({ changes: 0, lastInsertRowid: 0 })),
    exec: vi.fn(),
    transaction: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock("../src/main/widget-module-registry", () => ({
  createWidgetModuleRegistry: vi.fn(() => ({})),
  createLayoutModuleRegistry: vi.fn(() => ({ get: vi.fn(async () => null) })),
}));

vi.mock("../src/main/widget-protocol", () => ({
  registerMenuSproutProtocolHandlers: vi.fn(),
  registerMenuSproutProtocolSchemes: vi.fn(),
}));

vi.mock("../src/main/tray", () => ({
  createMenuSproutTray,
  createMenuBarItemView: vi.fn(),
}));

vi.mock("../src/main/shell-path", () => ({
  expandProcessPathForGuiLaunch,
}));

vi.mock("../src/shared/paths", () => ({
  EXTENSIONS_DIR_ENV: "MENU_SPROUT_EXTENSIONS_DIR",
  getRepoRoot: vi.fn(() => "/repo"),
}));

describe("startMenuSproutApp", () => {
  const originalPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    nativeTheme.themeSource = "system";
    electronApp.isPackaged = false;
    electronApp.getPath.mockImplementation((name: string) => {
      if (name === "home") return "/home/test-user";
      if (name === "exe") return "/tmp/Menu Sprout Dev.app/Contents/MacOS/Menu Sprout Dev";
      return "/tmp";
    });
    browserWindowInstance.isDestroyed.mockReturnValue(false);
    browserWindowInstance.isVisible.mockReturnValue(false);
    trayInstance.getBounds.mockReturnValue({ x: 100, y: 10, width: 24, height: 24 });
    delete process.env.MENU_SPROUT_OPEN_POPOVER_ON_START;
    delete process.env.MENU_SPROUT_REMOTE_DEBUGGING_PORT;
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  afterEach(() => {
    delete process.env.MENU_SPROUT_OPEN_POPOVER_ON_START;
    delete process.env.MENU_SPROUT_REMOTE_DEBUGGING_PORT;
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: originalPlatform,
    });
  });

  it("disables Chromium keychain prompts before app startup on macOS", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });

    await import("../src/main/app");

    expect(electronApp.commandLine.appendSwitch).toHaveBeenCalledWith("use-mock-keychain");
  });

  it("accepts a validated remote debugging port for unattended popover checks", async () => {
    process.env.MENU_SPROUT_REMOTE_DEBUGGING_PORT = "9333";

    await import("../src/main/app");

    expect(electronApp.commandLine.appendSwitch).toHaveBeenCalledWith("remote-debugging-port", "9333");
  });

  it("ignores invalid remote debugging ports", async () => {
    process.env.MENU_SPROUT_REMOTE_DEBUGGING_PORT = "9333 --inspect";

    await import("../src/main/app");

    expect(electronApp.commandLine.appendSwitch).not.toHaveBeenCalledWith("remote-debugging-port", expect.anything());
  });

  it("opens the real popover on startup when the unattended-check seam is enabled", async () => {
    process.env.MENU_SPROUT_OPEN_POPOVER_ON_START = "1";
    const appModule = await import("../src/main/app");

    await appModule.startMenuSproutApp();

    await vi.waitFor(() => expect(browserWindowInstance.show).toHaveBeenCalled());
    expect(trayInstance.getBounds).toHaveBeenCalled();
    expect(browserWindowInstance.setBounds).toHaveBeenCalledWith({ x: 8, y: 42, width: 504, height: 620 });
  });

  it("starts without waiting for the interactive shell PATH probe and hands it to agent runs", async () => {
    const shellPathReady = new Promise<void>(() => undefined);
    expandProcessPathForGuiLaunch.mockReturnValueOnce(shellPathReady);
    const { MenuSproutAgentRuntime } = await import("../src/main/agent-runtime");
    const appModule = await import("../src/main/app");

    await appModule.startMenuSproutApp();

    expect(createMenuSproutTray).toHaveBeenCalled();
    expect(MenuSproutAgentRuntime).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ shellPathReady }));
  });

  it("retains the tray object for the app lifetime", async () => {
    const appModule = (await import("../src/main/app")) as typeof import("../src/main/app") & {
      getActiveMenuSproutTray?: () => unknown;
    };

    expect(typeof appModule.getActiveMenuSproutTray).toBe("function");

    await appModule.startMenuSproutApp();

    expect(createMenuSproutTray).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      iconPath: "/repo/assets/tray/menu_sproutTemplate.png",
    }));
    expect(appModule.getActiveMenuSproutTray?.()).toBe(trayInstance);
  });

  it("still creates the tray when extension workspace seeding fails", async () => {
    const { seedExtensionWorkspace } = await import("../src/main/extension-seeder");
    (seedExtensionWorkspace as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("EISDIR: symlinked workspace"));
    const appModule = await import("../src/main/app");

    await expect(appModule.startMenuSproutApp()).resolves.toBeUndefined();

    expect(createMenuSproutTray).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({
      iconPath: "/repo/assets/tray/menu_sproutTemplate.png",
    }));
    expect(appModule.getActiveMenuSproutTray()).toBe(trayInstance);
  });

  it("creates the popover with the CommonJS preload bridge", async () => {
    const appModule = await import("../src/main/app");

    await appModule.startMenuSproutApp();
    const onTrayClick = createMenuSproutTray.mock.calls.at(-1)?.[0];

    expect(onTrayClick).toBeTypeOf("function");
    await onTrayClick?.({ x: 100, y: 10, width: 24, height: 24 });

    expect(BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        webPreferences: expect.objectContaining({
          preload: expect.stringMatching(/preload\/index\.cjs$/),
        }),
      }),
    );
  });

  it("wires content-height resize reports into the popover bounds", async () => {
    const appModule = await import("../src/main/app");

    await appModule.startMenuSproutApp();
    const popoverController = registerIpcHandlers.mock.calls.at(-1)?.[4];
    const onTrayClick = createMenuSproutTray.mock.calls.at(-1)?.[0];
    await onTrayClick?.({ x: 100, y: 10, width: 24, height: 24 });
    await vi.waitFor(() => expect(browserWindowInstance.setBounds).toHaveBeenCalled());

    popoverController.setContentHeight(333);

    expect(browserWindowInstance.setBounds).toHaveBeenLastCalledWith({ x: 8, y: 42, width: 504, height: 333 });
  });

  it("caps initial renderer size reports before first popover bounds", async () => {
    const appModule = await import("../src/main/app");

    await appModule.startMenuSproutApp();
    const onTrayClick = createMenuSproutTray.mock.calls.at(-1)?.[0];
    browserWindowInstance.loadFile.mockImplementationOnce(async () => {
      const popoverController = registerIpcHandlers.mock.calls.at(-1)?.[4];
      popoverController.setContentSize({ width: 2000, height: 300 });
    });

    await onTrayClick?.({ x: 100, y: 10, width: 24, height: 24 });

    await vi.waitFor(() =>
      expect(browserWindowInstance.setBounds).toHaveBeenLastCalledWith({ x: 8, y: 42, width: 1424, height: 300 }),
    );
  });

  it("starts the background scheduler and only forwards task-run events to visible renderer", async () => {
    const { createBackgroundTaskScheduler } = await import("../src/main/background-task-scheduler");
    const appModule = await import("../src/main/app");

    await appModule.startMenuSproutApp();
    const onTrayClick = createMenuSproutTray.mock.calls.at(-1)?.[0];
    await onTrayClick?.({ x: 100, y: 10, width: 24, height: 24 });

    const schedulerOptions = (createBackgroundTaskScheduler as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(schedulerOptions.watchDir).toBe("/repo/extensions");

    browserWindowInstance.webContents.send.mockClear();
    browserWindowInstance.isVisible.mockReturnValue(false);
    schedulerOptions.onTaskRun("cpu-usage");
    expect(browserWindowInstance.webContents.send).not.toHaveBeenCalled();

    browserWindowInstance.isVisible.mockReturnValue(true);
    schedulerOptions.onTaskRun("cpu-usage");
    expect(browserWindowInstance.webContents.send).toHaveBeenCalledWith("menu-sprout:background:update", {
      extensionId: "cpu-usage",
    });
  });

  it("watches the popover renderer for crashes and hangs", async () => {
    const appModule = await import("../src/main/app");

    await appModule.startMenuSproutApp();
    const onTrayClick = createMenuSproutTray.mock.calls.at(-1)?.[0];
    await onTrayClick?.({ x: 100, y: 10, width: 24, height: 24 });

    const events = browserWindowInstance.webContents.on.mock.calls.map(([event]) => event);
    expect(events).toEqual(expect.arrayContaining(["render-process-gone", "unresponsive"]));
  });

  it("wires the tray right-click menu to open, reload, and quit natively", async () => {
    const appModule = await import("../src/main/app");

    await appModule.startMenuSproutApp();
    const options = createMenuSproutTray.mock.calls.at(-1)?.[1] as {
      menu: { open: () => void; reload: () => void; quit: () => void };
    };
    trayInstance.getBounds.mockReturnValue({ x: 100, y: 10, width: 24, height: 24 });

    options.menu.open();
    await vi.waitFor(() => expect(browserWindowInstance.show).toHaveBeenCalled());

    options.menu.reload();
    expect(browserWindowInstance.webContents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
    // The reload waits for the killed renderer's gone event; reloading before it leaves
    // the popover crashed in a real run.
    expect(browserWindowInstance.webContents.reload).not.toHaveBeenCalled();
    const onGone = browserWindowInstance.webContents.on.mock.calls.find(([event]) => event === "render-process-gone")?.[1];
    onGone?.({}, { reason: "killed", exitCode: 9 });
    await vi.waitFor(() => expect(browserWindowInstance.webContents.reload).toHaveBeenCalledTimes(1));

    options.menu.quit();
    expect(electronApp.quit).toHaveBeenCalled();
  });

  it("emits popover visibility to the renderer on show and hide", async () => {
    const appModule = await import("../src/main/app");

    await appModule.startMenuSproutApp();
    const onTrayClick = createMenuSproutTray.mock.calls.at(-1)?.[0];
    await onTrayClick?.({ x: 100, y: 10, width: 24, height: 24 });

    const onShow = browserWindowInstance.on.mock.calls.find(([event]) => event === "show")?.[1];
    const onHide = browserWindowInstance.on.mock.calls.find(([event]) => event === "hide")?.[1];

    onShow?.();
    expect(browserWindowInstance.webContents.send).toHaveBeenCalledWith("menu-sprout:popover:visibility", {
      visible: true,
    });

    onHide?.();
    expect(browserWindowInstance.webContents.send).toHaveBeenLastCalledWith("menu-sprout:popover:visibility", {
      visible: false,
    });
  });

  it("records popover opens as both a pageview and a named event", async () => {
    const appModule = await import("../src/main/app");

    await appModule.startMenuSproutApp();
    const onTrayClick = createMenuSproutTray.mock.calls.at(-1)?.[0];
    await onTrayClick?.({ x: 100, y: 10, width: 24, height: 24 });

    await vi.waitFor(() => expect(telemetryClient.pageview).toHaveBeenCalledWith("/popover"));
    expect(telemetryClient.track).toHaveBeenCalledWith("popover_open");
  });

  it("follows macOS appearance when no appearance preference is saved", async () => {
    nativeTheme.themeSource = "dark";
    const appModule = await import("../src/main/app");

    await appModule.startMenuSproutApp();

    expect(nativeTheme.themeSource).toBe("system");
  });

  it("applies the saved appearance at startup and live from Settings", async () => {
    let saved: { openAtLogin: boolean; appearance?: string } = { openAtLogin: false, appearance: "light" };
    vi.doMock("../src/main/preferences", () => ({
      createPreferencesService: () => ({
        get: async () => saved,
        apply: async () => saved,
        setAppearance: async (appearance: string) => {
          saved = appearance === "dark" ? { openAtLogin: false, appearance } : { openAtLogin: false };
          return saved;
        },
      }),
    }));
    try {
      const appModule = await import("../src/main/app");

      await appModule.startMenuSproutApp();
      expect(nativeTheme.themeSource).toBe("light");

      const settingsController = registerIpcHandlers.mock.calls.at(-1)?.[5];
      await expect(settingsController.setAppearance("dark")).resolves.toMatchObject({ appearance: "dark" });
      expect(nativeTheme.themeSource).toBe("dark");

      // An unknown value is dropped by preferences, so the app falls back to System.
      await expect(settingsController.setAppearance("sepia")).resolves.toMatchObject({ appearance: "system" });
      expect(nativeTheme.themeSource).toBe("system");
    } finally {
      vi.doUnmock("../src/main/preferences");
    }
  });

  it("starts telemetry from the saved privacy switch and applies Settings changes live", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "menu-sprout-telemetry-prefs-"));
    const { createPreferencesService } = await vi.importActual<typeof import("../src/main/preferences")>("../src/main/preferences");
    const preferences = createPreferencesService({ userDataDir, app: electronApp, defaultOpenAtLogin: false, allowOpenAtLogin: false });
    await preferences.setTelemetryEnabled(false);
    vi.doMock("../src/main/preferences", () => ({ createPreferencesService: () => preferences }));
    try {
      const telemetryModule = await import("../src/main/telemetry");
      const appModule = await import("../src/main/app");
      await appModule.startMenuSproutApp();

      expect(telemetryModule.initDefaultTelemetry).toHaveBeenLastCalledWith(expect.objectContaining({ preference: false }));

      const settingsController = registerIpcHandlers.mock.calls.at(-1)?.[5];
      await settingsController.setTelemetryEnabled(true);
      expect(telemetryClient.setPreference).toHaveBeenLastCalledWith(true);
      await expect(preferences.get()).resolves.toEqual({ openAtLogin: false, telemetryEnabled: true });
      await expect(settingsController.get()).resolves.toMatchObject({ telemetry: { enabled: true, source: "default", configured: false } });
    } finally {
      vi.doUnmock("../src/main/preferences");
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  it("keeps native appearance and persisted preferences in concurrent request order", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "menu-sprout-appearance-prefs-"));
    const { createPreferencesService } = await vi.importActual<typeof import("../src/main/preferences")>("../src/main/preferences");
    const preferences = createPreferencesService({ userDataDir, app: electronApp, defaultOpenAtLogin: false, allowOpenAtLogin: false });
    vi.doMock("../src/main/preferences", () => ({ createPreferencesService: () => preferences }));
    try {
      const appModule = await import("../src/main/app");
      await appModule.startMenuSproutApp();
      const settingsController = registerIpcHandlers.mock.calls.at(-1)?.[5];

      await Promise.all([
        settingsController.setAppearance("dark"),
        settingsController.setTheme("paper-sketch"),
        settingsController.setAppearance("light"),
      ]);

      expect(nativeTheme.themeSource).toBe("light");
      await expect(preferences.get()).resolves.toEqual({ openAtLogin: false, theme: "paper-sketch", appearance: "light" });
      await expect(settingsController.get()).resolves.toMatchObject({ theme: "paper-sketch", appearance: "light" });
    } finally {
      vi.doUnmock("../src/main/preferences");
      await rm(userDataDir, { recursive: true, force: true });
    }
  });

  it("does not touch login items in source dev mode", async () => {
    const appModule = await import("../src/main/app");

    await appModule.startMenuSproutApp();

    expect(electronApp.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it.each(["Menu Sprout Dev", "Menu Sprout Test"])(
    "does not touch login items for the packaged %s bundle",
    async (appName) => {
      electronApp.isPackaged = true;
      electronApp.getPath.mockImplementation((name: string) => {
        if (name === "home") return "/home/test-user";
        if (name === "exe") return `/tmp/${appName}.app/Contents/MacOS/${appName}`;
        return "/tmp";
      });
      Object.defineProperty(process, "resourcesPath", {
        configurable: true,
        value: `/tmp/${appName}.app/Contents/Resources`,
      });
      const appModule = await import("../src/main/app");

      await appModule.startMenuSproutApp();

      expect(electronApp.setLoginItemSettings).not.toHaveBeenCalled();
    },
  );

  it("opts the packaged production app into opening at login by default", async () => {
    electronApp.isPackaged = true;
    electronApp.getPath.mockImplementation((name: string) => {
      if (name === "home") return "/home/test-user";
      if (name === "exe") return "/Applications/Menu Sprout.app/Contents/MacOS/Menu Sprout";
      return "/tmp";
    });
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      value: "/Applications/Menu Sprout.app/Contents/Resources",
    });
    const appModule = await import("../src/main/app");

    await appModule.startMenuSproutApp();

    expect(electronApp.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
  });

  it("temporarily uses regular activation policy while the macOS popover is visible", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    const appModule = await import("../src/main/app");

    await appModule.startMenuSproutApp();
    const onTrayClick = createMenuSproutTray.mock.calls.at(-1)?.[0];
    await onTrayClick?.({ x: 100, y: 10, width: 24, height: 24 });

    await vi.waitFor(() =>
      expect((electronApp as { setActivationPolicy: ReturnType<typeof vi.fn> }).setActivationPolicy).toHaveBeenCalledWith(
        "regular",
      ),
    );
    expect((electronApp as { focus: ReturnType<typeof vi.fn> }).focus).toHaveBeenCalledWith({ steal: true });

    const onHide = browserWindowInstance.on.mock.calls.find(([event]) => event === "hide")?.[1];
    onHide?.();

    expect((electronApp as { setActivationPolicy: ReturnType<typeof vi.fn> }).setActivationPolicy).toHaveBeenLastCalledWith(
      "accessory",
    );
  });
  it("starts the menu-bar item manager on the extension workspace and stops it on quit", async () => {
    const { createMenuBarItemManager } = await import("../src/main/menu-bar-items");
    const appModule = await import("../src/main/app");

    await appModule.startMenuSproutApp();

    const options = (createMenuBarItemManager as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    const manager = (createMenuBarItemManager as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value;
    expect(options.watchDir).toBe("/repo/extensions");
    expect(manager.start).toHaveBeenCalledTimes(1);

    const beforeQuit = electronApp.on.mock.calls.find(([event]) => event === "before-quit")?.[1];
    beforeQuit?.();
    expect(manager.stop).toHaveBeenCalledTimes(1);
  });

  it("shares one server module loader across actions, background tasks, and menu-bar items", async () => {
    const registry = await import("../src/main/server-action-registry");
    const appModule = await import("../src/main/app");

    await appModule.startMenuSproutApp();

    const loader = (registry.createServerModuleLoader as ReturnType<typeof vi.fn>).mock.results.at(-1)?.value;
    expect(loader).toBeDefined();
    for (const factory of [registry.createServerActionRegistry, registry.createBackgroundTaskSource, registry.createMenuBarItemSource]) {
      expect((factory as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0].loader).toBe(loader);
    }
  });

  it("opens the popover under the clicked menu-bar item", async () => {
    const { createMenuBarItemManager } = await import("../src/main/menu-bar-items");
    const appModule = await import("../src/main/app");

    await appModule.startMenuSproutApp();
    const options = (createMenuBarItemManager as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    options.onActivate({ x: 400, y: 0, width: 50, height: 24 });

    await vi.waitFor(() => expect(browserWindowInstance.show).toHaveBeenCalled());
    expect(browserWindowInstance.setBounds).toHaveBeenCalledWith({ x: 173, y: 32, width: 504, height: 620 });
  });
});
