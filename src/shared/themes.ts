// Selectable UI themes. Each non-default id has a matching
// `:root[data-theme="<id>"]` block in src/ui/theme.css.
export const THEMES = [
  { id: "default", label: "Default (Monochrome Lab)" },
  { id: "vibrant-glass", label: "Vibrant Glass" },
  { id: "paper-sketch", label: "Paper Sketch" },
  { id: "solarized-garden", label: "Solarized Garden" },
  { id: "retro-terminal", label: "Retro Terminal" },
  { id: "high-contrast", label: "High Contrast" },
  { id: "calm-pastel", label: "Calm Pastel" },
  { id: "vietnamese-heritage", label: "Vietnamese Heritage" },
  { id: "neon-synthwave", label: "Neon Synthwave" },
  { id: "nature-wood", label: "Nature Wood" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

export const DEFAULT_THEME: ThemeId = "default";

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((theme) => theme.id === value);
}

// Light/dark appearance, applied through Electron's nativeTheme.themeSource so
// every renderer's `prefers-color-scheme` (and native controls) follow it.
export const APPEARANCES = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
] as const;

export type AppearanceMode = (typeof APPEARANCES)[number]["id"];

export const DEFAULT_APPEARANCE: AppearanceMode = "system";

export function isAppearanceMode(value: unknown): value is AppearanceMode {
  return APPEARANCES.some((appearance) => appearance.id === value);
}
