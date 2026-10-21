import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ACTION_SHA = "f6441c96c352a18b9cadcaef6b6c7017e9ac3970";
const ACTION =
  `kunchenguid/no-mistakes/.github/actions/require-no-mistakes@${ACTION_SHA}`;

interface PullRequestTrigger {
  types: string[];
  branches: string[];
  "paths-ignore": string[];
}

interface Workflow {
  name: string;
  "run-name": string;
  on: { pull_request: PullRequestTrigger };
  permissions: { contents: string; "pull-requests": string };
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<
    string,
    {
      name: string;
      "runs-on": string;
      if: string;
      steps: Array<{ name: string; uses?: string; run?: string; with?: unknown }>;
    }
  >;
}

// Evaluates the job-level `if` for a given head branch and PR author by
// translating the GitHub expression into an equivalent JavaScript one.
function runsFor(condition: string, head: string, login: string): boolean {
  const js = condition
    .replaceAll("github.event.pull_request.head.ref", "head")
    .replaceAll("github.event.pull_request.user.login", "login")
    .replaceAll(
      /(\w+)\s*!=\s*('[^']*')/g,
      "$1.toLowerCase() !== $2.toLowerCase()",
    );
  return new Function(
    "head",
    "login",
    "startsWith",
    `return ${js};`,
  )(
    head,
    login,
    (value: string, prefix: string) =>
      value.toLowerCase().startsWith(prefix.toLowerCase()),
  );
}

async function workflow(): Promise<Workflow> {
  const source = await readFile(
    resolve(import.meta.dirname, "../.github/workflows/no-mistakes-required.yml"),
    "utf8",
  );
  return parse(source) as Workflow;
}

describe("no-mistakes-required workflow contract", () => {
  it("preserves the pull request boundary and required-check identity", async () => {
    const config = await workflow();

    expect(config.name).toBe("Require no-mistakes");
    expect(config["run-name"]).toBe(
      "PR #${{ github.event.pull_request.number }} body compliance - ${{ github.event.action }} - event ${{ github.run_number }} (run ${{ github.run_id }})",
    );
    expect(config.on.pull_request).toEqual({
      types: ["opened", "edited", "synchronize", "reopened"],
      branches: ["main"],
      "paths-ignore": [
        ".release-please-manifest.json",
        "CHANGELOG.md",
        "package.json",
      ],
    });
    expect(config.permissions).toEqual({
      contents: "read",
      "pull-requests": "read",
    });
    expect(config.concurrency).toEqual({
      group:
        "no-mistakes-required-${{ github.event.pull_request.number }}-${{ (github.event.action == 'opened' || github.event.action == 'edited') && github.run_id || 'head-change' }}",
      "cancel-in-progress": true,
    });

    const check = config.jobs.check;
    expect(check.name).toBe("PR must be raised via no-mistakes");
    expect(check["runs-on"]).toBe("ubuntu-latest");
    expect(check.if).toBe(
      "startsWith(github.event.pull_request.head.ref, 'fm/') && github.event.pull_request.user.login != 'github-actions[bot]' && github.event.pull_request.user.login != 'dependabot[bot]' && github.event.pull_request.user.login != 'release-please[bot]'",
    );
  });

  it("delegates the only job step to the immutable shared action with no upstream maintainer exemption", async () => {
    const config = await workflow();
    const steps = config.jobs.check.steps;

    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({
      name: "Verify no-mistakes signature and pipeline attestation in PR body",
      uses: ACTION,
    });
    expect(steps[0].run).toBeUndefined();
  });

  it("enforces the check only for fm/ head branches and skips it as passing otherwise", async () => {
    const condition = (await workflow()).jobs.check.if;

    expect(runsFor(condition, "fm/some-task", "shin315")).toBe(true);
    expect(runsFor(condition, "FM/some-task", "shin315")).toBe(true);
    expect(runsFor(condition, "feature/outside", "contributor")).toBe(false);
    expect(runsFor(condition, "main", "contributor")).toBe(false);
  });

  it.each([
    "github-actions[bot]",
    "dependabot[bot]",
    "release-please[bot]",
  ])("exempts %s regardless of author casing", async (login) => {
    const condition = (await workflow()).jobs.check.if;

    expect(runsFor(condition, "fm/release", login)).toBe(false);
    expect(runsFor(condition, "FM/release", login.toUpperCase())).toBe(false);
  });
});
