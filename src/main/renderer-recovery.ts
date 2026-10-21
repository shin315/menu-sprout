// Brings the popover renderer back after it crashes or hangs, so a widget that
// takes the whole renderer down does not leave an empty popover until restart.
// It reloads once; another failure inside the guard window is logged and left
// alone (the tray menu's Reload, via `restart`, is the manual way out), so a
// renderer that dies on every load cannot spin in a reload loop.

export const RENDERER_RELOAD_GUARD_MS = 30_000;

type RenderProcessGoneDetails = { reason: string; exitCode?: number };

export type RecoverableRendererContents = {
  on(event: "render-process-gone", listener: (event: unknown, details: RenderProcessGoneDetails) => void): unknown;
  on(event: "unresponsive", listener: () => void): unknown;
  reload(): void;
  forcefullyCrashRenderer(): void;
  isCrashed(): boolean;
  isDestroyed(): boolean;
};

export type RendererRecoveryOptions = {
  now?: () => number;
  log?: (message: string) => void;
};

export function attachRendererRecovery(contents: RecoverableRendererContents, options: RendererRecoveryOptions = {}) {
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string) => console.error(message));
  let lastReloadAt = Number.NEGATIVE_INFINITY;
  // Set while we kill a hung renderer ourselves, so the render-process-gone that
  // follows is not mistaken for a second, independent failure.
  let expectingOwnKill = false;

  const claimReload = (reason: string): boolean => {
    const at = now();
    if (at - lastReloadAt < RENDERER_RELOAD_GUARD_MS) {
      log(`[menu-sprout] popover renderer ${reason} again within ${RENDERER_RELOAD_GUARD_MS / 1000}s; not reloading (use Reload in the tray menu)`);
      return false;
    }
    lastReloadAt = at;
    log(`[menu-sprout] popover renderer ${reason}; reloading`);
    return true;
  };

  // Reloading synchronously inside the gone event can trip a Chromium CHECK and take
  // the main process down with the renderer; let the teardown finish first.
  const reloadAfterTeardown = () => {
    setTimeout(() => {
      if (!contents.isDestroyed()) contents.reload();
    }, 0);
  };

  contents.on("render-process-gone", (_event, details) => {
    const ownKill = expectingOwnKill;
    expectingOwnKill = false;
    if (contents.isDestroyed()) return;
    if (ownKill && (details.reason === "killed" || details.reason === "crashed")) {
      reloadAfterTeardown();
      return;
    }
    if (details.reason === "clean-exit") return;
    if (!claimReload(`gone (${details.reason}, exit code ${details.exitCode ?? "unknown"})`)) return;
    reloadAfterTeardown();
  });

  // A hung renderer cannot reload itself; kill it and reload from the gone event that
  // follows, because a reload() issued before that event leaves the webContents crashed
  // with no renderer. A renderer that already crashed has no process to kill, and no
  // gone event follows, so it is reloaded directly.
  const restart = () => {
    if (contents.isDestroyed()) return;
    if (contents.isCrashed()) {
      contents.reload();
      return;
    }
    expectingOwnKill = true;
    contents.forcefullyCrashRenderer();
  };

  contents.on("unresponsive", () => {
    if (contents.isDestroyed() || !claimReload("unresponsive")) return;
    restart();
  });

  // Manual restart (tray menu Reload): works on a hung renderer too and is not
  // subject to the automatic reload guard, because the user asked for it.
  return { restart };
}
