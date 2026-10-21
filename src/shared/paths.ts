import { isAbsolute, join } from "node:path";

export const EXTENSIONS_DIR_ENV = "MENU_SPROUT_EXTENSIONS_DIR";

export function getRepoRoot(): string {
  return process.cwd();
}

export function getRecipesDir(rootDir = getRepoRoot()): string {
  return join(getExtensionsDir(rootDir), "recipes");
}

export function getAgentStateDir(rootDir = getRepoRoot()): string {
  return join(rootDir, ".cache", "menu-sprout", "acp-sessions");
}

export function getExtensionsDir(
  rootDir = getRepoRoot(),
  env: Partial<Pick<NodeJS.ProcessEnv, typeof EXTENSIONS_DIR_ENV>> = process.env,
): string {
  const configured = env[EXTENSIONS_DIR_ENV];
  if (!configured) return join(rootDir, "extensions");
  return isAbsolute(configured) ? configured : join(rootDir, configured);
}

export function getDevExtensionSnapshotDir(rootDir = getRepoRoot()): string {
  return join(rootDir, ".cache", "menu-sprout", "dev-extension-snapshots");
}
