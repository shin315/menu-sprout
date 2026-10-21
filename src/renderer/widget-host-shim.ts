export function installWidgetHostShims(target: Window, React: unknown, jsxRuntime: unknown, ui: unknown) {
  target.__MENU_SPROUT_WIDGET_HOST__ = { React, jsxRuntime, ui };
}
