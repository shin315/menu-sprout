import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import postcss from "postcss";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const repoRoot = resolve(import.meta.dirname, "..");
const rendererDir = join(repoRoot, "src/renderer");
const fontsDir = join(rendererDir, "fonts");
const googleFontHosts = /fonts\.(googleapis|gstatic)\.com/;

type FontFace = { family: string; weight: string; src: string; file: string };

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    }),
  );
  return nested.flat();
}

function importUrl(params: string): string {
  return params.replace(/^url\(\s*["']?|["']?\s*\)$/g, "").replace(/^["']|["']$/g, "");
}

// Follows the renderer stylesheet's local @import graph and returns every
// @import target plus every @font-face it reaches, with url() resolved to disk.
async function collectStylesheet(entry: string): Promise<{ imports: string[]; faces: FontFace[] }> {
  const imports: string[] = [];
  const faces: FontFace[] = [];
  const visit = async (file: string) => {
    const root = postcss.parse(await readFile(file, "utf8"), { from: file });
    const nested: string[] = [];
    root.walkAtRules((rule) => {
      if (rule.name === "import") {
        const target = importUrl(rule.params);
        imports.push(target);
        if (!/^[a-z]+:/i.test(target) && target.endsWith(".css")) nested.push(resolve(dirname(file), target));
      }
      if (rule.name === "font-face") {
        const decl = (prop: string) => rule.nodes?.find((node) => node.type === "decl" && node.prop === prop);
        const value = (prop: string) => (decl(prop) as postcss.Declaration | undefined)?.value ?? "";
        const src = value("src").match(/url\(\s*["']?([^"')]+)/)?.[1] ?? "";
        faces.push({
          family: value("font-family").replace(/^["']|["']$/g, ""),
          weight: value("font-weight"),
          src,
          file: resolve(dirname(file), src),
        });
      }
    });
    for (const next of nested) await visit(next);
  };
  await visit(entry);
  return { imports, faces };
}

describe("bundled theme fonts", () => {
  it("resolves every theme font family and weight to an existing local woff2 file", async () => {
    const { imports, faces } = await collectStylesheet(join(rendererDir, "styles.css"));

    expect(imports.filter((target) => googleFontHosts.test(target))).toEqual([]);
    for (const family of ["JetBrains Mono", "Inter Tight"]) {
      for (const weight of ["300", "400", "500", "600"]) {
        expect(faces.some((face) => face.family === family && face.weight === weight), `${family} ${weight}`).toBe(true);
      }
    }
    for (const face of faces) {
      expect(face.src, `${face.family} ${face.weight}`).toMatch(/^\.\/.+\.woff2$/);
      expect(face.file.startsWith(fontsDir)).toBe(true);
      expect((await stat(face.file)).size).toBeGreaterThan(0);
    }
  });

  it("ships the license next to each bundled font family", async () => {
    const woff2Dirs = new Set(
      (await listFiles(fontsDir)).filter((path) => path.endsWith(".woff2")).map((path) => dirname(path)),
    );

    expect(woff2Dirs.size).toBe(2);
    for (const dir of woff2Dirs) {
      expect(await readFile(join(dir, "OFL.txt"), "utf8")).toContain("SIL Open Font License, Version 1.1");
    }
  });

  it("packages the font licenses and notice with the app", async () => {
    const config = parseYaml(await readFile(join(repoRoot, "electron-builder.yml"), "utf8")) as {
      extraResources: { from: string; to: string; filter: string[] }[];
    };
    const fontsResource = config.extraResources.find((resource) => resource.from === "src/renderer/fonts");

    expect(fontsResource).toEqual({ from: "src/renderer/fonts", to: "fonts", filter: ["README.md", "*/OFL.txt"] });
    for (const dir of await readdir(fontsDir, { withFileTypes: true })) {
      if (dir.isDirectory()) expect((await stat(join(fontsDir, dir.name, "OFL.txt"))).isFile()).toBe(true);
    }
    expect((await stat(join(fontsDir, "README.md"))).isFile()).toBe(true);
  });
});
