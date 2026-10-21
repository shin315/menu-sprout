import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuSproutServerContext } from "../src/shared/contracts";
import {
  MAX_MENU_BAR_ICON_BYTES,
  MAX_MENU_BAR_ITEMS,
  MAX_MENU_BAR_TEXT_LENGTH,
  createMenuBarItemManager,
  normalizeMenuBarState,
  resolveMenuBarIcon,
  type MenuBarItemManagerOptions,
  type MenuBarItemView,
  type NormalizedMenuBarState,
  type ResolvedMenuBarIcon,
} from "../src/main/menu-bar-items";
import type { DiscoveredMenuBarItem, MenuBarItemSource } from "../src/main/server-action-registry";

const context: MenuSproutServerContext = { rootDir: "/repo", db: {} as MenuSproutServerContext["db"], notify: vi.fn() };

function item(overrides: Partial<DiscoveredMenuBarItem> = {}): DiscoveredMenuBarItem {
  return {
    extensionId: "demo",
    sourceFile: "/repo/extensions/demo/server.ts",
    extensionDir: "/repo/extensions/demo",
    intervalMs: 1000,
    run: vi.fn(() => ({ text: "hi" })),
    ...overrides,
  };
}

type FakeView = MenuBarItemView & {
  extensionId: string;
  states: NormalizedMenuBarState[];
  icons: Array<ResolvedMenuBarIcon | null>;
  destroyed: boolean;
  click: (bounds?: { x: number; y: number; width: number; height: number }) => void;
};

// The discovered set is mutable so a test can model a widget being removed, an Undo, or a hot reload.
function harness(initial: DiscoveredMenuBarItem[], options: Partial<MenuBarItemManagerOptions> = {}) {
  let discovered = initial;
  const source: MenuBarItemSource = { list: vi.fn(async () => discovered) };
  const views: FakeView[] = [];
  const onActivate = vi.fn();
  const manager = createMenuBarItemManager({
    source,
    context,
    onActivate,
    createView: ({ extensionId, onClick }) => {
      const view: FakeView = {
        extensionId,
        states: [],
        icons: [],
        destroyed: false,
        update: (state, icon) => {
          view.states.push(state);
          view.icons.push(icon);
          return Boolean(state.text || icon);
        },
        destroy: () => {
          view.destroyed = true;
        },
        click: (bounds = { x: 1, y: 2, width: 3, height: 4 }) => onClick(bounds),
      };
      views.push(view);
      return view;
    },
    ...options,
  });
  return {
    manager,
    views,
    onActivate,
    source,
    set: (next: DiscoveredMenuBarItem[]) => {
      discovered = next;
    },
    liveViews: () => views.filter((view) => !view.destroyed),
    liveIds: () => views.filter((view) => !view.destroyed).map((view) => view.extensionId).sort(),
  };
}

describe("normalizeMenuBarState", () => {
  it("keeps short text, icon, and tooltip", () => {
    expect(normalizeMenuBarState({ text: "42%", icon: "icon.png", tooltip: "cpu" })).toEqual({
      text: "42%",
      icon: "icon.png",
      tooltip: "cpu",
    });
  });

  it("collapses whitespace and control characters onto one line", () => {
    expect(normalizeMenuBarState({ text: "  cpu\n 42%\t\u0007x " })).toEqual({ text: "cpu 42% x" });
  });

  it("truncates long text with an ellipsis to the documented length", () => {
    const state = normalizeMenuBarState({ text: "x".repeat(100) });
    expect(Array.from(state?.text ?? "")).toHaveLength(MAX_MENU_BAR_TEXT_LENGTH);
    expect(state?.text?.endsWith("…")).toBe(true);
  });

  it("truncates by code point so emoji are never split", () => {
    const state = normalizeMenuBarState({ text: "🌱".repeat(40) });
    expect(Array.from(state?.text ?? "")).toHaveLength(MAX_MENU_BAR_TEXT_LENGTH);
    expect(state?.text).not.toContain("\ufffd");
  });

  it("returns null when there is neither text nor icon", () => {
    expect(normalizeMenuBarState(null)).toBeNull();
    expect(normalizeMenuBarState(undefined)).toBeNull();
    expect(normalizeMenuBarState("text")).toBeNull();
    expect(normalizeMenuBarState({})).toBeNull();
    expect(normalizeMenuBarState({ text: "   ", tooltip: "only a tooltip" })).toBeNull();
    expect(normalizeMenuBarState({ text: 5, icon: 7 })).toBeNull();
  });
});

describe("resolveMenuBarIcon", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function workspace() {
    const root = await mkdtemp(join(tmpdir(), "menu-sprout-menubar-"));
    dirs.push(root);
    const extensionDir = join(root, "demo");
    await mkdir(extensionDir, { recursive: true });
    return { root, extensionDir };
  }

  it("accepts a bounded PNG data URL and rejects an oversized or non-PNG one", () => {
    const ok = "data:image/png;base64,AAAA";
    expect(resolveMenuBarIcon(ok, "/nowhere")).toEqual({ kind: "data", dataUrl: ok });
    expect(resolveMenuBarIcon(`data:image/png;base64,${"A".repeat(MAX_MENU_BAR_ICON_BYTES)}`, "/nowhere")).toBeNull();
    expect(resolveMenuBarIcon("data:image/svg+xml;base64,AAAA", "/nowhere")).toBeNull();
  });

  it("resolves a PNG inside the extension folder", async () => {
    const { extensionDir } = await workspace();
    await mkdir(join(extensionDir, "assets"));
    await writeFile(join(extensionDir, "assets", "icon.png"), "png");

    const resolved = resolveMenuBarIcon("assets/icon.png", extensionDir);
    expect(resolved?.kind).toBe("file");
    expect(resolved && resolved.kind === "file" && resolved.path.endsWith(join("assets", "icon.png"))).toBe(true);
  });

  it("rejects absolute paths, traversal, non-PNG files, missing files, and oversized files", async () => {
    const { root, extensionDir } = await workspace();
    await writeFile(join(root, "secret.png"), "png");
    await writeFile(join(extensionDir, "icon.jpg"), "jpg");
    await writeFile(join(extensionDir, "big.png"), Buffer.alloc(MAX_MENU_BAR_ICON_BYTES + 1));

    expect(resolveMenuBarIcon(join(root, "secret.png"), extensionDir)).toBeNull();
    expect(resolveMenuBarIcon("../secret.png", extensionDir)).toBeNull();
    expect(resolveMenuBarIcon("icon.jpg", extensionDir)).toBeNull();
    expect(resolveMenuBarIcon("missing.png", extensionDir)).toBeNull();
    expect(resolveMenuBarIcon("big.png", extensionDir)).toBeNull();
  });

  it("rejects a symlink that escapes the extension folder", async () => {
    const { root, extensionDir } = await workspace();
    await writeFile(join(root, "secret.png"), "png");
    await symlink(join(root, "secret.png"), join(extensionDir, "link.png"));

    expect(resolveMenuBarIcon("link.png", extensionDir)).toBeNull();
  });
});

describe("menu-bar item manager", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shows an item after the first run and updates it on its interval", async () => {
    let n = 0;
    const h = harness([item({ run: vi.fn(() => ({ text: `tick ${++n}` })) })]);

    await h.manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.liveViews()).toHaveLength(1);
    expect(h.views[0]?.states).toEqual([{ text: "tick 1" }]);

    await vi.advanceTimersByTimeAsync(2000);
    expect(h.views[0]?.states.map((state) => state.text)).toEqual(["tick 1", "tick 2", "tick 3"]);
    expect(h.liveIds()).toEqual(["demo"]);

    h.manager.stop();
  });

  it("clamps the interval to the 1s floor so a widget cannot update faster", async () => {
    const run = vi.fn(() => ({ text: "x" }));
    const h = harness([item({ run, intervalMs: 10 })]);

    await h.manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(900);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);

    h.manager.stop();
  });

  it("caps an interval beyond the timer limit instead of letting it fire every millisecond", async () => {
    const run = vi.fn(() => ({ text: "x" }));
    const h = harness([item({ run, intervalMs: Number.MAX_SAFE_INTEGER })]);

    await h.manager.start();
    await vi.advanceTimersByTimeAsync(5000);

    expect(run).toHaveBeenCalledTimes(1);
    h.manager.stop();
  });

  it("reloads an icon file redrawn in place even though the returned state is unchanged", async () => {
    const extensionDir = await mkdtemp(join(tmpdir(), "menu-sprout-icon-edit-"));
    await writeFile(join(extensionDir, "icon.png"), "png");
    const h = harness([item({ extensionDir, run: vi.fn(() => ({ text: "x", icon: "icon.png" })) })]);

    try {
      await h.manager.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.views[0]?.states).toHaveLength(1);
      expect(h.views[0]?.icons[0]).toMatchObject({ kind: "file", size: 3 });

      await writeFile(join(extensionDir, "icon.png"), "redrawn png");
      await vi.advanceTimersByTimeAsync(1000);

      expect(h.views).toHaveLength(1);
      expect(h.views[0]?.states).toHaveLength(2);
      expect(h.views[0]?.icons[1]).toMatchObject({ kind: "file", size: 11 });
    } finally {
      h.manager.stop();
      await rm(extensionDir, { recursive: true, force: true });
    }
  });

  it("only touches the native item when the visible state changed", async () => {
    const h = harness([item({ run: vi.fn(() => ({ text: "same" })) })]);

    await h.manager.start();
    await vi.advanceTimersByTimeAsync(5000);

    expect(h.views[0]?.states).toHaveLength(1);
    h.manager.stop();
  });

  it("hides the item while the widget returns nothing and shows it again later", async () => {
    const results: Array<{ text: string } | null> = [null, { text: "back" }, null];
    let index = 0;
    const h = harness([item({ run: vi.fn(() => results[index++ % results.length]) })]);

    await h.manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.views).toHaveLength(0); // nothing to show yet, so no native item exists

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.liveViews()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.liveViews()).toHaveLength(0);
    expect(h.views[0]?.destroyed).toBe(true);

    h.manager.stop();
  });

  it("drops an item whose view could not show anything and creates a fresh one when it has something to show again", async () => {
    const results = [{ text: "x" }, { icon: "missing.png" }, { icon: "missing.png" }, { text: "x" }];
    let index = 0;
    const h = harness([item({ run: vi.fn(() => results[Math.min(index++, results.length - 1)]) })]);

    await h.manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.liveIds()).toEqual(["demo"]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.views[0]?.destroyed).toBe(true);
    expect(h.liveIds()).toEqual([]);

    await vi.advanceTimersByTimeAsync(2000);
    expect(h.liveIds()).toEqual(["demo"]);
    expect(h.liveViews()[0]?.states.at(-1)).toEqual({ text: "x" });

    h.manager.stop();
  });

  it("keeps the last shown state when a run throws", async () => {
    const run = vi
      .fn<() => { text: string }>()
      .mockReturnValueOnce({ text: "ok" })
      .mockImplementation(() => {
        throw new Error("boom");
      });
    const onError = vi.fn();
    const h = harness([item({ run })], { onError });

    await h.manager.start();
    await vi.advanceTimersByTimeAsync(2000);

    expect(onError).toHaveBeenCalledWith("demo", expect.any(Error));
    expect(h.liveViews()).toHaveLength(1);
    h.manager.stop();
  });

  it("skips a tick while the previous run is still in flight", async () => {
    let release: (() => void) | undefined;
    const run = vi.fn(() => new Promise<{ text: string }>((resolve) => (release = () => resolve({ text: "slow" }))));
    const h = harness([item({ run })]);

    await h.manager.start();
    await vi.advanceTimersByTimeAsync(3500);
    expect(run).toHaveBeenCalledTimes(1);

    release?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    h.manager.stop();
  });

  it("removes the item when the widget is removed or the turn is undone, and restores it on redo", async () => {
    const h = harness([item({ extensionId: "keep" }), item({ extensionId: "gone" })]);

    await h.manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.liveIds()).toEqual(["gone", "keep"]);

    // Widget removed (or the agent turn that added it undone): the next discovery no longer lists it.
    h.set([item({ extensionId: "keep" })]);
    await h.manager.resync();
    expect(h.liveIds()).toEqual(["keep"]);
    expect(h.views.find((view) => view.extensionId === "gone")?.destroyed).toBe(true);

    // Restored (rollback of a removal): it reappears without a restart.
    h.set([item({ extensionId: "keep" }), item({ extensionId: "gone" })]);
    await h.manager.resync();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.liveIds()).toEqual(["gone", "keep"]);

    h.manager.stop();
  });

  it("stops polling a removed item and ignores a run that finishes after removal", async () => {
    let release: (() => void) | undefined;
    const run = vi.fn(() => new Promise<{ text: string }>((resolve) => (release = () => resolve({ text: "late" }))));
    const h = harness([item({ run })]);

    await h.manager.start();
    h.set([]);
    await h.manager.resync();
    release?.();
    await vi.advanceTimersByTimeAsync(5000);

    expect(run).toHaveBeenCalledTimes(1);
    expect(h.views).toHaveLength(0);
    h.manager.stop();
  });

  it("hot reloads: a changed run function shows its result immediately and a changed interval is re-timed", async () => {
    const first = vi.fn(() => ({ text: "v1" }));
    const h = harness([item({ run: first, intervalMs: 5000 })]);

    await h.manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.views[0]?.states.at(-1)).toEqual({ text: "v1" });

    const second = vi.fn(() => ({ text: "v2" }));
    h.set([item({ run: second, intervalMs: 2000 })]);
    await h.manager.resync();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.views).toHaveLength(1); // same native item, updated in place
    expect(h.views[0]?.states.at(-1)).toEqual({ text: "v2" });

    await vi.advanceTimersByTimeAsync(2000);
    expect(second).toHaveBeenCalledTimes(2);
    expect(first).toHaveBeenCalledTimes(1);
    h.manager.stop();
  });

  it("hot reloads past a hung run: the new run starts at once and the old run's late result is dropped", async () => {
    let releaseOld: (() => void) | undefined;
    const old = vi.fn(() => new Promise<{ text: string }>((resolve) => (releaseOld = () => resolve({ text: "old" }))));
    const h = harness([item({ run: old })]);

    await h.manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.views).toHaveLength(0);

    const fresh = vi.fn(() => ({ text: "new" }));
    h.set([item({ run: fresh })]);
    await h.manager.resync();
    await vi.advanceTimersByTimeAsync(0);
    expect(fresh).toHaveBeenCalledTimes(1);
    expect(h.views[0]?.states).toEqual([{ text: "new" }]);

    releaseOld?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.views[0]?.states).toEqual([{ text: "new" }]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(fresh).toHaveBeenCalledTimes(2);
    expect(old).toHaveBeenCalledTimes(1);
    h.manager.stop();
  });

  it("recreates items from discovery after an app restart", async () => {
    const run = vi.fn(() => ({ text: "boot" }));
    const first = harness([item({ run })]);
    await first.manager.start();
    await vi.advanceTimersByTimeAsync(0);
    first.manager.stop();
    expect(first.liveViews()).toHaveLength(0);

    const second = harness([item({ run })]);
    await second.manager.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(second.liveIds()).toEqual(["demo"]);
    second.manager.stop();
  });

  it("caps the number of items, keeping the first by extension id", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const ids = Array.from({ length: MAX_MENU_BAR_ITEMS + 2 }, (_, index) => `ext-${index}`).reverse();
    const h = harness(ids.map((extensionId) => item({ extensionId })));

    await h.manager.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(h.liveIds()).toEqual(ids.slice(2).sort());
    expect(warn).toHaveBeenCalledTimes(1);
    h.manager.stop();
    warn.mockRestore();
  });

  it("forwards a click on an item to onActivate with the item's bounds", async () => {
    const h = harness([item({ extensionId: "clicky" })]);

    await h.manager.start();
    await vi.advanceTimersByTimeAsync(0);
    h.views[0]?.click({ x: 10, y: 0, width: 40, height: 24 });

    expect(h.onActivate).toHaveBeenCalledWith({ x: 10, y: 0, width: 40, height: 24 });
    h.manager.stop();
  });

  it("ignores a stale discovery that finishes after a newer one", async () => {
    const h = harness([item()]);
    let finishSlow: ((items: DiscoveredMenuBarItem[]) => void) | undefined;
    vi.mocked(h.source.list)
      .mockImplementationOnce(() => new Promise((resolve) => (finishSlow = resolve)))
      .mockImplementationOnce(async () => []);

    const slow = h.manager.resync();
    await h.manager.resync();
    finishSlow?.([item()]);
    await slow;

    expect(h.views).toHaveLength(0);
    h.manager.stop();
  });

  it("stop() destroys every native item and halts polling", async () => {
    const run = vi.fn(() => ({ text: "x" }));
    const h = harness([item({ run })]);

    await h.manager.start();
    await vi.advanceTimersByTimeAsync(0);
    h.manager.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(h.liveViews()).toHaveLength(0);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
