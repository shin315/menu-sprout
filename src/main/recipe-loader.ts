import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RecipeMetadata } from "../shared/contracts";

function recipeId(fileName: string): string {
  return basename(fileName, ".html");
}

function extractTitle(html: string, fallback: string): string {
  const title = html.match(/<title>(.*?)<\/title>/is)?.[1] ?? html.match(/<h1[^>]*>(.*?)<\/h1>/is)?.[1];
  return (title ?? fallback).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

export async function loadRecipes(recipesDir: string | URL): Promise<RecipeMetadata[]> {
  const dirPath = recipesDir instanceof URL ? fileURLToPath(recipesDir) : recipesDir;
  const entries = await readdir(dirPath);
  const htmlFiles = entries.filter((entry) => entry.endsWith(".html")).sort();

  return Promise.all(
    htmlFiles.map(async (fileName) => {
      const filePath = join(dirPath, fileName);
      const html = await readFile(filePath, "utf8");
      const id = recipeId(fileName);

      return {
        id,
        title: extractTitle(html, id),
        fileName,
        path: filePath.toString(),
      };
    }),
  );
}
