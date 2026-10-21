import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import postcss from "postcss";
import { beforeAll, describe, expect, it } from "vitest";
import { compileWidgetTailwindCss } from "../src/main/widget-tailwind-css";
import { THEMES, type ThemeId } from "../src/shared/themes";

type Scheme = "light" | "dark";
type Rgba = [number, number, number, number];
type Block = { selector: string; scheme: Scheme | null; declarations: Map<string, string> };

const COLOR_UTILITIES = [
  "bg-void", "bg-stage", "bg-surface", "bg-elevated", "bg-pressed",
  "text-ink-strong", "text-ink", "text-ink-muted", "text-ink-soft", "text-ink-label", "text-ink-faint",
  "border-line", "border-line-faint", "text-signal-live", "text-signal-warn", "text-signal-danger",
];

function parseCompiledCascade(css: string): Block[] {
  const blocks: Block[] = [];
  postcss.parse(css).walkRules((rule) => {
    const selectors = rule.selectors.filter((selector) => selector.startsWith(":root") || COLOR_UTILITIES.includes(selector.slice(1)));
    if (selectors.length === 0) return;
    let scheme: Scheme | null = null;
    for (let ancestor: typeof rule.parent | postcss.Document = rule.parent; ancestor; ancestor = ancestor.parent) {
      if (ancestor.type !== "atrule" || ancestor.name !== "media") continue;
      const match = /prefers-color-scheme:\s*(light|dark)/.exec(ancestor.params);
      if (!match) throw new Error(`Unsupported media condition: ${ancestor.params}`);
      scheme = match[1] as Scheme;
    }
    const declarations = new Map<string, string>();
    for (const node of rule.nodes) {
      if (node.type === "decl") declarations.set(node.prop, node.value);
    }
    for (const selector of selectors) blocks.push({ selector, scheme, declarations });
  });
  return blocks;
}

function resolveStyles(blocks: Block[], theme: ThemeId, scheme: Scheme) {
  const active = blocks.filter((block) => block.scheme === null || block.scheme === scheme);
  const properties = new Map<string, string>();
  for (const selector of [":root", `:root[data-theme="${theme}"]`]) {
    for (const block of active.filter((block) => block.selector === selector)) {
      for (const [property, value] of block.declarations) properties.set(property, value);
    }
  }
  function resolveValue(value: string): string {
    return value.replace(/var\((--[\w-]+)\)/g, (_match, property: string) => {
      const inherited = properties.get(property);
      if (inherited === undefined) throw new Error(`Unresolved CSS property: ${property}`);
      return resolveValue(inherited);
    });
  }
  return {
    nativeScheme: properties.get("color-scheme"),
    color(utility: string): Rgba {
      const property = utility.startsWith("bg-") ? "background-color" : utility.startsWith("border-") ? "border-color" : "color";
      const value = active.filter((block) => block.selector === `.${utility}`).at(-1)?.declarations.get(property);
      if (value === undefined) throw new Error(`Missing compiled utility: ${utility}`);
      return parseColor(resolveValue(value));
    },
  };
}

function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((digit) => digit + digit).join("") : hex[1];
    return [0, 2, 4].map((offset) => parseInt(digits.slice(offset, offset + 2), 16)).concat(1) as Rgba;
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value);
  if (rgba) {
    const [r, g, b, a = 1] = rgba[1].split(",").map((part) => Number(part.trim()));
    return [r, g, b, a];
  }
  if (value === "transparent") return [0, 0, 0, 0];
  throw new Error(`Unsupported color: ${value}`);
}

function over([r, g, b, a]: Rgba, bottom: Rgba): Rgba {
  return [r * a + bottom[0] * (1 - a), g * a + bottom[1] * (1 - a), b * a + bottom[2] * (1 - a), 1];
}

function luminance([r, g, b]: Rgba): number {
  const channel = (value: number) => {
    const fraction = value / 255;
    return fraction <= 0.04045 ? fraction / 12.92 : ((fraction + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

describe("compiled theme appearance", () => {
  let blocks: Block[];

  beforeAll(async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), "menu-sprout-appearance-"));
    try {
      await writeFile(join(sourceDir, "widget.tsx"), `<div className="${COLOR_UTILITIES.join(" ")}" />`);
      const themeCss = await readFile(resolve(__dirname, "../src/ui/theme.css"), "utf8");
      blocks = parseCompiledCascade(await compileWidgetTailwindCss({ sourceDir, themeCss }));
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
    }
  });

  it("preserves Default Monochrome Lab's rendered dark colors", () => {
    const dark = resolveStyles(blocks, "default", "dark");
    expect(dark.color("bg-stage")).toEqual([11, 11, 12, 1]);
    expect(dark.color("bg-void")).toEqual([6, 6, 7, 1]);
    expect(dark.color("text-ink")).toEqual([255, 255, 255, 0.86]);
    expect(dark.color("text-signal-live")).toEqual([106, 227, 182, 1]);
  });

  it.each(THEMES.flatMap(({ id }) => (["light", "dark"] as const).map((scheme) => [id, scheme] as const)))(
    "renders %s utilities in %s with readable text on the matching background",
    (theme, scheme) => {
      const styles = resolveStyles(blocks, theme, scheme);
      expect(styles.nativeScheme).toBe("light dark");
      for (const utility of COLOR_UTILITIES) {
        const rgba = styles.color(utility);
        expect(rgba.every(Number.isFinite), `${theme}/${scheme} ${utility}`).toBe(true);
      }
      const background = over(styles.color("bg-stage"), styles.color("bg-void"));
      const backgroundLuminance = luminance(background);
      const textLuminance = luminance(over(styles.color("text-ink"), background));
      if (scheme === "light") {
        expect(backgroundLuminance).toBeGreaterThan(0.5);
        expect(textLuminance).toBeLessThan(backgroundLuminance);
      } else {
        expect(backgroundLuminance).toBeLessThan(0.1);
        expect(textLuminance).toBeGreaterThan(backgroundLuminance);
      }
      expect((Math.max(textLuminance, backgroundLuminance) + 0.05) / (Math.min(textLuminance, backgroundLuminance) + 0.05)).toBeGreaterThan(4.5);
    },
  );

  it.each(THEMES)("switches $id utilities with the resolved system scheme", ({ id }) => {
    const light = resolveStyles(blocks, id, "light");
    const dark = resolveStyles(blocks, id, "dark");
    expect(light.color("bg-stage")).not.toEqual(dark.color("bg-stage"));
    expect(light.color("text-ink")).not.toEqual(dark.color("text-ink"));
  });
});
