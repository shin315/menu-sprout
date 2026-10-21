// AUTO-GENERATED - DO NOT EDIT BY HAND.
// Generated from src/shared/contracts.ts by scripts/generate-extension-dts.mjs.
// Run `pnpm generate:contracts` after changing the extension-facing contract.
//
// This file makes `@menusprout/contracts` resolve inside the extension workspace,
// where the host source (src/shared/contracts.ts) is not present. Import the
// types you need from the stable specifier - never reach back into host paths
// like ../../src/shared/contracts, which do not exist in a packaged install:
//
//   import type { RefreshableMenuSproutWidget, MenuSproutServerContext } from "@menusprout/contracts";
//
// These are type-only imports: the host compiler erases them, so they add no
// runtime dependency and are always allowed. Importing a *value* from this
// specifier will be rejected - there is nothing to import at runtime.

declare module "@menusprout/contracts" {
  import type { ReactNode } from "react";

  // SQL bind parameters: positional (an array) or named (an object keyed by the
  // bare parameter name, e.g. { name } for ":name").
  export type SqlParams = unknown[] | Record<string, unknown>;

  export type SqlRunResult = {
    changes: number;
    lastInsertRowid: number | bigint;
  };

  // The synchronous SQL surface extensions use from server actions and background
  // tasks. The host's ExtensionDatabase implements this plus lifecycle (close).
  export type MenuSproutDatabase = {
    query: <T = Record<string, unknown>>(sql: string, params?: SqlParams) => T[];
    get: <T = Record<string, unknown>>(sql: string, params?: SqlParams) => T | undefined;
    run: (sql: string, params?: SqlParams) => SqlRunResult;
    exec: (sql: string) => void;
    transaction: <T>(fn: () => T) => T;
  };

  export type MenuSproutNotification = {
    title: string;
    body?: string;
  };

  // Passed to every server action and background task. Privileged, main-process side.
  export type MenuSproutServerContext = {
    rootDir: string;
    db: MenuSproutDatabase;
    // Show a native system notification. The main reason a background task is worth
    // having: it can alert the user (e.g. a threshold breach) while the popover is closed.
    notify: (notification: MenuSproutNotification) => void;
  };

  // Declared as `export const background` in an extension's server.ts. The host runs
  // `run` on its own timer (clamped to a 60s floor) whether or not the popover is open,
  // so it is the place for work that must keep happening in the background. Persist
  // results with `context.db` and a widget can read them on open.
  export type MenuSproutBackgroundTask = {
    intervalMs: number;
    run: (context: MenuSproutServerContext) => void | Promise<void>;
    // Whether to run once as soon as the task is scheduled (default true) so data is
    // warm before the first refresh tick.
    runOnStart?: boolean;
  };

  export type BackgroundTaskUpdate = {
    extensionId: string;
  };

  // What a widget's menu-bar item shows right now. At least one of `text` and `icon`
  // must be present, otherwise the item is hidden until a later run returns one.
  export type MenuSproutMenuBarState = {
    // Short live text shown next to (or instead of) the icon. Single line; the host
    // collapses whitespace and truncates it to 24 characters.
    text?: string;
    // A monochrome template icon: either a `data:image/png;base64,...` URL or a
    // `.png` path relative to the extension folder. The host renders it as a
    // template image so it follows the light/dark menu bar.
    icon?: string;
    // Hover text for the item (truncated to 120 characters).
    tooltip?: string;
  };

  // Declared as `export const menuBar` in an extension's server.ts. The host owns the
  // menu-bar item (one per extension, at most 5 in total): it calls `run` on its own
  // timer (clamped to a 1s floor) and shows the returned state. Return `null` to hide
  // the item for now. The item disappears when the extension's server.ts is removed,
  // edited to drop `menuBar`, or an agent turn is undone. Clicking it opens the
  // popover under the item.
  export type MenuSproutMenuBarItem = {
    intervalMs: number;
    run: (context: MenuSproutServerContext) => MenuSproutMenuBarState | null | undefined | Promise<MenuSproutMenuBarState | null | undefined>;
  };

  export type MenuSproutCapabilityDescriptor = {
    id: string;
    extensionId: string;
    action: string;
  };

  export type MenuSproutWidget = {
    id: string;
    title: string;
    render: () => ReactNode;
  };

  // A configuration surface an extension contributes to the Settings page,
  // exported from `widget.tsx` alongside its widget. Renderer-only, like a widget:
  // the host draws the section frame (title, dividers, spacing) and the extension
  // owns only the body. It reads and writes its own configuration through the
  // existing bridges (`window.menuSprout.db`), so no per-extension IPC is added.
  export type MenuSproutSettingsSection = {
    // Matches the extension id; used as the section key and for stable sort order.
    extensionId: string;
    // Terse section label, e.g. "CALENDAR".
    title: string;
    // Body only; the host draws the section frame around it.
    render: () => ReactNode;
  };

  export type RefreshableMenuSproutWidget = MenuSproutWidget &
    (
      | {
          // View refresh re-renders a visible widget. It is owned by the host and
          // paused while the popover is hidden. It is not a way to sync data in the
          // background - declare a `background` task in server.ts for that.
          viewRefreshIntervalMs?: number;
          refreshView: () => void | Promise<void>;
        }
      | {
          viewRefreshIntervalMs?: never;
          refreshView?: never;
        }
    );

  // The metadata the host hands a custom layout for each active extension so it
  // can decide what to place and where. The layout never imports widget files
  // directly; it places each one by id through `renderWidget`.
  export type MenuSproutLayoutWidget = {
    id: string;
    title: string;
  };

  // Props the host passes to the default export of `layout.tsx`. `renderWidget`
  // returns the refresh-wired, title-less render of one extension by id (null for
  // an unknown id), so the layout keeps the host's view-refresh wiring while
  // owning the arrangement and the overall canvas size (the host measures the
  // rendered layout and resizes the popover to fit its width and height).
  export type MenuSproutLayoutProps = {
    widgets: MenuSproutLayoutWidget[];
    renderWidget: (id: string) => ReactNode;
  };

  // The default export shape of an `extensions/layout.tsx` module.
  export type MenuSproutLayout = (props: MenuSproutLayoutProps) => ReactNode;

  export type PopoverVisibilityState = {
    visible: boolean;
  };

  // The slice of the window.menuSprout bridge that extension widgets are meant to
  // use: invoking server actions, reading the shared store, reacting to background
  // runs, and the popover visibility signal. Host-only surfaces (git, agent,
  // settings, app, recipes, widgets) are deliberately excluded. This is the value
  // side of the `@menusprout/contracts` public surface; see extensions/menusprout-env.d.ts.
  //
  // Written out explicitly (not Pick<MenuSproutApi, ...>) so the codegen in
  // scripts/generate-extension-dts.mjs can copy it verbatim into the shipped
  // declaration file. A type test in tests/extension-contract-surface.test.ts
  // asserts it stays structurally equal to the matching MenuSproutApi members, so
  // the explicit copy and MenuSproutApi cannot silently drift apart.
  export type MenuSproutExtensionApi = {
    capabilities: {
      list: () => Promise<MenuSproutCapabilityDescriptor[]>;
      invoke: <T = unknown>(extensionId: string, action: string, input?: unknown) => Promise<T>;
    };
    db: {
      query: <T = Record<string, unknown>>(sql: string, params?: SqlParams) => Promise<T[]>;
      get: <T = Record<string, unknown>>(sql: string, params?: SqlParams) => Promise<T | undefined>;
      run: (sql: string, params?: SqlParams) => Promise<SqlRunResult>;
      exec: (sql: string) => Promise<void>;
    };
    background: {
      onUpdate: (listener: (event: BackgroundTaskUpdate) => void) => () => void;
    };
    popover: {
      setContentHeight: (height: number) => Promise<{ ok: boolean }>;
      setContentSize: (size: { width: number; height: number }) => Promise<{ ok: boolean }>;
      getVisibility: () => Promise<PopoverVisibilityState>;
      onVisibility: (listener: (state: PopoverVisibilityState) => void) => () => void;
    };
  };
}

interface Window {
  menuSprout?: import("@menusprout/contracts").MenuSproutExtensionApi;
}
