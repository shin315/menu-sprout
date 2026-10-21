import { beforeEach, describe, expect, it, vi } from "vitest";

const windows: FakeWindow[] = [];

class FakeWindow {
  destroyed = false;
  readonly webContents = {
    id: 100 + windows.length,
    executeJavaScript: vi.fn(async () => ({ found: true })),
    capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from("png-bytes") })),
  };
  readonly setSize = vi.fn();
  constructor(readonly options: Record<string, any>) {
    windows.push(this);
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
  }
  loadURL = vi.fn(async () => undefined);
  loadFile = vi.fn(async () => undefined);
}

vi.mock("electron", () => ({ BrowserWindow: FakeWindow }));

describe("electron capture surface", () => {
  beforeEach(() => {
    windows.length = 0;
  });

  async function setup(overrides: Record<string, unknown> = {}) {
    const { createElectronCaptureSurfaces } = await import("../src/main/widget-capture-window");
    return createElectronCaptureSurfaces({
      preloadPath: "/app/out/preload/index.cjs",
      rendererUrl: undefined,
      rendererFile: "/app/out/renderer/index.html",
      isPackaged: true,
      getSize: () => ({ width: 504, height: 620 }),
      ...overrides,
    });
  }

  it("opens a hidden, unfocusable window that keeps the popover security flags", async () => {
    const { createSurface } = await setup();

    createSurface();

    const { options } = windows[0];
    expect(options).toMatchObject({
      show: false,
      alwaysOnTop: false,
      focusable: false,
      width: 504,
      height: 620,
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    expect(options.webPreferences.preload).toBe("/app/out/preload/index.cjs");
  });

  it("loads the packaged renderer file", async () => {
    const { createSurface } = await setup();

    await createSurface().load();

    expect(windows[0].loadFile).toHaveBeenCalledWith("/app/out/renderer/index.html");
  });

  it("captures the requested rect via capturePage without showing the window", async () => {
    const { createSurface } = await setup();
    const surface = createSurface();

    const png = await surface.capture({ x: 0, y: 10, width: 300, height: 200 });

    expect(windows[0].webContents.capturePage).toHaveBeenCalledWith(
      { x: 0, y: 10, width: 300, height: 200 },
      { stayHidden: true, stayAwake: true },
    );
    expect(png.toString()).toBe("png-bytes");
  });

  it("evaluates scripts in the page", async () => {
    const { createSurface } = await setup();
    const surface = createSurface();

    await expect(surface.evaluate("1 + 1")).resolves.toEqual({ found: true });
    expect(windows[0].webContents.executeJavaScript).toHaveBeenCalledWith("1 + 1");
  });

  it("registers the window while open so its size reports can be routed, and forgets it on close", async () => {
    const { createSurface, registry } = await setup();
    const surface = createSurface();
    const id = windows[0].webContents.id;

    expect(registry.has(id)).toBe(true);
    expect(registry.has(1)).toBe(false);
    registry.resize(id, { width: 600, height: 480 });
    expect(windows[0].setSize).toHaveBeenCalledWith(600, 480);

    surface.close();

    expect(windows[0].destroyed).toBe(true);
    expect(registry.has(id)).toBe(false);
    registry.resize(id, { width: 1, height: 1 });
    expect(windows[0].setSize).toHaveBeenCalledOnce();
  });
});
