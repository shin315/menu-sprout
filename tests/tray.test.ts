import { beforeEach, describe, expect, it, vi } from "vitest";

const image = {
  setTemplateImage: vi.fn(),
};

const tray = {
  getBounds: vi.fn(),
  on: vi.fn(),
  popUpContextMenu: vi.fn(),
  setContextMenu: vi.fn(),
  setTitle: vi.fn(),
  setToolTip: vi.fn(),
};

type MenuItemTemplate = { label?: string; type?: string; click?: () => void };
const buildFromTemplate = vi.fn((template: MenuItemTemplate[]) => ({ template }));

const createFromPath = vi.fn((_path: string) => image);
const Tray = vi.fn(function MockTray() {
  return tray;
});

vi.mock("electron", () => ({
  Menu: { buildFromTemplate },
  nativeImage: { createFromPath },
  Tray,
}));

function trayHandler(event: string) {
  const call = tray.on.mock.calls.find(([name]) => name === event);
  return call?.[1] as ((...args: unknown[]) => void) | undefined;
}

describe("createMenuSproutTray", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a template menu bar icon from the packaged tray asset", async () => {
    const { createMenuSproutTray } = await import("../src/main/tray");

    createMenuSproutTray(vi.fn(), { iconPath: "/repo/assets/tray/menu_sproutTemplate.png" });

    expect(createFromPath).toHaveBeenCalledWith("/repo/assets/tray/menu_sproutTemplate.png");
    expect(image.setTemplateImage).toHaveBeenCalledWith(true);
    expect(Tray).toHaveBeenCalledWith(image);
    expect(tray.setTitle).not.toHaveBeenCalled();
    expect(tray.setToolTip).toHaveBeenCalledWith("menu-sprout");
  });

  it("pops up a native Open / Reload / Quit menu on right-click without replacing the left-click popover", async () => {
    const { createMenuSproutTray } = await import("../src/main/tray");
    const onClick = vi.fn();
    const actions = { open: vi.fn(), reload: vi.fn(), quit: vi.fn() };

    createMenuSproutTray(onClick, { iconPath: "/repo/assets/tray/menu_sproutTemplate.png", menu: actions });

    // A context menu set with setContextMenu would hijack left-click on macOS.
    expect(tray.setContextMenu).not.toHaveBeenCalled();
    trayHandler("click")?.({}, { x: 1, y: 2, width: 3, height: 4 });
    expect(onClick).toHaveBeenCalledWith({ x: 1, y: 2, width: 3, height: 4 });

    trayHandler("right-click")?.({}, { x: 1, y: 2, width: 3, height: 4 });
    expect(tray.popUpContextMenu).toHaveBeenCalledTimes(1);
    const template = buildFromTemplate.mock.calls.at(-1)?.[0] ?? [];
    const items = template.filter((item) => item.type !== "separator");
    expect(items.map((item) => item.label)).toEqual(["Open menu_sprout", "Reload", "Quit menu_sprout"]);

    items.forEach((item) => item.click?.());
    expect(actions.open).toHaveBeenCalledTimes(1);
    expect(actions.reload).toHaveBeenCalledTimes(1);
    expect(actions.quit).toHaveBeenCalledTimes(1);
  });
});
