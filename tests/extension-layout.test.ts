import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("extension layout", () => {
  it("documents extension authoring separately from core development", async () => {
    const instructions = await readFile(resolve(import.meta.dirname, "../extensions/AGENTS.md"), "utf8");

    expect(instructions).toContain("self-contained menu-sprout extensions");
    expect(instructions).toContain("widget.tsx");
    expect(instructions).toContain("server.ts");
    expect(instructions).toContain("window.menuSprout.capabilities.invoke");
    expect(instructions).toContain("Do not modify files outside this directory");
    expect(instructions).toContain("recipes/*.html");
    expect(instructions).toContain("Read the matching recipe before implementing");
    expect(instructions).toContain("rootDir` is Menu Sprout's app-data root");
    expect(instructions).not.toContain("rootDir` is the active extension workspace root");
  });

  it("steers extension agents to real data and to verify dependencies via web search", async () => {
    const instructions = await readFile(resolve(import.meta.dirname, "../extensions/AGENTS.md"), "utf8");

    // Real data only - no silent mock fallback (mirrors the quota recipes).
    expect(instructions).toContain("do not fabricate or silently fall back to mock data");
    // Encourage confirming current dependency / API details rather than guessing.
    expect(instructions).toContain("use web search to confirm the latest information");
  });

  it("tells extension agents not to write tests or documentation", async () => {
    const instructions = await readFile(resolve(import.meta.dirname, "../extensions/AGENTS.md"), "utf8");

    // Extensions are verified live in the popover; tests/docs slow iteration
    // without enough payoff in this workflow.
    expect(instructions).toContain("Do not write tests or documentation");
    expect(instructions).toContain("verified live through the Menu Sprout UI");
    expect(instructions).toContain("Do not create `*.test.ts`");
    expect(instructions).toContain("Do not create `README.md`");
    // The old guidance told agents to colocate tests; that policy is gone.
    expect(instructions).not.toContain("Colocate tests inside your extension directory");
    expect(instructions).not.toContain("Use TDD for behavior changes");
  });

  it("keeps the dev extension workspace out of git", async () => {
    const gitignore = await readFile(resolve(import.meta.dirname, "../.gitignore"), "utf8");

    expect(gitignore).toContain("extensions-dev/");
  });
});
