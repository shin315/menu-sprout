import { BrowserWindow } from "electron";
import { createPopoverOptions, loadPopoverRenderer, type Size } from "./popover";
import type { CaptureRect, WidgetCaptureSurface } from "./widget-capture";

export type CaptureWindowRegistry = {
  /** True for webContents ids that belong to a capture window (not the user's popover). */
  has(webContentsId: number): boolean;
  /** Resize a capture window to the content size its renderer reported. */
  resize(webContentsId: number, size: Size): void;
};

export type ElectronCaptureSurfaceOptions = {
  preloadPath: string;
  rendererUrl: string | undefined;
  rendererFile: string;
  isPackaged: boolean;
  /** Initial window size: whatever size the real popover is currently using. */
  getSize: () => Size;
};

/**
 * Renders a fresh, hidden copy of the popover so a capture always reflects the
 * widget files as they are right now and never disturbs the user's popover
 * (its chat, scroll position, or visibility). The window uses the same
 * security flags as the popover and never shows.
 */
export function createElectronCaptureSurfaces(options: ElectronCaptureSurfaceOptions): {
  createSurface: () => WidgetCaptureSurface;
  registry: CaptureWindowRegistry;
} {
  const windows = new Map<number, BrowserWindow>();

  const registry: CaptureWindowRegistry = {
    has: (id) => windows.has(id),
    resize(id, size) {
      const window = windows.get(id);
      if (!window || window.isDestroyed()) return;
      window.setSize(size.width, size.height);
    },
  };

  function createSurface(): WidgetCaptureSurface {
    const size = options.getSize();
    const base = createPopoverOptions(options.preloadPath);
    const window = new BrowserWindow({
      ...base,
      width: size.width,
      height: size.height,
      show: false,
      alwaysOnTop: false,
      focusable: false,
      webPreferences: {
        ...base.webPreferences,
        // A hidden page otherwise stops animation frames, which the popover
        // renderer uses to measure itself and widgets use to paint.
        backgroundThrottling: false,
      },
    });
    const webContentsId = window.webContents.id;
    windows.set(webContentsId, window);

    return {
      async load() {
        await loadPopoverRenderer(window, options.rendererUrl, options.rendererFile, { isPackaged: options.isPackaged });
      },
      evaluate: <T>(script: string) => window.webContents.executeJavaScript(script) as Promise<T>,
      async capture(rect: CaptureRect) {
        const image = await window.webContents.capturePage(rect, { stayHidden: true, stayAwake: true });
        return image.toPNG();
      },
      close() {
        windows.delete(webContentsId);
        if (!window.isDestroyed()) window.destroy();
      },
    };
  }

  return { createSurface, registry };
}
