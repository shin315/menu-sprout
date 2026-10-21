import { describe, expect, it } from "vitest";
import config from "../vitest.config";

describe("vitest config", () => {
  it("excludes the managed dev worktree cache", () => {
    expect(config.test?.exclude).toContain("**/.cache/**");
  });
});
