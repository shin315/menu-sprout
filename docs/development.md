# Development

Working on Menu Sprout itself.
There are no published releases yet, so end users also run from source (see the [README](../README.md#quick-start)).

## Setup

```sh
git clone https://github.com/shin315/menu-sprout.git
cd menu-sprout
pnpm install
pnpm dev
```

Requires Node `>=22.12` and `pnpm@11.1.1` (declared in `packageManager`).

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Electron + renderer dev server with a gitignored `extensions-dev/` sandbox |
| `pnpm dev:reset` | Wipe `extensions-dev/` and the agent session cache, then start fresh |
| `pnpm build` | Build main + preload + renderer + bundled adapters into `out/` |
| `pnpm generate:contracts` | Regenerate `extensions/menusprout-env.d.ts` from `src/shared/contracts.ts` |
| `pnpm package:mac` | Clean `release/` and create an ad-hoc-signed `Menu Sprout Dev.app` without release credentials |
| `pnpm dist:mac` | Build the local `Menu Sprout Dev.app` and create a universal DMG in `release/` |
| `pnpm test` | Run all Vitest tests |
| `pnpm test:e2e` | Only e2e tests (including `acpx/runtime` plus bundled adapter coverage) |
| `pnpm test:e2e:grok-popover` | Unattended macOS Grok production-wiring check; see [grok-quota-e2e.md](grok-quota-e2e.md) |
| `pnpm test:e2e:packaged-mac` | Check that a packaged macOS app starts its renderer and preload bridge |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm lint` | `tsc --noEmit` (same as typecheck) |

Single test: `pnpm vitest run tests/<name>.test.ts` or `pnpm vitest run -t "<pattern>"`.
E2E tests run real `acpx/runtime` against `acp-mock` (selected via `registryOverrides` as `acpx-mock`) plus bundled adapters against fake local CLIs.
The renderer dev server is pinned to port 5273 (`strictPort: true`).

## Dev workflow

- `pnpm dev` iterates in a throwaway sandbox - the agent edits the gitignored `extensions-dev/` copy and your tracked tree stays clean.
- `pnpm dev:reset` when recipe or extension guidance changes; it also clears `.cache/menu-sprout/acp-sessions` so the agent re-reads fresh specs instead of continuing prior conversation state.
- `pnpm generate:contracts` after changing extension-facing types in `src/shared/contracts.ts` or the public name list in `src/shared/extension-contract-names.ts`; CI fails if the committed `extensions/menusprout-env.d.ts` is stale.
- Source mode and packaged `Menu Sprout Dev` / test bundles never touch macOS login items. Only the packaged production product named `Menu Sprout` may call Electron's `setLoginItemSettings` API.

### Dev-only flags

These complement the user-facing flags in [configuration.md](configuration.md#environment-flags).

| Var | Effect |
| --- | --- |
| `MENU_SPROUT_OPEN_POPOVER_ON_START=1` | Opens the real popover through the tray bounds path for an explicit unattended check |
| `MENU_SPROUT_REMOTE_DEBUGGING_PORT=<port>` | Enables Electron's loopback Chrome DevTools endpoint for an explicit unattended check; invalid ports are ignored |
| `MENU_SPROUT_PACKAGED_TEST_HOME=<path>` | Isolates packaged-app state for the packaged runtime E2E; not for normal launches |

## Build wiring

- `electron.vite.config.ts` has three roots: `src/main/app.ts` -> `out/main/index.js` (`package.json#main`), `src/preload/index.ts` -> `out/preload/index.js`, and `src/renderer/` -> `out/renderer/`. In dev, main loads `ELECTRON_RENDERER_URL`; in production it loads `out/renderer/index.html`.
- The renderer build adds `@tailwindcss/vite` and aliases `@menusprout/ui` to `src/ui/index.ts` so dev-mode widgets resolve the design system directly.
- `src/renderer/colors_and_type.css` imports local font faces from `src/renderer/fonts/fonts.css`; Vite emits their WOFF2 assets into `out/renderer/assets/` in `app.asar`. `electron-builder.yml` includes the [font notice and licenses](../src/renderer/fonts/README.md) under `Resources/fonts/`.
- For custom extension workspaces outside the default Tailwind scan paths, see [Environment flags](configuration.md#environment-flags).
- `scripts/build-adapters.mjs` bundles `src/adapters/{claude,codex,antigravity}/index.ts` to `out/adapters/<name>/index.mjs` after `electron-vite build`; `pnpm dev` runs it too because dev resolves adapters from `out/adapters/`.
- Packaged builds keep `out/adapters/**` in `app.asar.unpacked` because adapters are spawned as standalone Node programs.
- `typescript` is externalized from the main bundle and must stay a runtime dependency because `extension-module-compiler.ts` imports it at runtime. `tailwindcss`, `@tailwindcss/postcss`, and `postcss` are externalized for the same reason (`widget-tailwind-css.ts`); keep the single pinned `postcss` in `pnpm-workspace.yaml` `overrides` so the plugin and processor share one version.

## Packaging

- `pnpm package:mac` tests the actual packaged app from `release/mac-universal/Menu Sprout Dev.app`.
- Local packaging uses the `Menu Sprout Dev` product name and `io.github.shin315.menusprout.dev` bundle id so local builds do not shadow the released `/Applications/Menu Sprout.app` in macOS LaunchServices. It explicitly disables Developer ID discovery and notarization, then applies an ad-hoc signature for local launch only.
- See [CONTRIBUTING.md](../CONTRIBUTING.md#release-notes) for the production release and downloaded-artifact verification procedure.
- The universal package must run on both Intel and Apple Silicon Macs, so packaged runtime native prebuilt dependencies must stay installed for `x64` and `arm64` and stay covered by `electron-builder.yml` `x64ArchFiles` when new native packages are added.
- `esbuild` is build-time-only and must stay excluded from `electron-builder.yml`. It enters the production dependency graph only through `acpx -> tsx -> esbuild`, but Menu Sprout imports the separately published `acpx/runtime` entry, which does not reference `tsx` or acpx's CLI chunk. The adapters are pre-bundled before packaging, while runtime extension compilation uses the shipped `typescript` dependency. `tests/acpx-runtime-dependencies.test.ts` locks the acpx entry-point boundary, and the packaged runtime E2E verifies a real ACP turn with neither `esbuild` nor `@esbuild` present in the app.
- Automation and throwaway checkouts must not leave packaged bundles behind: a leftover `release/mac-universal/*.app` gets registered by LaunchServices and can hijack `open -a "Menu Sprout"`, login items, and bundle-id launches. Delete the whole `release/` directory before finishing, never set a local bundle as a login item, and never install one into `/Applications` (released builds ship only as signed GitHub releases).
- Keep `electron-builder` at `26.8.2` or newer so pnpm-deduped dependencies are included correctly in packaged builds.

## Conventions

- TDD is required for bug fixes and new features.
- Tests live in `tests/` at the repo root, not co-located.
