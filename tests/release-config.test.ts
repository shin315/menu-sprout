import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import packageJson from "../package.json";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const execFileAsync = promisify(execFile);

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
}

interface WorkflowJob {
  if?: string;
  needs?: string;
  outputs?: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  env?: Record<string, string>;
  steps: WorkflowStep[];
}

interface Workflow {
  on: Record<string, unknown>;
  jobs: Record<string, WorkflowJob>;
}

async function readWorkflow(name: string): Promise<Workflow> {
  return parse(await readFile(resolve(import.meta.dirname, `../.github/workflows/${name}`), "utf8")) as Workflow;
}

async function workflowStepScript(workflowName: string, jobName: string, stepName: string): Promise<string> {
  const workflow = await readWorkflow(workflowName);
  const script = workflow.jobs[jobName]?.steps.find((step) => step.name === stepName)?.run;
  if (!script) {
    throw new Error(`Could not find the "${stepName}" step in ${workflowName}`);
  }
  return script;
}

async function releaseDraftGuard(): Promise<string> {
  return workflowStepScript("release-please.yml", "macos", "Verify release is still draft");
}

async function runReleaseDraftGuard(releaseState: "true" | "false" | "missing" | "query-error") {
  const tempDirectory = await mkdtemp(join(tmpdir(), "menu-sprout-release-guard-"));
  const ghPath = join(tempDirectory, "gh");
  await writeFile(
    ghPath,
    `#!/bin/sh\ncase "$*" in\n  *releases/tags/*) echo "gh: Not Found (HTTP 404)" >&2; exit 1 ;;\nesac\nif [ "$GH_RELEASE_STATE" = "query-error" ]; then echo "gh: API unavailable (HTTP 503)" >&2; exit 1; fi\nif [ "$GH_RELEASE_STATE" != "missing" ]; then printf '%s\\n' "$GH_RELEASE_STATE"; fi\n`,
  );
  await chmod(ghPath, 0o755);

  try {
    return await execFileAsync("/bin/bash", ["-c", await releaseDraftGuard()], {
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "shin315/menu-sprout",
        TAG_NAME: "menu-sprout-v0.1.23",
        GH_RELEASE_STATE: releaseState,
        PATH: `${tempDirectory}:${process.env.PATH ?? ""}`,
      },
    });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

describe("release draft guard", () => {
  it("passes when the tagged release exists as a draft", async () => {
    await expect(runReleaseDraftGuard("true")).resolves.toBeDefined();
  });

  it("refuses when the tagged release is already published", async () => {
    await expect(runReleaseDraftGuard("false")).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Refusing to build artifacts for a release that is already public: menu-sprout-v0.1.23",
      ),
    });
  });

  it("fails distinctly when no release exists for the tag", async () => {
    await expect(runReleaseDraftGuard("missing")).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "No GitHub release exists for tag menu-sprout-v0.1.23; refusing to build artifacts.",
      ),
    });
  });

  it("fails explicitly when GitHub release state cannot be queried", async () => {
    await expect(runReleaseDraftGuard("query-error")).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "Unable to verify draft status for menu-sprout-v0.1.23; GitHub release query failed: gh: API unavailable (HTTP 503)",
      ),
    });
  });
});

describe("release signing configuration check", () => {
  async function runSigningConfigCheck(env: Record<string, string>) {
    const script = await workflowStepScript("release-please.yml", "macos", "Verify release signing configuration");
    return execFileAsync("/bin/bash", ["-c", script], { env: { PATH: process.env.PATH ?? "", ...env } });
  }

  it("passes when the Apple team and Developer ID name variables are set", async () => {
    await expect(runSigningConfigCheck({ TEAM_ID: "TEAMID1234", DEVELOPER_ID_NAME: "Menu Sprout" })).resolves.toBeDefined();
  });

  it("fails before checkout when APPLE_TEAM_ID is not configured", async () => {
    await expect(runSigningConfigCheck({ TEAM_ID: "", DEVELOPER_ID_NAME: "Menu Sprout" })).rejects.toMatchObject({
      stderr: expect.stringContaining("Missing APPLE_TEAM_ID repository variable"),
    });
  });

  it("fails before checkout when APPLE_DEVELOPER_ID_NAME is not configured", async () => {
    await expect(runSigningConfigCheck({ TEAM_ID: "TEAMID1234", DEVELOPER_ID_NAME: "" })).rejects.toMatchObject({
      stderr: expect.stringContaining("Missing APPLE_DEVELOPER_ID_NAME repository variable"),
    });
  });
});

describe("generated files guard", () => {
  async function git(cwd: string, ...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd });
    return stdout.trim();
  }

  async function commitAll(cwd: string, files: Record<string, string>): Promise<string> {
    for (const [path, content] of Object.entries(files)) {
      await writeFile(join(cwd, path), content);
    }
    await git(cwd, "add", "-A");
    await git(cwd, "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "change");
    return git(cwd, "rev-parse", "HEAD");
  }

  async function runGuard(base: Record<string, string>, head: Record<string, string>) {
    const repository = await mkdtemp(join(tmpdir(), "menu-sprout-generated-guard-"));
    try {
      await git(repository, "init", "-q");
      const baseSha = await commitAll(repository, base);
      const headSha = await commitAll(repository, head);
      const script = await workflowStepScript(
        "guard-generated-files.yml",
        "check",
        "Check PR does not commit generated artifacts",
      );
      return await execFileAsync("/bin/bash", ["-c", script], {
        cwd: repository,
        env: { ...process.env, BASE_SHA: baseSha, HEAD_SHA: headSha },
      });
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  }

  const upstreamConfig = JSON.stringify({ packages: { ".": { "release-type": "node" } } });
  const bootstrappedConfig = JSON.stringify({ "bootstrap-sha": "abc123", packages: { ".": { "release-type": "node" } } });
  const upstreamMetadata = {
    "release-please-config.json": upstreamConfig,
    ".release-please-manifest.json": JSON.stringify({ ".": "0.1.24" }),
    "CHANGELOG.md": "# Changelog\n\n## 0.1.24\n",
    "README.md": "readme\n",
  };

  it("allows the one PR that adds bootstrap-sha to reset release metadata", async () => {
    await expect(
      runGuard(upstreamMetadata, {
        "release-please-config.json": bootstrappedConfig,
        ".release-please-manifest.json": JSON.stringify({ ".": "0.0.0" }),
        "CHANGELOG.md": "# Changelog\n\n## 0.0.0\n",
      }),
    ).resolves.toMatchObject({ stdout: expect.stringContaining("No generated artifacts modified. OK.") });
  });

  it("rejects human edits to release metadata once the release line is bootstrapped", async () => {
    await expect(
      runGuard(
        { ...upstreamMetadata, "release-please-config.json": bootstrappedConfig },
        {
          ".release-please-manifest.json": JSON.stringify({ ".": "0.2.0" }),
          "CHANGELOG.md": "# Changelog\n\n## 0.2.0\n",
        },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("This PR modifies generated or local-only files: CHANGELOG.md .release-please-manifest.json"),
    });
  });

  it("rejects human edits to release metadata without a bootstrap-sha", async () => {
    await expect(
      runGuard(upstreamMetadata, { "CHANGELOG.md": "# Changelog\n\n## 0.1.25\n" }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("This PR modifies generated or local-only files: CHANGELOG.md"),
    });
  });
});

describe("packaged runtime verification", () => {
  it("recursively rejects esbuild nested in unpacked dependencies", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "menu-sprout-packaged-esbuild-"));
    const nestedEsbuildPath = join(
      tempDirectory,
      "Menu Sprout Dev.app",
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "node_modules",
      "acpx",
      "node_modules",
      "esbuild",
    );
    await mkdir(nestedEsbuildPath, { recursive: true });

    try {
      const verificationScript = resolve(
        import.meta.dirname,
        "../scripts/e2e-packaged-mac-app.mjs",
      );
      const invocation = [
        `import(${JSON.stringify(verificationScript)})`,
        `.then(({ assertNoPackagedEsbuild }) => assertNoPackagedEsbuild(${JSON.stringify(join(tempDirectory, "Menu Sprout Dev.app"))}))`,
      ].join("");
      await expect(execFileAsync(process.execPath, ["--input-type=module", "--eval", invocation]))
        .rejects.toMatchObject({
          stderr: expect.stringContaining(nestedEsbuildPath),
        });
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});

describe("distribution config", () => {
  it("adds mac packaging scripts and keeps TypeScript available at runtime for extension compilation", () => {
    expect(packageJson.scripts?.["package:mac"]).toContain("electron-builder --mac dir --universal");
    expect(packageJson.scripts?.["dist:mac"]).toContain("scripts/create-dmg.mjs");
    expect(packageJson.dependencies?.typescript).toBe("6.0.3");
    expect(packageJson.devDependencies?.["electron-builder"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("uses an electron-builder that handles pnpm deduped dependencies (>= 26.8.2)", () => {
    // electron-builder <= 26.8.1 misparses pnpm's `pnpm list --json` output once pnpm
    // (>= 10.29.3) emits "deduped" stubs: a package reached via multiple paths is read as
    // having no dependencies, so its transitive deps are dropped from the asar. That shipped
    // a broken 0.1.4 that crashed on launch with ERR_MODULE_NOT_FOUND for @jridgewell/resolve-uri.
    // electron-builder #9618 (released in 26.8.2) fixes the collector. Never downgrade below it.
    const version = packageJson.devDependencies?.["electron-builder"] ?? "0.0.0";
    const [major, minor, patch] = version.split(".").map((part) => Number.parseInt(part, 10));
    const atLeast = major > 26 || (major === 26 && (minor > 8 || (minor === 8 && patch >= 2)));
    expect(atLeast).toBe(true);
  });

  it("packages local/dev mac builds under a distinct bundle identity so they cannot shadow the released app", async () => {
    expect(packageJson.scripts?.["package:mac"]).toContain("--config electron-builder.dev.yml");
    const devConfig = parse(await readFile(resolve(import.meta.dirname, "../electron-builder.dev.yml"), "utf8"));
    expect(devConfig).toMatchObject({
      extends: "./electron-builder.yml",
      appId: "io.github.shin315.menusprout.dev",
      productName: "Menu Sprout Dev",
    });
  });

  it("ships under the Menu Sprout identity so it runs side by side with baby-menu and keeps upstream credit", async () => {
    const config = parse(await readFile(resolve(import.meta.dirname, "../electron-builder.yml"), "utf8"));
    const license = await readFile(resolve(import.meta.dirname, "../LICENSE"), "utf8");

    expect(packageJson.name).toBe("menu-sprout");
    expect(config).toMatchObject({
      appId: "io.github.shin315.menusprout",
      productName: "Menu Sprout",
      dmg: { artifactName: "Menu-Sprout-${version}-universal.dmg" },
    });
    expect(license).toContain("Copyright (c) 2026 Kun Chen");
    expect(license).toContain("Copyright (c) 2026 Shin315 and Menu Sprout contributors");
  });

  it("configures production Developer ID signing and keeps local packages ad-hoc", async () => {
    const config = await readFile(resolve(import.meta.dirname, "../electron-builder.yml"), "utf8");
    const electronViteConfig = await readFile(resolve(import.meta.dirname, "../electron.vite.config.ts"), "utf8");
    const devConfig = await readFile(resolve(import.meta.dirname, "../electron-builder.dev.yml"), "utf8");
    const entitlements = await readFile(resolve(import.meta.dirname, "../assets/entitlements.mac.plist"), "utf8");
    const localSigner = await readFile(
      resolve(import.meta.dirname, "../scripts/adhoc-sign-mac-app.mjs"),
      "utf8",
    );

    expect(config).toContain("appId: io.github.shin315.menusprout");
    expect(config).toContain("to: extensions-template");
    expect(config).toContain("menusprout-env.d.ts");
    expect(config).toContain("hello-world/**");
    expect(config).toContain("to: tray");
    expect(config).toContain("menu_sproutTemplate*.png");
    expect(config).not.toContain("identity: null");
    expect(config).toContain("hardenedRuntime: true");
    expect(config).toContain("gatekeeperAssess: false");
    expect(config).toContain("entitlements: assets/entitlements.mac.plist");
    expect(config).toContain("entitlementsInherit: assets/entitlements.mac.plist");
    expect(config).toContain("notarize: true");
    expect(config).toContain("icon: assets/app-icon.icns");
    expect(config).toContain("!node_modules/esbuild/**");
    expect(config).toContain("!node_modules/@esbuild/**");
    expect(config).not.toMatch(/x64ArchFiles:.*(?:@esbuild|esbuild)/);
    expect(electronViteConfig).toContain("plugins: [externalizeDepsPlugin()]");
    expect(electronViteConfig).not.toContain('exclude: ["acpx"]');
    expect(packageJson.devDependencies?.["@electron/asar"]).toBe("3.4.1");

    expect(devConfig).toContain("identity: null");
    expect(devConfig).toContain("notarize: false");
    expect(packageJson.scripts?.["package:mac"]).toContain("CSC_IDENTITY_AUTO_DISCOVERY=false");
    expect(localSigner).toContain('spawnSync("file", ["-b", candidate]');
    expect(localSigner).toContain('right.split("/").length - left.split("/").length');
    expect(localSigner).toContain('run("codesign", ["--force", "--sign", "-", candidate])');
    expect(localSigner.indexOf('run("codesign", ["--force", "--sign", "-", candidate])'))
      .toBeLessThan(localSigner.indexOf('run("codesign", ["--force", "--deep", "--sign", "-", appPath])'));

    const entitlementKeys = [...entitlements.matchAll(/<key>(com\.apple\.security\.[^<]+)<\/key>/g)]
      .map((match) => match[1]);
    expect(entitlementKeys).toEqual(["com.apple.security.cs.allow-jit"]);
    expect(entitlements).not.toContain("com.apple.security.cs.allow-unsigned-executable-memory");
    await expect(stat(resolve(import.meta.dirname, "../assets/app-icon.svg")).then((file) => file.isFile())).resolves.toBe(true);
    await expect(stat(resolve(import.meta.dirname, "../assets/app-icon.icns")).then((file) => file.isFile())).resolves.toBe(true);
  });

  it("signs, notarizes, and verifies the publication-ready DMG before publishing it", async () => {
    const workflow = await readFile(resolve(import.meta.dirname, "../.github/workflows/release-please.yml"), "utf8");
    const packagedRuntimeE2e = await readFile(
      resolve(import.meta.dirname, "../scripts/e2e-packaged-mac-app.mjs"),
      "utf8",
    );

    const releaseWorkflow = await readWorkflow("release-please.yml");
    const releasePleaseJob = releaseWorkflow.jobs["release-please"];
    const macosJob = releaseWorkflow.jobs.macos;

    expect(releaseWorkflow.on).toEqual({ push: { branches: ["main"] } });
    expect(releasePleaseJob.if).toBe("${{ vars.MENU_SPROUT_RELEASES_ENABLED == 'true' }}");
    expect(releasePleaseJob.steps.map((step) => step.uses)).toEqual(["googleapis/release-please-action@v4"]);
    expect(releasePleaseJob.outputs).toEqual({
      "menu-sprout-release-created": "${{ steps.release.outputs.release_created }}",
      "menu-sprout-tag-name": "${{ steps.release.outputs.tag_name }}",
      "menu-sprout-version": "${{ steps.release.outputs.version }}",
    });
    expect(macosJob.needs).toBe("release-please");
    expect(macosJob.if).toBe("${{ needs.release-please.outputs.menu-sprout-release-created == 'true' }}");
    expect(macosJob.concurrency).toEqual({
      group: "${{ github.workflow }}-macos-${{ needs.release-please.outputs.menu-sprout-tag-name }}",
      "cancel-in-progress": false,
    });
    expect(macosJob.env).toEqual({
      TEAM_ID: "${{ vars.APPLE_TEAM_ID }}",
      DEVELOPER_ID_NAME: "${{ vars.APPLE_DEVELOPER_ID_NAME }}",
      BUNDLE_ID: "io.github.shin315.menusprout",
      TAG_NAME: "${{ needs.release-please.outputs.menu-sprout-tag-name }}",
      VERSION: "${{ needs.release-please.outputs.menu-sprout-version }}",
    });
    expect(macosJob.steps.find((step) => step.uses === "actions/checkout@v6")?.with?.ref)
      .toBe("${{ format('refs/tags/{0}', env.TAG_NAME) }}");
    expect(macosJob.steps.find((step) => step.name === "Build")?.env).toMatchObject({
      MENU_SPROUT_UMAMI_HOST: "${{ vars.MENU_SPROUT_UMAMI_HOST }}",
      MENU_SPROUT_UMAMI_WEBSITE_ID: "${{ vars.MENU_SPROUT_UMAMI_WEBSITE_ID }}",
    });
    // Menu Sprout has no Homebrew tap; the release ends at the verified GitHub release.
    expect(macosJob.steps.at(-1)?.name).toBe("Publish verified release");
    expect(macosJob.steps.map((step) => step.name)).not.toContain("Update Homebrew Cask");
    for (const secret of [
      "MAC_DEVELOPER_ID_CERT_P12",
      "MAC_DEVELOPER_ID_CERT_PASSWORD",
      "APP_STORE_CONNECT_KEY_ID",
      "APP_STORE_CONNECT_ISSUER_ID",
      "APP_STORE_CONNECT_API_KEY",
    ]) {
      expect(workflow).toContain(`secrets.${secret}`);
      expect(workflow).toContain(`Missing ${secret}`);
    }
    expect(workflow).toContain("CSC_LINK: ${{ steps.developer_id_cert.outputs.csc_link }}");
    expect(workflow).toContain("CSC_KEY_PASSWORD: ${{ secrets.MAC_DEVELOPER_ID_CERT_PASSWORD }}");
    expect(workflow).toContain("APPLE_API_KEY: ${{ steps.asc-key.outputs.key_path }}");
    expect(workflow).toContain("pnpm exec electron-builder --mac dir --universal");
    expect(workflow).not.toContain("codesign --force --deep --sign -");
    expect(workflow).toContain("xcrun notarytool submit \"$DMG_PATH\"");
    expect(workflow).toContain("--wait");
    expect(workflow).toContain('xcrun stapler staple "$DMG_PATH"');
    expect(workflow).toContain("Verify publication-ready signed and notarized DMG");
    expect(workflow).toContain('codesign --verify --deep --strict --verbose=4 "$APP_PATH"');
    expect(workflow).toContain('TeamIdentifier=$TEAM_ID');
    expect(workflow).toContain('Identifier=$BUNDLE_ID');
    expect(workflow).toContain("Authority=Developer ID Application: $DEVELOPER_ID_NAME ($TEAM_ID)");
    expect(workflow).toContain("flags=.*runtime");
    expect(workflow).toContain("^Timestamp=.+$");
    expect(workflow).toContain("verify_code_object");
    expect(workflow).toContain('codesign -d --arch "$architecture" --verbose=4 "$code_object"');
    expect(workflow).toContain('verify_code_object "$candidate" arm64');
    expect(workflow).toContain('verify_code_object "$candidate" x86_64');
    expect(workflow).toContain('verify_code_object "$candidate" "$expected_architecture"');
    expect(workflow).toContain("verify_entitlements");
    expect(workflow).toContain('python3 scripts/verify-macos-entitlements.py');
    expect(workflow).toContain('--arch "$architecture" --entitlements - --xml');
    expect(workflow).toContain("--require-jit");
    expect(workflow).toContain('Contents/MacOS/*|Contents/Frameworks/*.app/Contents/MacOS/*)');
    expect(workflow).toContain('verify_entitlements "$candidate" arm64 "$require_jit"');
    expect(workflow).toContain('verify_entitlements "$candidate" x86_64 "$require_jit"');
    expect(workflow).toContain("verify_macho_architectures");
    expect(workflow).toContain('if [ "$architectures" = "arm64 x86_64" ]');
    expect(workflow).not.toContain("node_modules/@esbuild/");
    expect(workflow).not.toContain("node_modules/esbuild/");
    expect(workflow).toContain("node_modules/@tailwindcss/oxide-darwin-arm64/tailwindcss-oxide.darwin-arm64.node");
    expect(workflow).toContain("node_modules/lightningcss-darwin-arm64/lightningcss.darwin-arm64.node");
    expect(workflow).toContain('if [ ! -f "$counterpart" ]');
    expect(workflow).toContain("Missing paired $counterpart_architecture native prebuilt");
    expect(workflow).toContain("file -b \"$candidate\"");
    expect(workflow).toContain('spctl --assess --type execute --verbose=4 "$APP_PATH"');
    expect(workflow).toContain("source=Notarized Developer ID");
    expect(workflow).toContain('xcrun stapler validate "$APP_PATH"');
    expect(workflow).toContain('xcrun stapler validate "$DMG_PATH"');
    expect(workflow).toContain('node scripts/e2e-packaged-mac-app.mjs "$APP_PATH"');
    expect(packagedRuntimeE2e).toContain('from "@electron/asar"');
    expect(packagedRuntimeE2e).toContain("assertNoPackagedEsbuild");
    expect(packagedRuntimeE2e).toContain("window.menuSprout.agent.send");
    expect(packagedRuntimeE2e).toContain("agent:prompt:done");
    expect(workflow).toContain("CFBundleShortVersionString");
    expect(workflow).toContain('lipo "$APP_EXECUTABLE" -verify_arch arm64 x86_64');
    expect(workflow).toContain('ARCHITECTURES" != "arm64 x86_64"');

    expect(workflow).toContain("Verify release is still draft");
    expect(workflow).toContain('gh api --paginate "repos/${GITHUB_REPOSITORY}/releases?per_page=100"');
    expect(workflow).not.toContain('releases/tags/${TAG_NAME}');

    const signingConfigIndex = macosJob.steps.findIndex((step) => step.name === "Verify release signing configuration");
    const checkoutIndex = macosJob.steps.findIndex((step) => step.uses === "actions/checkout@v6");
    const credentialsIndex = macosJob.steps.findIndex((step) => step.name === "Restore App Store Connect API key");
    expect(signingConfigIndex).toBeGreaterThan(-1);
    expect(checkoutIndex).toBeGreaterThan(signingConfigIndex);
    expect(credentialsIndex).toBeGreaterThan(checkoutIndex);

    const verifyIndex = workflow.indexOf("Verify publication-ready signed and notarized DMG");
    const runtimeE2eIndex = workflow.indexOf('node scripts/e2e-packaged-mac-app.mjs "$APP_PATH"');
    const checksumIndex = workflow.indexOf("Compute SHA256");
    const uploadIndex = workflow.indexOf("Upload DMG to draft release");
    const publishIndex = workflow.indexOf("Publish verified release");
    expect(verifyIndex).toBeGreaterThan(-1);
    expect(runtimeE2eIndex).toBeGreaterThan(verifyIndex);
    expect(checksumIndex).toBeGreaterThan(runtimeE2eIndex);
    expect(uploadIndex).toBeGreaterThan(checksumIndex);
    expect(publishIndex).toBeGreaterThan(uploadIndex);
    expect(workflow).toContain('gh release edit "$TAG_NAME" --draft=false');
    expect(packagedRuntimeE2e).toContain('join(testAppDataRoot, "preferences.json")');
    expect(packagedRuntimeE2e).toContain("openAtLogin: false");
    expect(packagedRuntimeE2e.indexOf("openAtLogin: false")).toBeLessThan(packagedRuntimeE2e.indexOf("spawn(executablePath"));

    expect(workflow).toContain("gh release upload");
    expect(workflow).not.toContain("tags:");
    await expect(stat(resolve(import.meta.dirname, "../.github/workflows/release.yml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("declares release-please manifest mode for the Menu Sprout package", async () => {
    const config = JSON.parse(await readFile(resolve(import.meta.dirname, "../release-please-config.json"), "utf8"));
    const manifest = JSON.parse(await readFile(resolve(import.meta.dirname, "../.release-please-manifest.json"), "utf8"));

    expect(config).toMatchObject({
      $schema: "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
      "bootstrap-sha": "b82422da291dcea664a204e716cf07ec0cb63ce1",
      "bump-minor-pre-major": true,
      "bump-patch-for-minor-pre-major": true,
      "include-component-in-tag": true,
      draft: true,
      "force-tag-creation": true,
      packages: {
        ".": {
          "release-type": "node",
          "package-name": "menu-sprout",
          component: "menu-sprout",
          "initial-version": "0.1.0",
        },
      },
    });
    expect(manifest).toEqual({
      ".": packageJson.version,
    });
  });

  it("allows release-please PRs to update generated release metadata", async () => {
    const workflow = await readFile(resolve(import.meta.dirname, "../.github/workflows/guard-generated-files.yml"), "utf8");

    expect(workflow).toContain("github.event.pull_request.user.login != 'release-please[bot]'");
    expect(workflow).toContain("github.event.pull_request.user.login != 'github-actions[bot]'");
    expect(workflow).toContain("!startsWith(github.event.pull_request.head.ref, 'release-please--')");
    expect(workflow).toContain('name_status=$(git diff --name-status "${BASE_SHA}...${HEAD_SHA}")');
    expect(workflow).toContain("manifest_status=$(printf '%s\\n' \"$name_status\" | awk");
    expect(workflow).toContain('config_status=$(printf \'%s\\n\' "$name_status" | awk');
    expect(workflow).toContain('[ "$manifest_status" = "A" ] && [ "$config_status" = "A" ]');
    expect(workflow).toContain("for path in CHANGELOG.md; do");
  });
});
