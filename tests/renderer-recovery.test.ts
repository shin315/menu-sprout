import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachRendererRecovery, RENDERER_RELOAD_GUARD_MS } from "../src/main/renderer-recovery";

// Models what a real Electron 42 run showed: reload() called after
// forcefullyCrashRenderer() but before that kill's render-process-gone has been
// delivered does nothing, and the webContents is left crashed with no renderer.
function fakeContents() {
  const emitter = new EventEmitter();
  let killPending = false;
  let crashed = false;
  const contents = Object.assign(emitter, {
    freshRenderers: 0,
    reload: vi.fn(() => {
      if (killPending) return;
      crashed = false;
      contents.freshRenderers += 1;
    }),
    forcefullyCrashRenderer: vi.fn(() => {
      if (!crashed) killPending = true;
    }),
    isCrashed: vi.fn(() => crashed),
    isDestroyed: vi.fn(() => false),
  });
  emitter.on("render-process-gone", () => {
    killPending = false;
    crashed = true;
  });
  return contents;
}

function setup() {
  const contents = fakeContents();
  let now = 1_000_000;
  const log = vi.fn();
  const recovery = attachRendererRecovery(contents, { now: () => now, log });
  return {
    contents,
    recovery,
    log,
    advance(ms: number) {
      now += ms;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("attachRendererRecovery", () => {
  it("reloads once and logs the reason when the renderer process is gone", () => {
    const { contents, log } = setup();

    contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
    // Reloading inside the gone event itself crashed the Electron main process in a
    // real run, so the reload waits for the next tick.
    expect(contents.reload).not.toHaveBeenCalled();
    vi.runAllTimers();

    expect(contents.reload).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("crashed"));
  });

  it("does not reload after a clean exit", () => {
    const { contents } = setup();

    contents.emit("render-process-gone", {}, { reason: "clean-exit", exitCode: 0 });
    vi.runAllTimers();

    expect(contents.reload).not.toHaveBeenCalled();
  });

  it("refuses to reload again within the guard window, so a crash on load cannot loop", () => {
    const { contents, log, advance } = setup();

    contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
    advance(RENDERER_RELOAD_GUARD_MS - 1);
    contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
    vi.runAllTimers();

    expect(contents.reload).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("not reloading"));

    advance(1);
    contents.emit("render-process-gone", {}, { reason: "oom", exitCode: 0 });
    vi.runAllTimers();
    expect(contents.reload).toHaveBeenCalledTimes(2);
  });

  it("restarts a hung renderer in a fresh process once its own kill has torn the old one down", () => {
    const { contents, log } = setup();

    contents.emit("unresponsive");
    expect(contents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("unresponsive"));

    // Killing the hung renderer emits render-process-gone; that one is ours, not a new
    // crash, and only after it has been handled does a reload start a fresh renderer.
    contents.emit("render-process-gone", {}, { reason: "killed", exitCode: 9 });
    vi.runAllTimers();
    expect(contents.freshRenderers).toBe(1);
    expect(contents.reload).toHaveBeenCalledTimes(1);
    expect(contents.isCrashed()).toBe(false);
    expect(log).not.toHaveBeenLastCalledWith(expect.stringContaining("not reloading"));
  });

  it("lets the tray menu restart a renderer that hung again after the automatic reload was used up", () => {
    const { contents, recovery, log, advance } = setup();

    contents.emit("unresponsive");
    contents.emit("render-process-gone", {}, { reason: "killed", exitCode: 9 });
    vi.runAllTimers();
    expect(contents.freshRenderers).toBe(1);
    advance(1_000);
    contents.emit("unresponsive");
    expect(contents.forcefullyCrashRenderer).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("not reloading"));

    recovery.restart();
    expect(contents.forcefullyCrashRenderer).toHaveBeenCalledTimes(2);

    // The kill from the manual restart is ours too: it reloads exactly once into a
    // fresh renderer and is not refused by the automatic reload guard.
    contents.emit("render-process-gone", {}, { reason: "killed", exitCode: 9 });
    vi.runAllTimers();
    expect(contents.freshRenderers).toBe(2);
    expect(contents.reload).toHaveBeenCalledTimes(2);
    expect(contents.isCrashed()).toBe(false);
  });

  it("still recovers a later real crash after the tray menu reloaded an already crashed renderer", () => {
    const { contents, recovery, log, advance } = setup();

    contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
    vi.runAllTimers();
    advance(1_000);
    contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
    vi.runAllTimers();
    expect(contents.reload).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("not reloading"));

    // The renderer is dead: there is no process to kill, so no gone event follows the restart.
    contents.isCrashed.mockReturnValue(true);
    recovery.restart();
    expect(contents.forcefullyCrashRenderer).not.toHaveBeenCalled();
    expect(contents.reload).toHaveBeenCalledTimes(2);
    contents.isCrashed.mockReturnValue(false);

    advance(RENDERER_RELOAD_GUARD_MS);
    contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
    vi.runAllTimers();
    expect(contents.reload).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/; reloading$/));
  });

  it("skips a deferred reload if the window is destroyed before it runs", () => {
    const { contents } = setup();

    contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
    contents.isDestroyed.mockReturnValue(true);
    vi.runAllTimers();

    expect(contents.reload).not.toHaveBeenCalled();
  });

  it("does nothing once the window is destroyed", () => {
    const { contents } = setup();
    contents.isDestroyed.mockReturnValue(true);

    contents.emit("render-process-gone", {}, { reason: "crashed", exitCode: 11 });
    contents.emit("unresponsive");
    vi.runAllTimers();

    expect(contents.reload).not.toHaveBeenCalled();
    expect(contents.forcefullyCrashRenderer).not.toHaveBeenCalled();
  });
});
