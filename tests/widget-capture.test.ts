import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CAPTURE_SETTLE_MS,
  WidgetCaptureError,
  assertOutsideDir,
  captureFileName,
  createWidgetCapturer,
  readPngSize,
  type CaptureRect,
  type WidgetCaptureSurface,
} from "../src/main/widget-capture";

function pngBytes(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

type FakeSurfaceOptions = {
  widgets?: string[];
  /** Ids that only appear after this many probes (async widget discovery). */
  appearAfterProbes?: number;
  rect?: CaptureRect;
  png?: Buffer;
};

function fakeSurface(options: FakeSurfaceOptions = {}) {
  const widgets = options.widgets ?? ["codex-quota"];
  let probes = 0;
  const calls: string[] = [];
  const surface: WidgetCaptureSurface = {
    load: vi.fn(async () => {
      calls.push("load");
    }),
    evaluate: vi.fn(async (script: string) => {
      probes += 1;
      calls.push("evaluate");
      const rendered = probes > (options.appearAfterProbes ?? 0) ? widgets : [];
      const wantedId = /data-widget-id=\\"([^\\"]+)\\"/.exec(script)?.[1];
      const found = wantedId !== undefined && rendered.includes(wantedId);
      return {
        found,
        widgets: rendered,
        rect: found ? (options.rect ?? { x: 0, y: 0, width: 504, height: 320 }) : null,
      };
    }) as WidgetCaptureSurface["evaluate"],
    capture: vi.fn(async () => {
      calls.push("capture");
      return options.png ?? pngBytes(1008, 640);
    }),
    close: vi.fn(() => {
      calls.push("close");
    }),
  };
  return { surface, calls };
}

describe("widget capture", () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), "menu-sprout-capture-"));
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  const noSleep = async () => undefined;

  it("renders a fresh surface, saves the PNG, and reports where it is", async () => {
    const { surface, calls } = fakeSurface();
    const capturer = createWidgetCapturer({
      outputDir,
      createSurface: () => surface,
      sleep: noSleep,
      now: () => new Date(2026, 9, 4, 9, 5, 7, 42),
    });

    const result = await capturer.capture({ widget: "codex-quota" });

    expect(result).toEqual({
      path: join(outputDir, "widget-20261004-090507-042-codex-quota.png"),
      width: 1008,
      height: 640,
      widget: "codex-quota",
      widgets: ["codex-quota"],
    });
    expect((await readFile(result.path)).equals(pngBytes(1008, 640))).toBe(true);
    expect(surface.capture).toHaveBeenCalledWith({ x: 0, y: 0, width: 504, height: 320 });
    expect(calls[0]).toBe("load");
    expect(calls.at(-1)).toBe("close");
  });

  it("waits for a widget that is discovered after the page loads", async () => {
    const { surface } = fakeSurface({ appearAfterProbes: 2 });
    const capturer = createWidgetCapturer({ outputDir, createSurface: () => surface, sleep: noSleep });

    const result = await capturer.capture({ widget: "codex-quota" });

    expect(result.widget).toBe("codex-quota");
    expect(vi.mocked(surface.evaluate).mock.calls.length).toBeGreaterThan(2);
  });

  it("settles for a fixed time before inspecting the page", async () => {
    const sleeps: number[] = [];
    const { surface } = fakeSurface();
    const capturer = createWidgetCapturer({
      outputDir,
      createSurface: () => surface,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await capturer.capture({ widget: "codex-quota" });

    expect(sleeps).toEqual([CAPTURE_SETTLE_MS]);
    expect(surface.load).toHaveBeenCalledBefore(vi.mocked(surface.evaluate));
  });

  it("rejects an unknown widget with the ids that are rendered, and still closes the surface", async () => {
    const { surface } = fakeSurface({ widgets: ["codex-quota"] });
    const capturer = createWidgetCapturer({ outputDir, createSurface: () => surface, sleep: noSleep });
    const clock = vi.spyOn(Date, "now");
    let tick = 0;
    clock.mockImplementation(() => (tick += 6_000));

    await expect(capturer.capture({ widget: "missing" })).rejects.toMatchObject({
      name: "WidgetCaptureError",
      status: 404,
      message: expect.stringContaining("Rendered widgets: codex-quota"),
    });
    expect(surface.close).toHaveBeenCalledOnce();
    expect(surface.capture).not.toHaveBeenCalled();
    clock.mockRestore();
  });

  it("rejects widget ids that could break out of the page selector", async () => {
    const createSurface = vi.fn();
    const capturer = createWidgetCapturer({ outputDir, createSurface, sleep: noSleep });

    await expect(capturer.capture({ widget: 'x"] , body' })).rejects.toMatchObject({ status: 400 });
    await expect(capturer.capture({ widget: "../etc" })).rejects.toBeInstanceOf(WidgetCaptureError);
    expect(createSurface).not.toHaveBeenCalled();
  });

  it("fails clearly when the capture produces no image", async () => {
    const { surface } = fakeSurface({ png: Buffer.alloc(0) });
    const capturer = createWidgetCapturer({ outputDir, createSurface: () => surface, sleep: noSleep });

    await expect(capturer.capture({ widget: "codex-quota" })).rejects.toMatchObject({
      status: 500,
      message: "The capture produced no image.",
    });
    expect(await readdir(outputDir)).toEqual([]);
    expect(surface.close).toHaveBeenCalledOnce();
  });

  it("keeps only the most recent captures", async () => {
    let second = 0;
    const capturer = createWidgetCapturer({
      outputDir,
      keep: 2,
      createSurface: () => fakeSurface().surface,
      sleep: noSleep,
      now: () => new Date(2026, 9, 4, 9, 0, (second += 1)),
    });

    for (let index = 0; index < 4; index += 1) await capturer.capture({ widget: "codex-quota" });

    expect(await readdir(outputDir)).toEqual([
      "widget-20261004-090003-000-codex-quota.png",
      "widget-20261004-090004-000-codex-quota.png",
    ]);
  });

  it("runs overlapping captures one at a time", async () => {
    let active = 0;
    let maxActive = 0;
    const capturer = createWidgetCapturer({
      outputDir,
      createSurface: () => {
        const { surface } = fakeSurface();
        const load = surface.load;
        surface.load = async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await load();
          await new Promise((resolve) => setTimeout(resolve, 5));
        };
        const close = surface.close;
        surface.close = () => {
          active -= 1;
          close();
        };
        return surface;
      },
      sleep: noSleep,
    });

    const request = { widget: "codex-quota" };
    await Promise.all([capturer.capture(request), capturer.capture(request), capturer.capture(request)]);

    expect(maxActive).toBe(1);
  });

  it("writes captures only under the output directory", async () => {
    const capturer = createWidgetCapturer({ outputDir: join(outputDir, "nested"), createSurface: () => fakeSurface().surface, sleep: noSleep });

    const result = await capturer.capture({ widget: "codex-quota" });

    expect((await stat(result.path)).isFile()).toBe(true);
    expect(result.path.startsWith(join(outputDir, "nested"))).toBe(true);
  });
});

describe("assertOutsideDir", () => {
  it("accepts a directory beside the workspace and rejects one inside it", () => {
    expect(() => assertOutsideDir("/app/cache/captures", "/app/extensions")).not.toThrow();
    expect(() => assertOutsideDir("/app/extensions-dev/captures", "/app/extensions")).not.toThrow();
    expect(() => assertOutsideDir("/app/extensions/captures", "/app/extensions")).toThrow(/outside the extension workspace/);
    expect(() => assertOutsideDir("/app/extensions", "/app/extensions")).toThrow(/outside the extension workspace/);
  });
});

describe("capture helpers", () => {
  it("reads PNG dimensions and rejects non-PNG bytes", () => {
    expect(readPngSize(pngBytes(300, 200))).toEqual({ width: 300, height: 200 });
    expect(readPngSize(Buffer.from("not a png at all, just text........"))).toBeNull();
    expect(readPngSize(Buffer.alloc(0))).toBeNull();
  });

  it("names captures with a sortable timestamp and the widget id", () => {
    const at = new Date(2026, 0, 2, 3, 4, 5, 6);
    expect(captureFileName(at, "cpu-temp")).toBe("widget-20260102-030405-006-cpu-temp.png");
  });
});
