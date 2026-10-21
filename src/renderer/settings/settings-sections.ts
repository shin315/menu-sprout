import type { MenuSproutSettingsSection } from "../../shared/contracts";
import { loadExtensionModules, importRuntimeModule, type RuntimeModuleImporter } from "../extension-modules";

// Discovers extension settings sections the same way widgets are discovered:
// load every extension module, pull the exports that match the section shape,
// and sort by extension id for a stable page order.
export async function loadRuntimeSettingsSections(
  importer: RuntimeModuleImporter = importRuntimeModule,
): Promise<MenuSproutSettingsSection[]> {
  const modules = await loadExtensionModules(importer);
  return modules
    .flatMap(settingsSectionsFromModule)
    .sort((left, right) => left.extensionId.localeCompare(right.extensionId));
}

export function settingsSectionsFromModule(module: unknown): MenuSproutSettingsSection[] {
  if (!module || typeof module !== "object") return [];
  const exports = Object.values(module as Record<string, unknown>);
  return exports.filter(isMenuSproutSettingsSection);
}

function isMenuSproutSettingsSection(value: unknown): value is MenuSproutSettingsSection {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<MenuSproutSettingsSection>;
  return (
    typeof candidate.extensionId === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.render === "function"
  );
}
