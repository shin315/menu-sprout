# Architecture

How Menu Sprout fits together at runtime.
For the at-a-glance picture, see the "How It Works" diagram in the [README](../README.md#how-it-works).

## Process model

- **Three processes, one bridge.**
  The renderer never touches git, the agent, or the filesystem - everything goes through `window.menuSprout` exposed in `src/preload/index.ts`.
- **Settings overlay.**
  Settings covers the menu without unmounting it, so composer, widget, and run state survive opening and closing it.
- **Manual layout reload.**
  The header reload control remounts the menu surface by bumping its React key, which re-runs widget and root-layout discovery and resets widget React state without reloading the whole renderer or losing the agent conversation.

## Extensions

| Concept | What it is |
| --- | --- |
| Recipes | HTML specs under `extensions/recipes/` describing a widget's capability, data sources, fallbacks, and acceptance criteria. The agent reads the matching recipe before implementing. |
| Custom layouts | An optional root `layout.tsx` arranges the popover canvas. Without it, widgets stack in a column. |
| Settings sections | Extensions export `MenuSproutSettingsSection` from `widget.tsx`; the host frames each body. |
| Menu-bar items | `export const menuBar` in `<extension-id>/server.ts` gives a widget its own live text and icon in the macOS menu bar. See **Menu-bar items** below. |
| Server actions | Privileged work (shell, network, credentials) lives in `<extension-id>/server.ts`, called via `window.menuSprout.capabilities.invoke(...)`. No per-widget IPC. |
| Local storage | A shared SQLite store: `context.db` server-side, `window.menuSprout.db` in the renderer. Use it for anything that must survive reloads. |
| Stable contracts | Extensions import host types with type-only `import ... from "@menusprout/contracts"`, shipped into each workspace. |

For recipe authoring and live-source verification conventions, see [Recipe Authoring](recipes.md).
Provider-specific acquisition and refresh contracts live in the matching recipe.

**Background vs view refresh.**
`refreshView` / `viewRefreshIntervalMs` keeps a visible widget current and pauses while the popover is hidden.
`export const background` in `server.ts` runs on a host-owned timer (60-second minimum) for work that must continue while the popover is closed.

**Menu-bar items.**
A widget shows its own item in the macOS menu bar by exporting `menuBar` from `server.ts`; it is declarative, so there is no per-widget IPC or preload method.
The host (`src/main/menu-bar-items.ts`) discovers the export the same way it discovers `background`, calls `run(context)` on its own timer, and renders the returned `{ text?, icon?, tooltip? }` on one Electron `Tray` per widget (`createMenuBarItemView` in `src/main/tray.ts`).
Limits are enforced by the host and cannot be raised by a widget:

| Limit | Value |
| --- | --- |
| Update rate | `intervalMs` clamped to a 1-second floor (and to the 2^31-1 ms timer ceiling); the native item is only touched when the returned state or its icon file changed |
| Text | single line, whitespace collapsed, truncated to 24 characters with an ellipsis; tooltip truncated to 120 |
| Icon | PNG only, at most 64 KB: a `data:image/png;base64,` URL or a path relative to the extension folder (a symlink may not escape it; `name@2x.png` is picked up automatically); drawn as a template image and scaled to menu-bar height |
| Items | at most 5 in total, first by extension id; the rest are ignored with a warning |

Lifecycle: an item exists only while its `server.ts` exports `menuBar` and the last `run` returned text or an icon (`null` hides it). The bundled managed defaults declare no `menuBar`, so every item comes from a user-created extension. The manager resyncs from the extension workspace on every file change (debounced, same watcher pattern as background tasks) and at app start, so removing a widget, an Undo/Rollback of an agent turn, a code edit, and an app restart all converge on the files on disk: removed items are destroyed, edited code is re-run immediately, restored items reappear, and an icon file redrawn in place is reloaded on the next run.
A failing `run` keeps the last shown state and logs the error.
Clicking an item toggles the popover under that item, exactly like the main tray icon; there is no IPC channel or bridge method for menu-bar items.

**Extension contracts.**
Widgets conform to `MenuSproutWidget` / `RefreshableMenuSproutWidget`; `WidgetHost` owns visible-widget refresh timing via `useViewRefresh` and the main-process popover visibility signal, so widgets never start their own polling.
A root `layout.tsx` default-exports a `MenuSproutLayout`, receives active widget metadata plus `renderWidget(id)`, and owns the canvas arrangement; the popover adapts to the canvas width plus chrome and the rendered height.
Render failures stay contained: each widget and each extension settings section renders inside its own error boundary, a layout that throws falls back to the built-in column, and a root boundary around the menu surface keeps the header and agent chat mounted. A failed slot shows a sanitized one-line reason with "Ask the agent to fix" (pre-fills the composer, sends nothing); while a Keep/Undo session is open, "Undo last turn" is the primary action and "Ask the agent to fix" is disabled until the change is kept or undone.
Settings sections own only their body; `SettingsView` owns the frame and rediscovers sections when settings refresh or the popover reopens.
Server actions and background tasks are discovered dynamically, so new capabilities need no preload change.

**Module lifetime.**
An unchanged `server.ts` module instance stays alive across invokes and background ticks, so module-scope values are only an ephemeral cache - they reset on code edits or app restarts.

## Agent runtime

- **Bundled ACP adapters.**
  Built-in Claude Code, Codex, and Antigravity launch `out/adapters/<name>/index.mjs`, wrapping the local authenticated CLI.
  Cancellation and disposal stop the CLI and its tool process groups through a shared termination boundary before the adapter settles the turn.
  Claude Code and Codex run isolated from user-level agent config.
  Antigravity has no ACP mode, so its adapter drives `agy -p --output-format stream-json` one turn at a time: text streams as it arrives, later turns resume with `--conversation <id>`, cancellation terminates `agy` and every process group in its tree (agy runs tool commands in their own pty sessions), and a signed-out `agy` (which would otherwise wait for an OAuth code) fails fast with sign-in guidance.
  Codex still reuses only the top-level `model` from `$CODEX_HOME/config.toml` (or `~/.codex/config.toml`) so `--ignore-user-config` does not force an unsupported default.
  The host appends the Settings model and effort to a built-in adapter's launch command as adapter arguments (`--model`, `--effort`); each driver maps them to its CLI's own flags, and a Settings model replaces the Codex `config.toml` model.
  Drivers return the turn's own token usage as the ACP `PromptResponse.usage`, computing the per-turn difference for CLIs that report conversation totals and omitting it when that difference cannot be known.
- **Terminal failure semantics.**
  CLI, authentication, rate-limit, rejected model or effort, and provider failures reject through ACP with typed, bounded messages; raw provider payloads are never streamed or logged as user-facing errors.
  Menu Sprout also treats a completed ACP refusal as a failed editing turn, records failed diagnostics and telemetry, and strips nested transport error wrappers before displaying the safe message.
- **Live custom agent catalog.**
  Settings-owned custom ACP agents persist to `agents.json` and register as `acpx` overrides immediately, kept separate from read-only built-ins.

- **One turn at a time.**
  `MenuSproutAgentRuntime` (`src/main/agent-runtime.ts`) wraps `acpx/runtime` and accepts one `send()` at a time; an overlapping send gets an "already running" reply before any change session begins.
  Every accepted send runs inside a change session (see below).
- **Cancel, reply, and new conversation.**
  `menu-sprout:agent:cancel` aborts the running send: before the ACP turn starts it closes the eventual startup handle, and once the turn runs it calls `turn.cancel` and waits for settlement. Cancel, the idle timeout, and a stalled session startup all give the agent `AGENT_STOP_GRACE_MS` (5 seconds) to settle; after that the runtime closes every acpx client it started (stdin end, SIGTERM, then SIGKILL; the bundled adapters stop their tool processes on that SIGTERM), so no snapshot is exposed while the agent can still edit and nothing waits indefinitely.
  A cancelled send resolves with `cancelled: true` and the change-session snapshot, so partial changes stay reviewable exactly as after a failure.
  A completed send also returns `reply`, the agent's last message after its final tool call (`AgentFinalReply`), which the renderer shows as the only reply on screen.
  A refusal returns `refused: true`, the bounded failure notice, and any final `reply` under the same 4,000-character limit; diagnostics and telemetry still record a failed turn, and partial changes remain available for Keep or Undo.
  Conversation lifecycle operations share one promise chain, so startup cleanup and conversation reset finish before a later send can create or use the persisted session. The renderer blocks sending during reset.
  `menu-sprout:agent:new-conversation` discards the persisted ACP session the same way `SESSION_RESUME_REQUIRED` recovery does, and is refused under the same conditions as an agent switch.
- **Turn limits and metrics.**
  `AgentTurnMeter` (`src/main/agent-turn-metrics.ts`) measures each send from its start: wall-clock duration, tool calls counted once per `toolCallId` from the acpx event stream, and tokens only from the agent's ACP `PromptResponse.usage`, which acpx drops from its turn result, so the runtime wraps each acpx client's `prompt` to read it.
  The optional Settings limits (maximum turn time, maximum tool calls) abort the same signal as Cancel, so a limit stop uses the Cancel path and its bounded forced stop; the send resolves with `stoppedBy: "time-limit" | "tool-call-limit"` and the change-session snapshot. A user Cancel stops limit enforcement, so it decides the outcome.
  Every send that ran returns `metrics` (`durationMs`, `toolCalls`, optional `tokens`). A turn that started and then failed still reports them: because an `ipcRenderer.invoke` rejection carries only the message, `menu-sprout:agent:send` returns `{ failed: { message, metrics } }` and the preload's `agent.send` rejects with that plain object (the context bridge drops custom Error properties); a send that fails before any turn starts rejects with an Error and has no metrics. A send is refused before it starts while the active built-in agent's saved model or effort is invalid.
- **Agent selection.**
  Agent choice and availability are described in [Configuration](configuration.md#choosing-an-agent).
  Switching agents is blocked while a turn runs or while a change session can still be saved or rolled back; a successful switch closes the persistent session with `discardPersistentState` so the next turn starts a fresh conversation.
- **Persistent session.**
  The ACP runtime is built lazily with `createFileSessionStore({ stateDir })` under `.cache/menu-sprout/acp-sessions` (source) or `~/.menu-sprout/cache/acp-sessions` (packaged), `permissionMode: "approve-all"`, and the fixed `sessionKey: "menu-sprout-agent-chat"`.
  On `SESSION_RESUME_REQUIRED` it closes the runtime, removes `<stateDir>/sessions/menu-sprout-agent-chat.json`, and retries once.
  Failed attempts are written under the app data root's `.cache/menu-sprout/agent-turns` with `message`, `code`, and `detailCode`; if the retry fails, the renderer shows the real thrown message.

## Visual self-check

After building or editing a widget, the host prompts the embedded agent to capture an image of the rendered widget and inspect layout, clipping, and empty or error states alongside the live-data check. This is agent guidance, not a host-enforced completion gate.
The mechanism is the same for Claude Code, Codex, Antigravity, and custom agents, because every agent can run a shell command and open an image file.

- **Capture endpoint.**
  At startup the main process starts a loopback-only HTTP server (`src/main/widget-capture-server.ts`) on `127.0.0.1` with an ephemeral port and a random per-launch bearer token.
  `buildMenuSproutAgentPrompt` puts the ready-to-run `curl` command with that URL and token in the agent prompt (see `buildVisualSelfCheckInstructions` in `src/main/agent-runtime.ts`).
  The server answers only `GET /capture?widget=<widget-id>` (a missing `widget` is a 400), checks the token and that the `Host` header is exactly `127.0.0.1:<port>`, and replies with JSON `{ ok, path, width, height, widget, widgets }`.
  It is not a widget IPC channel: widgets never see it, and `window.menuSprout` and the preload bridge are unchanged.
- **Rendering.**
  `src/main/widget-capture.ts` (Electron-free, so unit-testable) opens a fresh hidden window through an injected surface, waits a fixed 2.5 s for widgets to fetch and paint, and captures only the requested widget card (`article[data-widget-id]`, id from `widget.tsx`), never the whole popover, so other widgets' data stays out of the agent transcript.
  `src/main/widget-capture-window.ts` is the Electron surface: a `BrowserWindow` with the popover's security flags, `show: false`, and `webContents.capturePage(rect, { stayHidden: true })`.
  A dedicated window means a capture always reflects the files on disk right now and never disturbs the user's popover (chat, scroll position, or visibility).
  Because it runs the same renderer, `ipc.ts` forwards the sending `webContents` id to the popover controller in `app.ts`, which sizes a capture window from its own reports and treats it as visible without moving or showing the real popover.
  Captures run one at a time.
- **Keep / Undo stays clean.**
  PNGs are written to `<cache>/captures` (location and retention in [configuration.md](configuration.md#where-state-lives)), never into the extension workspace, so they cannot appear in the git or snapshot diff.
  Startup refuses a capture directory inside the extension workspace (`assertOutsideDir`).
- **Scope.**
  Only one widget card in Menu Sprout's own popover can be captured; there is no screen capture, pixel diffing, or golden-image comparison.
  If the endpoint cannot start, the app logs it and the agent simply gets no capture instructions.

## Change tracking

- **Runtime-specific roots.**
  `pnpm dev` edits gitignored `extensions-dev/`; packaged builds seed and edit `~/.menu-sprout/extensions` with snapshot save/rollback.
  Tracked `extensions/` stay the source templates, including the generated `@menusprout/contracts` declaration.
- **Best-effort packaged seeding.**
  Packaged startup resolves a symlinked `~/.menu-sprout/extensions` to its real target before copying bundled defaults, so managed links into writable directories keep working without replacing the link.
  Seeding failures are logged and skipped instead of aborting tray creation.
- **Packaged module compilation.**
  Packaged widgets and root layouts compile into `~/.menu-sprout/cache`; Tailwind source scanning resolves a symlinked extension root before copying it to the temporary scan directory.
  A root layout that fails to compile falls back to the built-in column and logs a warning so it is distinguishable from no authored layout.
- **Snapshot rollback safety.**
  Snapshot workspaces restore in place instead of replacing the workspace directory, so a symlinked extension workspace stays linked while files, directories, symlinks, binary contents, and modes return to the pre-turn state.
  Existing user-owned `.git` metadata is ignored and preserved, while `.git` metadata created by a turn is removed with the rest of that created subtree.
- **Session selection.**
  Snapshot workspaces (`extensions-dev/`, packaged `~/.menu-sprout/extensions`) use `DevExtensionChangeSession` (`src/main/dev-extension-change-session.ts`).
  The tracked source `extensions/` workspace uses `GitChangeSession` (`src/main/git-change-session.ts`) only when selected explicitly (for example with `MENU_SPROUT_EXTENSIONS_DIR`).
- **Git session guards.**
  `GitChangeSession.begin` refuses to run the agent when the working tree is dirty.
  Save and Rollback refuse unless the session started clean, is not already completed, and `HEAD` has not moved since it began.
  Rollback runs `git reset --hard <recorded HEAD>` plus `git clean -fd`; those destructive commands are acceptable only because of these guards.
- **Diff-derived Keep / Undo.**
  The bar reflects the actual git or snapshot diff, not agent wording - it names created, updated, or removed extensions, reports `layout.tsx` edits as layout changes, and clears itself when nothing changed on disk.
  Successful clean turns still report that no changes were made; failed clean sessions close without that no-op message, while partial changes from failed turns remain available for Keep or Undo alongside the failure guidance.

## Updates and telemetry

- **Release indicator.**
  The main process checks the latest GitHub Release, stays silent on failure, and links to the release page only when a newer release of `shin315/menu-sprout` exists.
  See [PRIVACY.md](../PRIVACY.md#update-check) for request timing and retry behavior.
- **Anonymous telemetry.**
  The main process wraps the Umami client in a gate, initialized after preferences are loaded and updated after a Settings choice is saved.
  [PRIVACY.md](../PRIVACY.md#usage-telemetry) owns the configuration, event disclosure, and opt-out precedence; the Settings privacy section presents that disclosure in the app.

## Security boundaries

- `createPopoverOptions` (`src/main/popover.ts`) enforces `frame:false`, `contextIsolation:true`, `nodeIntegration:false`, `skipTaskbar:true`, and `alwaysOnTop:true`.
- On macOS, `app.ts` appends Chromium's `use-mock-keychain` switch before app readiness, so Chromium or renderer storage cannot hold keychain-backed secrets; credential and token work belongs in extension server actions.
- New generic IPC routes are added only in `src/main/ipc.ts`; widgets never get per-widget IPC channels or preload methods.
- Packaged runtime state lives under `~/.menu-sprout` and is not git-backed. Generated extension files, the extension database, compiled modules, preferences, logs, snapshots, and ACP session state never go into the `.app` bundle.

## Public extension surfaces

Public extension surfaces are deliberate, tested contracts:

- **`@menusprout/contracts`.**
  Extensions cannot see `src/shared/contracts.ts` (it lives inside the app bundle), so the host ships the extension-facing types into each workspace as a virtual module declared in `extensions/menusprout-env.d.ts`.
  `scripts/generate-extension-dts.mjs` (`pnpm generate:contracts`) generates that file from `contracts.ts`, selecting the names in `src/shared/extension-contract-names.ts`; `MenuSproutExtensionApi` is the window-bridge subset extensions may use.
  The file is tracked because typecheck, `pnpm dev`, and packaging all read it; `tests/extension-contract-surface.test.ts` and CI fail when it is stale.
  Extensions use only type-only imports from it (erased by the compiler); importing a value is rejected.
  Never point an extension or its agent at `../../src/shared/contracts`: that path exists only in source mode and previously sent the embedded agent scanning protected home-directory folders.
- **`@menusprout/ui`.**
  `src/ui/` is a shadcn-derived kit (Radix + Tailwind v4) styled through theme tokens and shared by the app shell and extensions.
  `src/ui/theme.css` is the single `@theme` source of truth: it wipes Tailwind's default palette and is consumed by both the renderer build (`src/ui/styles.css`) and the per-widget/layout compiler (imported `?raw` into the main bundle).
  Its tokens read `--th-*` values: the bare `:root` block is the default Monochrome Lab theme, and each `:root[data-theme]` block overrides it for a selectable theme listed in `src/shared/themes.ts`, so token-styled widgets follow the Settings theme.
  Each theme also has a `@media (prefers-color-scheme: light)` variant; the Settings appearance sets Electron's `nativeTheme.themeSource`, which decides which variant every renderer matches.
  The shell and shared components inherit the theme's prose font from `html, body`; code, the composer, and explicit `font-mono` utilities keep the theme's monospace font.
  `main.tsx` installs the kit on `window.__MENU_SPROUT_WIDGET_HOST__.ui`, `widget-protocol.ts` serves `menu-sprout-host://ui/index.mjs` as a re-export, and the compiler rewrites the bare specifier to that URL, so Radix, cva, and lucide stay in the host bundle.
  `src/shared/ui-exports.ts` is the public surface contract, kept in lockstep with the barrel and host shim by `tests/ui-export-contract.test.ts`.
  Extension renderer modules may import `react` and `@menusprout/ui` externally (server modules also Node builtins), plus type-only `@menusprout/contracts`; relative imports of local helpers within the extension workspace are allowed. Widgets author token-scoped Tailwind utilities whose stylesheet is compiled and injected automatically.
- **`window.menuSprout`.**
  Exposed by `src/preload/index.ts`; new capabilities go through extension server actions and `capabilities.invoke`, not new preload methods.

## Source module index

| Module | Role |
| --- | --- |
| `src/main/app.ts` | Lifecycle, popover window, packaged paths, seeding, preferences, agent catalog wiring, protocols, tray, IPC. `package.json#main` points here via `out/main/index.js`; `process.env.VITEST` stops tests from auto-starting the app. |
| `src/main/app-paths.ts` | Source versus packaged `~/.menu-sprout` paths |
| `src/main/tray.ts`, `popover.ts` | Tray icon with its native right-click menu (Open, Reload, Quit) and per-widget menu-bar item trays; popover window options, adaptive sizing, bounds math, renderer loading |
| `src/main/renderer-recovery.ts` | Reloads the popover renderer once after a crash or hang, with a 30-second guard against reload loops; the tray menu Reload restarts it in a fresh process regardless of the guard |
| `src/main/menu-bar-items.ts` | Electron-free manager for widget menu-bar items: state normalization and limits, icon path validation, run timers, add/remove/hot-reload resync |
| `src/main/ipc.ts` | All `ipcMain` handlers behind the preload bridge |
| `src/main/widget-capture.ts`, `widget-capture-server.ts`, `widget-capture-window.ts` | Visual self-check: capture core (PNG output, pruning, widget crop), token-gated loopback endpoint the agent calls, hidden Electron capture window |
| `src/main/agent-catalog.ts`, `agent-catalog-controller.ts` | Built-in and custom agents, `agents.json` parsing and persistence, availability, live `acpx` registry overrides |
| `src/main/agent-runtime.ts`, `agent-turn-log.ts` | Agent turns, change-session gating, diff-derived labels, structured per-turn logs |
| `src/main/agent-turn-metrics.ts`, `src/shared/agent-options.ts` | Per-turn duration, tool-call, and reported-token metrics and limit enforcement; built-in model and effort choices and turn-limit validation |
| `src/main/git-change-session.ts`, `dev-extension-change-session.ts`, `extension-change.ts` | Git and snapshot Save/Rollback, diff classification into created/updated/removed extension or layout changes |
| `src/main/extension-seeder.ts` | Force-copies shipped defaults (`AGENTS.md`, `menusprout-env.d.ts`, `recipes/`, managed extensions) into the packaged workspace on every launch, never deleting user extensions. Edits to managed defaults in `~/.menu-sprout/extensions` do not persist; change `extensions/` instead. |
| `src/main/extension-module-compiler.ts` | Compiles packaged widget, layout, and server modules; rewrites `react` and `@menusprout/ui` to host protocol modules, rejects other external imports (server modules may also use Node builtins), repairs stale content-addressed cache outputs |
| `src/main/widget-tailwind-css.ts` | Compiles widget and layout Tailwind utilities against `src/ui/theme.css` for packaged loading |
| `src/main/widget-module-registry.ts`, `widget-protocol.ts` | Discovers widgets and root `layout.tsx` (Vite `/@fs` URLs in dev, compiled `menu-sprout-widget://` modules plus `cssUrl` when packaged); serves compiled modules and host shims |
| `src/main/server-action-registry.ts`, `background-task-scheduler.ts` | Discovers and caches server actions, background tasks, and menu-bar items; host-owned timers with a 60-second minimum |
| `src/main/extension-database.ts`, `notifier.ts` | Shared SQLite store; native notifications for `context.notify` |
| `src/main/preferences.ts` | App preferences; login-item settings only for the packaged production product named `Menu Sprout` |
| `src/main/shell-path.ts` | Expands `PATH` for GUI launches so packaged apps find agent CLIs |
| `src/main/update-checker.ts` | GitHub Release status cache and release-page link; simulates an available update in source/dev mode |
| `src/main/recipe-loader.ts` | Discovers `recipes/*.html` and extracts titles |
| `src/main/telemetry.ts` | Umami client, configuration resolution, and Settings preference gate |
| `src/renderer/menu/RenderErrorBoundary.tsx` | Per-widget and root render error boundaries, the sanitized error card, and its recovery actions |
| `src/renderer/extension-modules.ts` | Runtime loader for widget and layout modules, including packaged stylesheet injection |
| `src/renderer/settings/settings-sections.ts` | Collects `MenuSproutSettingsSection` exports, sorted by extension id |
| `src/renderer/settings/PrivacySection.tsx` | Settings privacy section: the telemetry switch and the list of data that leaves the Mac, kept in sync with `PRIVACY.md` |

## Repository layout

| Path                        | What lives here                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------- |
| `src/adapters/`             | Bundled clean-room ACP adapters for built-in Claude Code, Codex, and Antigravity agents |
| `src/main/`                 | Electron lifecycle, tray, popover, IPC, git, agent runtime, update checks              |
| `src/preload/index.ts`      | The stable `window.menuSprout` bridge                                                    |
| `src/renderer/`             | React UI: `AgentChat`, `WidgetHost`, custom layouts, settings, updates, layout reloads, app controls |
| `src/ui/`                   | Shared `@menusprout/ui` design system for shell and extension renderer surfaces          |
| `src/shared/contracts.ts`   | `MenuSproutApi`, `MenuSproutWidget`, `MenuSproutSettingsSection`, `GitSessionSnapshot`, etc. |
| `src/shared/extension-contract-names.ts` | Public type names exported through `@menusprout/contracts`                  |
| `extensions/menusprout-env.d.ts` | Generated `@menusprout/contracts` declarations copied into extension workspaces       |
| `extensions/layout.tsx`     | Optional root popover layout component for arranging active widgets                     |
| `extensions/<id>/`          | Tracked extensions (`widget.tsx` descriptors, `components.tsx` views, `server.ts`)      |
| `extensions/recipes/*.html` | Self-contained widget specs the agent reads                                            |
| `extensions-dev/`           | Gitignored dev workspace prepared by `scripts/dev.mjs`                                 |
| `~/.menu-sprout/extensions/`  | Packaged app extension workspace                                                       |
| `~/.menu-sprout/menu-sprout.db` | Packaged app's shared local SQLite store for extensions                                |
| `~/.menu-sprout/cache/`       | Packaged widget, server-action, snapshot, and agent caches                             |
| `tests/`                    | Vitest tests (e2e specs are `tests/e2e-*.test.ts`)                                     |
