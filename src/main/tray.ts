import { Menu, nativeImage, Tray, type NativeImage, type Rectangle } from "electron";
import type { CreateMenuBarItemView, MenuBarItemView, NormalizedMenuBarState, ResolvedMenuBarIcon } from "./menu-bar-items";

export type MenuSproutTray = {
  tray: Tray;
  getBounds: () => Rectangle;
};

// Native right-click actions that work even when the popover renderer is broken.
export type MenuSproutTrayMenuActions = {
  open: () => void;
  reload: () => void;
  quit: () => void;
};

export type MenuSproutTrayOptions = {
  iconPath: string;
  menu?: MenuSproutTrayMenuActions;
};

export function createMenuSproutTray(onClick: (bounds: Rectangle) => void, options: MenuSproutTrayOptions): MenuSproutTray {
  const icon = nativeImage.createFromPath(options.iconPath);
  icon.setTemplateImage(true);

  const tray = new Tray(icon);
  tray.setToolTip("menu-sprout");
  tray.on("click", (_event, bounds) => onClick(bounds));

  // Popped up on right-click rather than set with setContextMenu, which on macOS
  // would take over left-click and stop it from opening the popover.
  const actions = options.menu;
  if (actions) {
    tray.on("right-click", () => {
      tray.popUpContextMenu(
        Menu.buildFromTemplate([
          { label: "Open menu_sprout", click: () => actions.open() },
          { label: "Reload", click: () => actions.reload() },
          { type: "separator" },
          { label: "Quit menu_sprout", click: () => actions.quit() },
        ]),
      );
    });
  }

  return {
    tray,
    getBounds: () => tray.getBounds(),
  };
}

// Menu-bar icons are drawn about this tall; anything taller is scaled down to fit.
const MENU_BAR_ICON_MAX_HEIGHT = 22;
const MENU_BAR_ICON_HEIGHT = 16;

function loadMenuBarIconImage(resolved: ResolvedMenuBarIcon | null): NativeImage | null {
  if (!resolved) return null;

  let image = resolved.kind === "data" ? nativeImage.createFromDataURL(resolved.dataUrl) : nativeImage.createFromPath(resolved.path);
  if (image.isEmpty()) return null;
  if (image.getSize().height > MENU_BAR_ICON_MAX_HEIGHT) image = image.resize({ height: MENU_BAR_ICON_HEIGHT });
  // Always a template image so the icon follows the light/dark menu bar and the host
  // never has to trust widget-authored colors.
  image.setTemplateImage(true);
  return image;
}

// One widget's own menu-bar item: a separate Tray whose title and icon the host updates
// from the widget's `menuBar` state. The Tray exists only while there is something to show.
export const createMenuBarItemView: CreateMenuBarItemView = ({ extensionId, onClick }): MenuBarItemView => {
  let tray: Tray | null = null;
  let loadedIconKey: string | undefined;
  let image: NativeImage | null = null;

  const destroy = () => {
    tray?.destroy();
    tray = null;
  };

  return {
    update(state: NormalizedMenuBarState, icon: ResolvedMenuBarIcon | null) {
      const iconKey = JSON.stringify(icon);
      if (!tray || iconKey !== loadedIconKey) {
        image = loadMenuBarIconImage(icon);
        loadedIconKey = iconKey;
      }
      // An unloadable icon with no text would leave an invisible zero-width item.
      if (!image && !state.text) {
        destroy();
        return false;
      }

      const nativeIcon = image ?? nativeImage.createEmpty();
      if (!tray) {
        tray = new Tray(nativeIcon);
        tray.on("click", (_event, bounds) => onClick(bounds));
      } else {
        tray.setImage(nativeIcon);
      }
      // Monospaced digits keep a clock or percentage from jittering the item's width.
      tray.setTitle(state.text ?? "", { fontType: "monospacedDigit" });
      tray.setToolTip(state.tooltip ?? state.text ?? extensionId);
      return true;
    },
    destroy,
  };
};
