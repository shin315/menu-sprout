# Configuration

How a running Menu Sprout install stores state, picks a theme and an agent, and can be tuned.

## Where state lives

The packaged app keeps everything mutable under `~/.menu-sprout`: extensions, the local SQLite database, caches, agent sessions, the custom agent catalog, and preferences.
Upgrades preserve this directory, so generated widgets and extension state survive.

On launch, packaged Menu Sprout refreshes bundled defaults (`AGENTS.md`, `menusprout-env.d.ts`, recipes, starter extensions) from the app template while leaving your own extension directories untouched.
If `~/.menu-sprout/extensions` is a symlink, Menu Sprout resolves it for seeding and packaged widget/layout CSS compilation, which supports managed symlinks into writable dotfiles directories such as home-manager `mkOutOfStoreSymlink`.
Read-only or otherwise invalid targets are skipped with a log message instead of blocking startup.

Widget captures from the agent's visual self-check are saved under `~/.menu-sprout/cache/captures` (`.cache/menu-sprout/captures` when running from source), outside the extension workspace so they never show up as changes; only the newest 20 are kept.

## Choosing a theme

Open Settings and choose a bundled theme and an appearance (Light, Dark, or System) under **preferences**.
Both apply immediately to the shell, the Settings view, and widgets styled with Menu Sprout tokens. They are saved for the next launch in `preferences.json` (`~/.menu-sprout/preferences.json` in packaged mode, at the repo root in source mode).
If no theme is saved or its ID is unknown, Menu Sprout uses Default (Monochrome Lab). If no appearance is saved or its value is unknown, Menu Sprout uses System, which follows the macOS light or dark appearance live.
Every bundled theme, including Default, has a light and a dark look; Light and Dark pin that look regardless of the macOS setting.

## Choosing an agent

Menu Sprout detects supported agents in order: Claude Code (`claude`), Codex (`codex`), then Antigravity (`agy`).
Detection picks the first CLI found on `PATH`; use Settings or `MENU_SPROUT_AGENT` to choose another.
When launched from the Dock or at login, Menu Sprout adds your login shell's `PATH`, and if a built-in CLI is still missing it also reads an interactive shell's `PATH` in the background (sourcing `~/.zshrc` or `~/.bashrc`), so CLIs installed through nvm, asdf, or volta are found.
Agent runs wait for that probe (at most 5 seconds); Settings opened in the first seconds after launch may briefly show such a CLI as unavailable until reopened.
Claude Code and Codex run through bundled clean-room ACP adapters that drive the authenticated local CLI without inheriting user-level settings, skills, MCP servers, or extra rules.
Antigravity also runs through a bundled adapter (see below).

| Mechanism | Effect |
| --- | --- |
| Settings | Persist an agent choice across launches; add, edit, or remove custom agents. |
| `MENU_SPROUT_AGENT=<name>` | Override auto-detection before a preference is saved. |
| `agents.json` | Override or append catalog entries manually. |

If a send fails, the popover shows bounded, actionable guidance instead of raw provider diagnostics or a generic unavailable hint.
For built-in agents, authentication failures prompt you to sign in before trying again: run `codex login`, launch `claude`, or open Antigravity (`agy`) and complete sign-in.
If the failed turn edited files before stopping, Menu Sprout keeps those partial changes available for Keep or Undo; a failed turn with no file changes closes cleanly.
Cancel on the run strip stops a running turn the same way: the popover says it was cancelled, partial changes stay available for Keep or Undo, and a cancelled turn with no file changes closes cleanly.
If an agent ignores Cancel for 5 seconds (`AGENT_STOP_GRACE_MS`), Menu Sprout closes the agent's acpx client, which ends its stdin, sends SIGTERM, then SIGKILL, and the turn ends as cancelled. The idle timeout and a stalled session startup use the same bounded stop, so changes become reviewable only after the agent has stopped and never wait indefinitely.

Follow-up turns continue the same agent conversation until you start a new one from the popover header.
A new conversation is refused while a turn runs or while a change is still waiting for Keep or Undo.
If the saved conversation cannot be deleted, Menu Sprout reports that reset failed and keeps the last reply visible.
After each completed turn the popover shows only the agent's final message (the text after its last tool call), collapsed to two lines and expandable; earlier turns are never shown.
A refusal shows the bounded failure notice alongside the agent's final message, using the same collapsed reply area and 4,000-character limit as a successful turn. If the agent provided no final text, only the notice appears.

### Model, effort, and turn limits

Settings has a **model and effort** row for each built-in agent.
Leaving the model empty and the effort on CLI default passes nothing, so the CLI uses its own default.
Any other choice is passed by the bundled adapter as that CLI's own flags:

| Agent | Model | Effort | Effort levels offered |
| --- | --- | --- | --- |
| Claude Code | `--model <id>` (aliases `fable`, `opus`, `sonnet`, `haiku`, or a full model name) | `--effort <level>` | low, medium, high, xhigh, max |
| Codex | `--model <id>` (ids from `codex debug models`) | `-c model_reasoning_effort="<level>"` | none, minimal, low, medium, high, xhigh, max, ultra |
| Antigravity | `--model <id>` (ids from `agy models`) | `--effort <level>` | low, medium, high, xhigh, max |

A model id must be a single argument (letters, numbers, and `. _ : / @ [ ] -`, no spaces, not starting with `-`).
A changed choice applies from the agent's next turn and starts that agent on a fresh conversation; while a turn runs or a change waits for Keep or Undo, it applies once that is resolved.
Custom ACP agents have no model or effort setting.

Unknown values fail with a clear message instead of being dropped:

- Settings refuses a malformed model id or an effort level not listed above.
- A saved value Menu Sprout no longer offers (for example from an older `preferences.json`) is flagged in Settings, and turns with that agent are refused with the same message until you pick another value or CLI default.
- When the CLI itself rejects the model or effort (each model supports its own subset of levels), the turn fails with "<agent> did not accept the model/effort level it was asked to use" instead of a generic provider failure. Claude Code prints only a warning for an unknown `--effort` and would carry on at its default, so the adapter stops that turn instead.

The **turn limits** rows set an optional maximum turn time (1-240 minutes, measured from send, including agent startup) and maximum tool calls (1-1000); both are off when empty.
A turn that reaches a limit stops through the same bounded path as Cancel, the popover says `Stopped: time limit` or `Stopped: tool-call limit`, and any partial changes stay for Keep or Undo.
The tool-call limit allows that many calls and stops the turn when the agent starts one more, so the stopped turn's count is at least one higher than the limit (more if the agent started several calls at once).
If you press Cancel first, the turn reports as cancelled even when a limit is reached while it stops.
Custom ACP agents get the same limits.

After each turn, including one that fails after the agent started working, the popover shows one line of measured numbers: duration, tool calls, and tokens only when the agent reported them for that turn over ACP (hover for the input, cache, output, and reasoning breakdown).
Nothing is estimated; when tokens are not reported, they are left out rather than shown as zero.
The bundled adapters report the CLI's own counts: Claude Code's per-run usage, and for Codex and Antigravity, which report running totals for the conversation, the change since the previous turn.
If an earlier turn in that conversation ended without totals (for example a cancelled turn), the adapter cannot know the difference, so the next turn shows no tokens.
A custom ACP agent's tokens appear only when it returns ACP `usage` in its prompt response.

### Antigravity

Antigravity has no ACP mode, so the bundled adapter drives its headless print mode (`agy -p <prompt> --output-format stream-json --dangerously-skip-permissions`), one short-lived process per turn.
Replies stream as they arrive, follow-up turns resume the same conversation, and Cancel terminates the running `agy` along with any tool commands it started.
If `agy` is signed out, the turn fails immediately with sign-in guidance instead of waiting for an OAuth code.
Unlike the Claude Code and Codex adapters, it does not isolate the agent from your Antigravity user configuration beyond disabling slash-command expansion.

### Codex model exception

With the Codex model on CLI default, the adapter reads only the top-level `model` from `$CODEX_HOME/config.toml` or `~/.codex/config.toml` and passes it as `--model`, because it otherwise runs Codex with `--ignore-user-config`. A model chosen in Settings replaces it.

## Custom ACP agents

Add agents from Settings (id, optional label, ACP launch command) or by editing `agents.json` directly.
Packaged mode reads `~/.menu-sprout/agents.json`; source mode reads `agents.json` at the repo root.
Settings-added agents are editable and removable; the built-in agents (Claude Code, Codex, and Antigravity) stay read-only.

Each entry is an object with `name`, optional `label`, `command`, `installHint`, and `launchCommand`.
Entries with `launchCommand` register as custom [`acpx`](https://github.com/openclaw/acpx) overrides and show as available.

```json
[
  {
    "name": "pi",
    "label": "Pi",
    "launchCommand": "npx pi-acp"
  }
]
```

`launchCommand` is any Agent Client Protocol (ACP) server command.
The underlying CLI must be installed and authenticated.
Examples:

| Agent | `launchCommand` |
| --- | --- |
| Pi | `npx pi-acp` |
| Cursor | `cursor-agent acp` |
| GitHub Copilot | `copilot --acp --stdio` |
| Qwen Code | `qwen --acp` |
| OpenCode | `npx -y opencode-ai acp` |

## Updates

Menu Sprout has no published releases and no Homebrew cask yet.
When a newer GitHub Release of `shin315/menu-sprout` exists, Menu Sprout shows an indicator in the popover header that opens a dialog linking to the release page, where the new build is downloaded.
Until the repository publishes a release, the check finds nothing and the indicator stays hidden.

## Telemetry

See [PRIVACY.md](../PRIVACY.md#usage-telemetry) for telemetry configuration, collected data, and how the Settings privacy switch takes precedence over the launch environment.

## Environment flags

| Var                                 | Effect                                                                                                                                                                                                            |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MENU_SPROUT_KEEP_POPOVER_OPEN=1`   | Disables blur-to-hide so devtools / external windows stay up                                                                                                                                                      |
| `MENU_SPROUT_AGENT=<name>`          | Overrides agent auto-detection when no saved Settings choice exists                                                                                                                                               |
| `MENU_SPROUT_AGENT_TIMEOUT_MS=<ms>` | Overrides the embedded-agent request timeout                                                                                                                                                                      |
| `MENU_SPROUT_EXTENSIONS_DIR=<dir>`  | Overrides the active extension workspace in source/dev runs. Dev Tailwind scans only `extensions/` and `extensions-dev/`, so overrides outside those paths need matching `@source` coverage for widget utilities. |
| `CODEX_HOME=<dir>`                  | When Codex is the selected built-in agent, points the adapter at `<dir>/config.toml` for the top-level `model`; other Codex user config is still ignored.                                                         |
| `MENU_SPROUT_TELEMETRY=0`           | Telemetry opt-out; accepted values and precedence are documented in [PRIVACY.md](../PRIVACY.md#turning-it-off).                                                                                                    |
| `MENU_SPROUT_UMAMI_HOST=<url>`      | Overrides the self-hosted Umami endpoint; configuration requirements are documented in [PRIVACY.md](../PRIVACY.md#usage-telemetry).                                                                                 |
| `MENU_SPROUT_UMAMI_WEBSITE_ID=<id>` | Overrides or supplies the Umami website id used by telemetry. The release workflow reads this from the GitHub Actions `vars.*` context, not a secret.                                                             |
