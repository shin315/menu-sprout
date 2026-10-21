import { existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const version = String(packageJson.version);
const appPath = process.argv[2] ?? "release/mac-universal/Menu Sprout.app";
const outputDir = process.argv[3] ?? "release";
const dmgPath = join(outputDir, `Menu-Sprout-${version}-universal.dmg`);

if (process.platform !== "darwin") {
  console.error("DMG creation requires macOS.");
  process.exit(1);
}

if (!existsSync(appPath)) {
  console.error(`Cannot create DMG from missing app bundle: ${appPath}`);
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });
const result = spawnSync(
  "hdiutil",
  ["create", "-volname", "Menu Sprout", "-srcfolder", appPath, "-ov", "-format", "UDZO", dmgPath],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
