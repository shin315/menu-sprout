import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * Host capability behind the embedded agent's visual self-check: render Menu
 * Sprout's own popover in a fresh hidden window and save a PNG of one widget
 * card the agent can open from disk. This module is Electron-free; the window itself is injected
 * as a {@link WidgetCaptureSurface} so the flow is unit-testable.
 *
 * Captures are written under the host cache directory, never inside the
 * extension workspace, so they cannot show up in the Keep/Undo diff.
 */

export type CaptureRect = { x: number; y: number; width: number; height: number };

/** How the embedded agent reaches the capture capability (see the loopback server). */
export type WidgetCaptureEndpoint = { url: string; token: string };

/** One throwaway rendering of the popover. Closed after a single capture. */
export type WidgetCaptureSurface = {
  /** Load a fresh copy of the popover renderer; resolves once the page has loaded. */
  load(): Promise<void>;
  /** Run a script in the page and resolve with its JSON-serializable result. */
  evaluate<T>(script: string): Promise<T>;
  /** Capture a page region (CSS pixels) as PNG bytes. */
  capture(rect: CaptureRect): Promise<Buffer>;
  close(): void;
};

export type WidgetCaptureRequest = {
  /** Widget id (the `id` in widget.tsx, usually the extension id) to crop to. */
  widget: string;
};

export type WidgetCaptureResult = {
  /** Absolute path of the saved PNG. */
  path: string;
  width: number;
  height: number;
  /** The requested widget id. */
  widget: string;
  /** Ids of every widget rendered in the popover at capture time. */
  widgets: string[];
};

export type WidgetCapturer = {
  capture(request: WidgetCaptureRequest): Promise<WidgetCaptureResult>;
};

export class WidgetCaptureError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 500 | 504,
  ) {
    super(message);
    this.name = "WidgetCaptureError";
  }
}

/** Time for widgets to fetch and paint real data before the capture. */
export const CAPTURE_SETTLE_MS = 2_500;
export const DEFAULT_CAPTURE_KEEP = 20;

const WIDGET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOAD_TIMEOUT_MS = 20_000;
const STEP_TIMEOUT_MS = 10_000;
const WIDGET_WAIT_TIMEOUT_MS = 10_000;
const WIDGET_POLL_MS = 250;
const CAPTURE_FILE_PATTERN = /^widget-.*\.png$/;

export type WidgetCaptureOptions = {
  /** Directory the PNGs are written to. Must live outside the extension workspace. */
  outputDir: string;
  createSurface: () => WidgetCaptureSurface;
  /** Keep at most this many recent captures; older ones are removed. */
  keep?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

type PageProbe = {
  found: boolean;
  widgets: string[];
  rect: CaptureRect | null;
};

export function assertOutsideDir(outputDir: string, protectedDir: string): void {
  const rel = relative(resolve(protectedDir), resolve(outputDir));
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (inside) {
    throw new Error(`Capture output directory must be outside the extension workspace: ${outputDir}`);
  }
}

export function createWidgetCapturer(options: WidgetCaptureOptions): WidgetCapturer {
  const keep = options.keep ?? DEFAULT_CAPTURE_KEEP;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  // Captures share one fresh window each; run them one at a time so concurrent
  // agent calls cannot pile up hidden windows.
  let queue: Promise<unknown> = Promise.resolve();

  async function run(request: WidgetCaptureRequest): Promise<WidgetCaptureResult> {
    const { widget } = request;
    if (!WIDGET_ID_PATTERN.test(widget)) {
      throw new WidgetCaptureError(`Invalid widget id "${widget}". Use the widget id declared in widget.tsx (usually the extension id).`, 400);
    }

    const surface = options.createSurface();
    try {
      await withTimeout(surface.load(), LOAD_TIMEOUT_MS, "Timed out loading the Menu Sprout popover.");
      await sleep(CAPTURE_SETTLE_MS);

      let probe = await probePage(surface, widget);
      const deadline = Date.now() + WIDGET_WAIT_TIMEOUT_MS;
      while (!probe.found && Date.now() < deadline) {
        await sleep(WIDGET_POLL_MS);
        probe = await probePage(surface, widget);
      }
      if (!probe.found) {
        throw new WidgetCaptureError(
          `Widget "${widget}" is not rendered in the popover. Rendered widgets: ${formatIds(probe.widgets)}.`,
          404,
        );
      }
      if (!probe.rect || probe.rect.width < 1 || probe.rect.height < 1) {
        throw new WidgetCaptureError(`Widget "${widget}" has no visible area to capture.`, 500);
      }

      // The probe scrolled the target into view before measuring, so the rect
      // is already in viewport coordinates.
      const png = await withTimeout(surface.capture(probe.rect), STEP_TIMEOUT_MS, "Timed out capturing the popover.");
      const size = readPngSize(png);
      if (!size) throw new WidgetCaptureError("The capture produced no image.", 500);

      await mkdir(options.outputDir, { recursive: true });
      const path = join(options.outputDir, captureFileName(now(), widget));
      await writeFile(path, png);
      await pruneCaptures(options.outputDir, keep);
      return { path, width: size.width, height: size.height, widget, widgets: probe.widgets };
    } finally {
      surface.close();
    }
  }

  return {
    capture(request) {
      const result = queue.then(() => run(request));
      queue = result.catch(() => undefined);
      return result;
    },
  };
}

function formatIds(ids: string[]): string {
  return ids.length > 0 ? ids.join(", ") : "none";
}

async function probePage(surface: WidgetCaptureSurface, widget: string): Promise<PageProbe> {
  const result = await withTimeout(
    surface.evaluate<PageProbe>(buildProbeScript(widget)),
    STEP_TIMEOUT_MS,
    "Timed out inspecting the popover.",
  );
  return result;
}

// Runs inside the popover page. Widgets are `article[data-widget-id]` elements
// (see WidgetCard).
export function buildProbeScript(widget: string): string {
  const selector = `[data-widget-id="${widget}"]`;
  return `(() => {
    const widgets = Array.from(document.querySelectorAll("[data-widget-id]")).map((el) => el.getAttribute("data-widget-id"));
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) return { found: false, widgets, rect: null };
    target.scrollIntoView({ block: "start", inline: "nearest" });
    const r = target.getBoundingClientRect();
    const x = Math.max(0, Math.floor(r.left));
    const y = Math.max(0, Math.floor(r.top));
    const right = Math.min(window.innerWidth, Math.ceil(r.right));
    const bottom = Math.min(window.innerHeight, Math.ceil(r.bottom));
    return { found: true, widgets, rect: { x, y, width: right - x, height: bottom - y } };
  })()`;
}

export function captureFileName(at: Date, widget: string): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-` +
    `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}-${pad(at.getMilliseconds(), 3)}`;
  return `widget-${stamp}-${widget}.png`;
}

export function readPngSize(png: Buffer): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.length < 24 || signature.some((byte, index) => png[index] !== byte)) return null;
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

async function pruneCaptures(dir: string, keep: number): Promise<void> {
  const names = (await readdir(dir)).filter((name) => CAPTURE_FILE_PATTERN.test(name)).sort();
  const stale = names.slice(0, Math.max(0, names.length - keep));
  await Promise.all(stale.map((name) => rm(join(dir, name), { force: true })));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new WidgetCaptureError(message, 504)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
