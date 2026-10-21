import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_MENU_BAR_TEXT_LENGTH, MIN_MENU_BAR_INTERVAL_MS, normalizeMenuBarState, resolveMenuBarIcon } from "../src/main/menu-bar-items";
import { createMenuBarItemSource } from "../src/main/server-action-registry";
import type { MenuSproutServerContext } from "../src/shared/contracts";

const extensionsDir = resolve(import.meta.dirname, "../extensions");
const fixturesDir = resolve(import.meta.dirname, "fixtures/menu-bar-extensions");
const context = { rootDir: "/repo" } as MenuSproutServerContext;

describe("menu-bar item discovery", () => {
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "menu-sprout-menu-bar-cache-"));
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  it("finds no menu-bar item in the bundled extension inventory", async () => {
    const items = await createMenuBarItemSource({ rootDir: extensionsDir, actionRoots: [extensionsDir], cacheDir }).list();

    expect(items).toEqual([]);
  });

  it("discovers the documented clock example and renders it within the host limits", async () => {
    const items = await createMenuBarItemSource({ rootDir: fixturesDir, actionRoots: [fixturesDir], cacheDir }).list();
    const clock = items.find((item) => item.extensionId === "clock");

    expect(items.map((item) => item.extensionId)).toEqual(["clock"]);
    expect(clock?.intervalMs).toBeGreaterThanOrEqual(MIN_MENU_BAR_INTERVAL_MS);

    const state = normalizeMenuBarState(await clock?.run(context));
    expect(state?.text).toMatch(/^\d{2}:\d{2}$/);
    expect(Array.from(state?.text ?? "").length).toBeLessThanOrEqual(MAX_MENU_BAR_TEXT_LENGTH);
    expect(resolveMenuBarIcon(state?.icon ?? "", clock?.extensionDir ?? "")?.kind).toBe("file");
  });
});
