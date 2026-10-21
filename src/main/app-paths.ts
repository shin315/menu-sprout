import { app } from "electron";
import { isAbsolute, join } from "node:path";
import { EXTENSIONS_DIR_ENV } from "../shared/paths";

export type MenuSproutRuntimePaths = {
  appDataRoot: string;
  sourceRoot: string;
  extensionsDir: string;
  recipesDir: string;
  cacheDir: string;
  widgetCacheDir: string;
  serverActionCacheDir: string;
  agentStateDir: string;
  devExtensionSnapshotDir: string;
  bundledExtensionTemplateDir: string | null;
  trayIconPath: string;
  databasePath: string;
  /** Directory holding the bundled clean-room ACP adapters (out/adapters/<name>/index.js). */
  adaptersDir: string;
  isPackaged: boolean;
};

type MenuSproutPathEnv = Partial<Pick<NodeJS.ProcessEnv, typeof EXTENSIONS_DIR_ENV | "MENU_SPROUT_PACKAGED_TEST_HOME">>;

type CreateMenuSproutRuntimePathsOptions = {
  isPackaged: boolean;
  sourceRoot: string;
  env?: MenuSproutPathEnv;
  homeDir?: string;
  resourcesPath?: string;
};

export function createMenuSproutRuntimePaths(options: CreateMenuSproutRuntimePathsOptions): MenuSproutRuntimePaths {
  if (!options.isPackaged) {
    const cacheDir = join(options.sourceRoot, ".cache", "menu-sprout");
    const extensionsDir = resolveSourceExtensionsDir(options.sourceRoot, options.env);
    return {
      appDataRoot: options.sourceRoot,
      sourceRoot: options.sourceRoot,
      extensionsDir,
      recipesDir: join(extensionsDir, "recipes"),
      cacheDir,
      widgetCacheDir: join(cacheDir, "widgets"),
      serverActionCacheDir: join(cacheDir, "server-actions"),
      agentStateDir: join(cacheDir, "acp-sessions"),
      devExtensionSnapshotDir: join(cacheDir, "dev-extension-snapshots"),
      bundledExtensionTemplateDir: null,
      trayIconPath: join(options.sourceRoot, "assets", "tray", "menu_sproutTemplate.png"),
      databasePath: join(cacheDir, "menu-sprout.db"),
      // Dev/source: adapters are esbuild-bundled into the checkout's out/.
      adaptersDir: join(options.sourceRoot, "out", "adapters"),
      isPackaged: false,
    };
  }

  if (!options.homeDir) throw new Error("homeDir is required for packaged Menu Sprout paths");
  if (!options.resourcesPath) throw new Error("resourcesPath is required for packaged Menu Sprout paths");

  const appDataRoot = join(options.homeDir, ".menu-sprout");
  const cacheDir = join(appDataRoot, "cache");
  const extensionsDir = join(appDataRoot, "extensions");
  return {
    appDataRoot,
    sourceRoot: options.sourceRoot,
    extensionsDir,
    recipesDir: join(extensionsDir, "recipes"),
    cacheDir,
    widgetCacheDir: join(cacheDir, "widgets"),
    serverActionCacheDir: join(cacheDir, "server-actions"),
    agentStateDir: join(cacheDir, "acp-sessions"),
    devExtensionSnapshotDir: join(cacheDir, "snapshots"),
    bundledExtensionTemplateDir: join(options.resourcesPath, "extensions-template"),
    trayIconPath: join(options.resourcesPath, "tray", "menu_sproutTemplate.png"),
    databasePath: join(appDataRoot, "menu-sprout.db"),
    // Packaged: adapters are asar-unpacked (a standalone Node process cannot read
    // inside app.asar), so they live alongside the asar in app.asar.unpacked.
    adaptersDir: join(options.resourcesPath, "app.asar.unpacked", "out", "adapters"),
    isPackaged: true,
  };
}

export function resolveMenuSproutRuntimePaths(sourceRoot: string): MenuSproutRuntimePaths {
  return createMenuSproutRuntimePaths({
    isPackaged: app.isPackaged,
    sourceRoot,
    env: process.env,
    homeDir: app.isPackaged ? resolvePackagedHomeDir(app.getPath("home"), process.env) : undefined,
    resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
  });
}

export function resolvePackagedHomeDir(defaultHomeDir: string, env: MenuSproutPathEnv = process.env): string {
  return env.MENU_SPROUT_PACKAGED_TEST_HOME?.trim() || defaultHomeDir;
}

function resolveSourceExtensionsDir(
  sourceRoot: string,
  env: MenuSproutPathEnv = process.env,
): string {
  const configured = env[EXTENSIONS_DIR_ENV];
  if (!configured) return join(sourceRoot, "extensions");
  return isAbsolute(configured) ? configured : join(sourceRoot, configured);
}
