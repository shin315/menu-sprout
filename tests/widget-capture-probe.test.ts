// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { buildProbeScript, type CaptureRect } from "../src/main/widget-capture";

type Probe = { found: boolean; widgets: string[]; rect: CaptureRect | null };

describe("widget capture probe script", () => {
  const scrolled: string[] = [];

  function popoverPage(viewport = { width: 504, height: 400 }) {
    document.body.innerHTML = `<main class="app-shell">
      <article data-widget-id="codex-quota"></article>
      <article data-widget-id="cpu-temp"></article>
    </main>`;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: viewport.width });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: viewport.height });
    HTMLElement.prototype.scrollIntoView = function scrollIntoView(this: HTMLElement) {
      scrolled.push(this.getAttribute("data-widget-id") ?? this.className);
    };
  }

  function place(id: string, rect: { left: number; top: number; right: number; bottom: number }) {
    const element = document.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)!;
    element.getBoundingClientRect = () => DOMRect.fromRect({ x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top });
  }

  function run(widget: string): Probe {
    return (0, eval)(buildProbeScript(widget)) as Probe;
  }

  afterEach(() => {
    document.body.innerHTML = "";
    scrolled.length = 0;
  });

  it("scrolls the named widget card into view and measures only that card", () => {
    popoverPage();
    place("cpu-temp", { left: 8.4, top: 120.2, right: 495.6, bottom: 260.7 });

    expect(run("cpu-temp")).toEqual({
      found: true,
      widgets: ["codex-quota", "cpu-temp"],
      rect: { x: 8, y: 120, width: 488, height: 141 },
    });
    expect(scrolled).toEqual(["cpu-temp"]);
  });

  it("clamps the card to the viewport", () => {
    popoverPage({ width: 504, height: 400 });
    place("codex-quota", { left: -10, top: -5, right: 600, bottom: 900 });

    expect(run("codex-quota").rect).toEqual({ x: 0, y: 0, width: 504, height: 400 });
  });

  it("reports the rendered ids and no rect when the widget is missing", () => {
    popoverPage();

    expect(run("missing")).toEqual({ found: false, widgets: ["codex-quota", "cpu-temp"], rect: null });
    expect(scrolled).toEqual([]);
  });
});
