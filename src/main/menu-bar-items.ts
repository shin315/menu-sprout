import { realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { MenuSproutMenuBarState, MenuSproutServerContext } from "../shared/contracts";
import type { DiscoveredMenuBarItem, MenuBarItemSource } from "./server-action-registry";

// Menu-bar space is shared and scarce, and each item is polled by the host on its own
// timer, so the framework enforces hard limits. Widgets cannot raise them.
export const MIN_MENU_BAR_INTERVAL_MS = 1_000;
export const MAX_MENU_BAR_ITEMS = 5;
export const MAX_MENU_BAR_TEXT_LENGTH = 24;
export const MAX_MENU_BAR_TOOLTIP_LENGTH = 120;
export const MAX_MENU_BAR_ICON_BYTES = 65_536;
// Node fires a timer with a longer delay after 1ms, so longer cadences are capped here.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

const DEFAULT_WATCH_DEBOUNCE_MS = 300;
const DATA_URL_PREFIX = "data:image/png;base64,";

export type MenuBarBounds = { x: number; y: number; width: number; height: number };

// A validated, size-limited state ready to render. Always has `text` or `icon`.
export type NormalizedMenuBarState = {
  text?: string;
  icon?: string;
  tooltip?: string;
};

// The native side of one item (an Electron Tray in the app, a fake in tests). It is
// created lazily when the item first has something to show and destroyed when the
// item has nothing to show, so a hidden item holds no menu-bar space. `icon` is the
// already validated `state.icon`, or null when there is none or it was refused.
// `update` returns false when nothing could be shown (no text and no loadable icon).
export type MenuBarItemView = {
  update: (state: NormalizedMenuBarState, icon: ResolvedMenuBarIcon | null) => boolean;
  destroy: () => void;
};

export type CreateMenuBarItemView = (options: {
  extensionId: string;
  onClick: (bounds: MenuBarBounds) => void;
}) => MenuBarItemView;

export type MenuBarItemManager = {
  start: () => Promise<void>;
  resync: () => Promise<void>;
  stop: () => void;
};

export type MenuBarItemManagerOptions = {
  source: MenuBarItemSource;
  context: MenuSproutServerContext;
  createView: CreateMenuBarItemView;
  onActivate?: (bounds: MenuBarBounds) => void;
  // Directory to watch so added, edited, removed, or undone items are picked up without a restart.
  watchDir?: string;
  minIntervalMs?: number;
  maxItems?: number;
  watchDebounceMs?: number;
  onError?: (extensionId: string, error: unknown) => void;
};

type ManagedItem = {
  extensionId: string;
  extensionDir: string;
  intervalMs: number; // effective cadence after clamping
  run: DiscoveredMenuBarItem["run"];
  // The run function currently executing, if any.
  inFlight: DiscoveredMenuBarItem["run"] | null;
  removed: boolean;
  timer?: ReturnType<typeof setInterval>;
  view: MenuBarItemView | null;
  lastKey: string | null;
};

export function normalizeMenuBarState(value: unknown): NormalizedMenuBarState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as MenuSproutMenuBarState;

  const text = typeof candidate.text === "string" ? truncate(collapseWhitespace(candidate.text), MAX_MENU_BAR_TEXT_LENGTH) : "";
  const icon = typeof candidate.icon === "string" ? candidate.icon.trim() : "";
  if (!text && !icon) return null;

  const tooltip =
    typeof candidate.tooltip === "string" ? truncate(collapseWhitespace(candidate.tooltip), MAX_MENU_BAR_TOOLTIP_LENGTH) : "";

  const state: NormalizedMenuBarState = {};
  if (text) state.text = text;
  if (icon) state.icon = icon;
  if (tooltip) state.tooltip = tooltip;
  return state;
}

function collapseWhitespace(value: string): string {
  // Control characters (including newlines and tabs) become spaces so the title stays on one line.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
}

function truncate(value: string, maxLength: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxLength) return value;
  return `${characters.slice(0, maxLength - 1).join("").trimEnd()}…`;
}

// A file icon carries its modification time and size so an icon redrawn in place is reloaded.
export type ResolvedMenuBarIcon =
  | { kind: "data"; dataUrl: string }
  | { kind: "file"; path: string; mtimeMs: number; size: number };

// Resolves a widget-supplied icon to something safe to load: a bounded PNG data URL, or a
// `.png` file that lives inside the extension folder (symlinks may not escape it). Anything
// else resolves to null and the item simply renders without an icon.
export function resolveMenuBarIcon(icon: string, extensionDir: string): ResolvedMenuBarIcon | null {
  if (icon.startsWith(DATA_URL_PREFIX)) {
    return icon.length <= MAX_MENU_BAR_ICON_BYTES ? { kind: "data", dataUrl: icon } : null;
  }
  if (isAbsolute(icon) || !/\.png$/i.test(icon)) return null;

  try {
    const root = realpathSync(extensionDir);
    const target = realpathSync(resolve(root, icon));
    const fromRoot = relative(root, target);
    if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return null;
    const stats = statSync(target);
    if (!stats.isFile() || stats.size > MAX_MENU_BAR_ICON_BYTES) return null;
    return { kind: "file", path: target, mtimeMs: stats.mtimeMs, size: stats.size };
  } catch {
    return null;
  }
}

export function createMenuBarItemManager(options: MenuBarItemManagerOptions): MenuBarItemManager {
  const minIntervalMs = options.minIntervalMs ?? MIN_MENU_BAR_INTERVAL_MS;
  const maxItems = options.maxItems ?? MAX_MENU_BAR_ITEMS;
  const debounceMs = options.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS;
  const onError = options.onError ?? defaultOnError;
  const items = new Map<string, ManagedItem>();

  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let resyncGeneration = 0;
  let warnedAboutLimit = false;

  const effectiveInterval = (intervalMs: number): number => Math.min(Math.max(intervalMs, minIntervalMs), MAX_TIMER_DELAY_MS);

  const hide = (item: ManagedItem): void => {
    item.view?.destroy();
    item.view = null;
    item.lastKey = null;
  };

  // Only touches the native item when the visible state (including the icon file on disk)
  // actually changed, so a run that returns the same text every second costs nothing.
  const apply = (item: ManagedItem, state: NormalizedMenuBarState | null): void => {
    if (!state) {
      hide(item);
      return;
    }
    const icon = state.icon ? resolveMenuBarIcon(state.icon, item.extensionDir) : null;
    const key = JSON.stringify([state, icon]);
    if (key === item.lastKey && item.view) return;

    item.view ??= options.createView({
      extensionId: item.extensionId,
      onClick: (bounds) => options.onActivate?.(bounds),
    });
    if (!item.view.update(state, icon)) {
      hide(item);
      return;
    }
    item.lastKey = key;
  };

  // The in-flight guard keeps a slow run from stacking up: a tick that arrives while the
  // same run function is still going is skipped. A hot-reloaded run is not blocked by the
  // old one, and the old one's late result is dropped. A failing run keeps the last shown
  // state rather than flickering the item away.
  const tick = async (item: ManagedItem): Promise<void> => {
    const run = item.run;
    if (item.inFlight === run || item.removed) return;
    item.inFlight = run;
    try {
      const result = await run(options.context);
      // The item may have been removed (widget deleted, turn undone) or its code replaced while `run` was in flight.
      if (item.removed || disposed || item.run !== run) return;
      apply(item, normalizeMenuBarState(result));
    } catch (error) {
      onError(item.extensionId, error);
    } finally {
      if (item.inFlight === run) item.inFlight = null;
    }
  };

  const startTimer = (item: ManagedItem): void => {
    item.timer = setInterval(() => void tick(item), item.intervalMs);
    item.timer.unref?.();
  };

  const schedule = (discovered: DiscoveredMenuBarItem): void => {
    const item: ManagedItem = {
      extensionId: discovered.extensionId,
      extensionDir: discovered.extensionDir,
      intervalMs: effectiveInterval(discovered.intervalMs),
      run: discovered.run,
      inFlight: null,
      removed: false,
      view: null,
      lastKey: null,
    };
    startTimer(item);
    items.set(item.extensionId, item);
    void tick(item);
  };

  const remove = (item: ManagedItem): void => {
    item.removed = true;
    clearInterval(item.timer);
    hide(item);
    items.delete(item.extensionId);
  };

  const resync = async (): Promise<void> => {
    if (disposed) return;
    // Only the most recently started discovery may apply its result, so an older, slower
    // listing can never resurrect an item that a newer one already removed.
    const generation = ++resyncGeneration;
    const discovered = await options.source.list();
    if (disposed || generation !== resyncGeneration) return;

    const unique = new Map<string, DiscoveredMenuBarItem>();
    for (const item of [...discovered].sort((a, b) => a.extensionId.localeCompare(b.extensionId))) {
      if (!unique.has(item.extensionId)) unique.set(item.extensionId, item);
    }
    const accepted = [...unique.values()].slice(0, maxItems);
    if (unique.size > maxItems && !warnedAboutLimit) {
      warnedAboutLimit = true;
      console.warn(
        `[menu-sprout] at most ${maxItems} menu-bar items are shown; ignoring ${[...unique.keys()].slice(maxItems).join(", ")}`,
      );
    } else if (unique.size <= maxItems) {
      warnedAboutLimit = false;
    }
    const byId = new Map(accepted.map((item) => [item.extensionId, item]));

    for (const item of [...items.values()]) {
      if (!byId.has(item.extensionId)) remove(item);
    }

    for (const next of accepted) {
      const existing = items.get(next.extensionId);
      if (!existing) {
        schedule(next);
        continue;
      }
      existing.extensionDir = next.extensionDir;
      const nextInterval = effectiveInterval(next.intervalMs);
      if (nextInterval !== existing.intervalMs) {
        clearInterval(existing.timer);
        existing.intervalMs = nextInterval;
        startTimer(existing);
      }
      // A code edit swaps the run function; show its result right away instead of waiting a full interval.
      if (existing.run !== next.run) {
        existing.run = next.run;
        void tick(existing);
      }
    }
  };

  const scheduleDebouncedResync = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void resync().catch((error) => onError("*", error));
    }, debounceMs);
    debounceTimer.unref?.();
  };

  return {
    async start() {
      disposed = false;
      await resync();
      if (!options.watchDir) return;
      try {
        watcher = watch(options.watchDir, { recursive: true }, () => scheduleDebouncedResync());
      } catch {
        // A missing or unwatchable directory is not fatal; items found at start still
        // update, they just will not hot-reload until the next start.
        watcher = null;
      }
    },
    resync,
    stop() {
      disposed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      watcher?.close();
      watcher = null;
      for (const item of [...items.values()]) remove(item);
    },
  };
}

function defaultOnError(extensionId: string, error: unknown): void {
  console.error(`[menu-sprout] menu-bar item "${extensionId}" failed`, error);
}
