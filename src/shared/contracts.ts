import type { ReactNode } from "react";

export type RecipeMetadata = {
  id: string;
  title: string;
  fileName: string;
  path: string;
};

// What a single workspace surface had done to it during an agent turn, derived
// from the actual diff (git status / snapshot comparison), never from the
// agent's prose. A change targets either a specific extension or the root layout.
export type WorkspaceChangeKind = "created" | "updated" | "removed";

export type WorkspaceChange =
  | { kind: WorkspaceChangeKind; type: "extension"; extensionId: string }
  | { kind: WorkspaceChangeKind; type: "layout" };

export type GitSessionSnapshot = {
  startedClean: boolean;
  canSave: boolean;
  canRollback: boolean;
  head: string | null;
  message?: string;
  // Classification of what the turn changed. Absent when the change session
  // could not be inspected; empty when the turn touched only files we do not
  // attribute to a surface (recipes, AGENTS.md, etc.).
  changes?: WorkspaceChange[];
  // Whether the workspace actually differs from its pre-turn state. False means
  // the agent reported back without making any on-disk change.
  dirty?: boolean;
};

export type GitActionResult = {
  ok: boolean;
  reason?: string;
  commit?: string;
};

export type AgentChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
};

export type AgentChatResult = {
  assistantText: string;
  session?: GitSessionSnapshot;
  // The agent's own final message for this turn (the text after its last tool
  // call), never host-written text. Absent when the agent said nothing, and on
  // timed-out or cancelled turns.
  reply?: string;
  // True when the turn stopped because it was cancelled. Partial changes stay in
  // `session` for Keep or Undo, the same as a failed turn.
  cancelled?: boolean;
  // Set when a Settings turn limit stopped the turn through the Cancel path.
  // Partial changes stay in `session` for Keep or Undo.
  stoppedBy?: AgentTurnStopLimit;
  refused?: boolean;
  // Measured numbers for the turn; absent when no turn ran (a dirty workspace).
  metrics?: AgentTurnMetrics;
};

export type AgentTurnStopLimit = "time-limit" | "tool-call-limit";

// Token usage exactly as the agent reported it over ACP for this one turn.
// `inputTokens` includes cache reads and writes; the cache and thought counts
// are parts of the input and output totals, not extra tokens.
export type AgentTurnTokenUsage = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
};

// What the host measured for a turn. Never estimated: `tokens` is present only
// when the agent reported usage for the turn.
export type AgentTurnMetrics = {
  durationMs: number;
  toolCalls: number;
  tokens?: AgentTurnTokenUsage;
};

// How agent.send rejects when a turn ran and then failed, so its cost still
// shows. A plain object rather than an Error: the context bridge drops custom
// properties from Errors.
export type AgentTurnFailure = {
  message: string;
  metrics: AgentTurnMetrics;
};

// What the send route returns to the preload, which rethrows `failed`.
export type AgentSendResponse = AgentChatResult | { failed: AgentTurnFailure };

export type AgentActionResult = {
  ok: boolean;
  reason?: string;
};

export type AgentRuntimeStatus = {
  text: string;
  eventType: "text_delta";
};

// The turn currently executing in the main process. `startedAt` is an epoch ms
// timestamp so the renderer can render the elapsed timer after a remount.
export type AgentActiveTurn = {
  title: string;
  startedAt: number;
};

export type MenuSproutAgentOption = {
  name: string;
  label: string;
  available: boolean;
  installHint?: string;
  /** True for user-configured ACP agents (editable/removable); false for built-ins. */
  custom?: boolean;
  /** The configured ACP launch command; only present for custom agents (for the edit form). */
  command?: string;
};

/** Fields collected by the Settings UI when adding a custom ACP agent. */
export type MenuSproutCustomAgentInput = {
  /** acpx registry id; must be unique and not collide with a built-in. */
  name: string;
  /** Display label; defaults to the name when omitted. */
  label?: string;
  /** The ACP launch command string (acpx splits it into argv). */
  command: string;
};

/** A built-in agent's model and effort choices as shown in Settings. */
export type MenuSproutAgentModelSettings = {
  /** Built-in agent name: claude, codex, or antigravity. */
  name: string;
  label: string;
  /** Saved model id; absent means CLI default (nothing is passed). */
  model?: string;
  /** Saved effort level; absent means CLI default (nothing is passed). */
  effort?: string;
  /** Effort levels this CLI documents. */
  efforts: string[];
  /** Documented model aliases to suggest; any model id is accepted. */
  modelSuggestions: string[];
  /** The CLI flags the adapter passes these as. */
  flags: string;
  /** Why the saved values cannot be used; turns with this agent are refused until fixed. */
  problem?: string;
};

/** Optional per-turn limits; absent fields are off. */
export type MenuSproutTurnLimits = {
  maxTurnMinutes?: number;
  maxToolCalls?: number;
};

/** What decided the telemetry switch: the saved Settings choice, MENU_SPROUT_TELEMETRY, or the on default. */
export type MenuSproutTelemetrySource = "preference" | "environment" | "default";

export type MenuSproutTelemetrySettings = {
  /** Whether anonymous usage telemetry is switched on. */
  enabled: boolean;
  source: MenuSproutTelemetrySource;
  /** Whether the build and launch environment resolve to a usable Umami host and website id. */
  configured: boolean;
};

export type MenuSproutSettings = {
  openAtLogin: boolean;
  /** Name of the active embedded agent. */
  agentName: string;
  /** Present when the current runtime state prevents switching agents. */
  agentSwitchDisabledReason?: string;
  /** Selectable agents; unavailable ones are shown disabled with an install hint. */
  agents: MenuSproutAgentOption[];
  /** The selected UI theme. */
  theme: string;
  /** The selected appearance mode (light, dark, or system). */
  appearance: "light" | "dark" | "system";
  telemetry: MenuSproutTelemetrySettings;
  /** Model and effort choices for each built-in agent. */
  agentModels: MenuSproutAgentModelSettings[];
  turnLimits: MenuSproutTurnLimits;
};

// SQL bind parameters: positional (an array) or named (an object keyed by the
// bare parameter name, e.g. { name } for ":name").
export type SqlParams = unknown[] | Record<string, unknown>;

export type SqlRunResult = {
  changes: number;
  lastInsertRowid: number | bigint;
};

// The synchronous SQL surface extensions use from server actions and background
// tasks. The host's ExtensionDatabase implements this plus lifecycle (close).
export type MenuSproutDatabase = {
  query: <T = Record<string, unknown>>(sql: string, params?: SqlParams) => T[];
  get: <T = Record<string, unknown>>(sql: string, params?: SqlParams) => T | undefined;
  run: (sql: string, params?: SqlParams) => SqlRunResult;
  exec: (sql: string) => void;
  transaction: <T>(fn: () => T) => T;
};

export type MenuSproutNotification = {
  title: string;
  body?: string;
};

// Passed to every server action and background task. Privileged, main-process side.
export type MenuSproutServerContext = {
  rootDir: string;
  db: MenuSproutDatabase;
  // Show a native system notification. The main reason a background task is worth
  // having: it can alert the user (e.g. a threshold breach) while the popover is closed.
  notify: (notification: MenuSproutNotification) => void;
};

// Declared as `export const background` in an extension's server.ts. The host runs
// `run` on its own timer (clamped to a 60s floor) whether or not the popover is open,
// so it is the place for work that must keep happening in the background. Persist
// results with `context.db` and a widget can read them on open.
export type MenuSproutBackgroundTask = {
  intervalMs: number;
  run: (context: MenuSproutServerContext) => void | Promise<void>;
  // Whether to run once as soon as the task is scheduled (default true) so data is
  // warm before the first refresh tick.
  runOnStart?: boolean;
};

export type BackgroundTaskUpdate = {
  extensionId: string;
};

// What a widget's menu-bar item shows right now. At least one of `text` and `icon`
// must be present, otherwise the item is hidden until a later run returns one.
export type MenuSproutMenuBarState = {
  // Short live text shown next to (or instead of) the icon. Single line; the host
  // collapses whitespace and truncates it to 24 characters.
  text?: string;
  // A monochrome template icon: either a `data:image/png;base64,...` URL or a
  // `.png` path relative to the extension folder. The host renders it as a
  // template image so it follows the light/dark menu bar.
  icon?: string;
  // Hover text for the item (truncated to 120 characters).
  tooltip?: string;
};

// Declared as `export const menuBar` in an extension's server.ts. The host owns the
// menu-bar item (one per extension, at most 5 in total): it calls `run` on its own
// timer (clamped to a 1s floor) and shows the returned state. Return `null` to hide
// the item for now. The item disappears when the extension's server.ts is removed,
// edited to drop `menuBar`, or an agent turn is undone. Clicking it opens the
// popover under the item.
export type MenuSproutMenuBarItem = {
  intervalMs: number;
  run: (context: MenuSproutServerContext) => MenuSproutMenuBarState | null | undefined | Promise<MenuSproutMenuBarState | null | undefined>;
};

export type MenuSproutCapabilityDescriptor = {
  id: string;
  extensionId: string;
  action: string;
};

export type MenuSproutWidgetModuleDescriptor = {
  id: string;
  extensionId: string;
  moduleUrl: string;
  // Compiled per-widget Tailwind stylesheet, present only in packaged/compiled
  // mode. In dev/source mode widget utilities come from the global stylesheet.
  cssUrl?: string;
};

// The optional, agent-authored layout module at the root of the extension
// workspace (`layout.tsx`). When present the host renders its default export in
// place of the built-in stacked column; when absent the host falls back to the
// column, so this is purely additive and older apps that never look for it keep
// working. Loaded through the same pipeline as a widget module - `moduleUrl`
// (a `/@fs` URL in dev, a `menu-sprout-widget://` URL when compiled) plus a sibling
// compiled `cssUrl` in packaged mode.
export type MenuSproutLayoutModuleDescriptor = {
  moduleUrl: string;
  cssUrl?: string;
};

export type MenuSproutWidget = {
  id: string;
  title: string;
  render: () => ReactNode;
};

// A configuration surface an extension contributes to the Settings page,
// exported from `widget.tsx` alongside its widget. Renderer-only, like a widget:
// the host draws the section frame (title, dividers, spacing) and the extension
// owns only the body. It reads and writes its own configuration through the
// existing bridges (`window.menuSprout.db`), so no per-extension IPC is added.
export type MenuSproutSettingsSection = {
  // Matches the extension id; used as the section key and for stable sort order.
  extensionId: string;
  // Terse section label, e.g. "CALENDAR".
  title: string;
  // Body only; the host draws the section frame around it.
  render: () => ReactNode;
};

export type RefreshableMenuSproutWidget = MenuSproutWidget &
  (
    | {
        // View refresh re-renders a visible widget. It is owned by the host and
        // paused while the popover is hidden. It is not a way to sync data in the
        // background - declare a `background` task in server.ts for that.
        viewRefreshIntervalMs?: number;
        refreshView: () => void | Promise<void>;
      }
    | {
        viewRefreshIntervalMs?: never;
        refreshView?: never;
      }
  );

// The metadata the host hands a custom layout for each active extension so it
// can decide what to place and where. The layout never imports widget files
// directly; it places each one by id through `renderWidget`.
export type MenuSproutLayoutWidget = {
  id: string;
  title: string;
};

// Props the host passes to the default export of `layout.tsx`. `renderWidget`
// returns the refresh-wired, title-less render of one extension by id (null for
// an unknown id), so the layout keeps the host's view-refresh wiring while
// owning the arrangement and the overall canvas size (the host measures the
// rendered layout and resizes the popover to fit its width and height).
export type MenuSproutLayoutProps = {
  widgets: MenuSproutLayoutWidget[];
  renderWidget: (id: string) => ReactNode;
};

// The default export shape of an `extensions/layout.tsx` module.
export type MenuSproutLayout = (props: MenuSproutLayoutProps) => ReactNode;

export type PopoverVisibilityState = {
  visible: boolean;
};

// Result of the host's background check against the latest published release.
// `updateAvailable` is true only when a newer version than the running build was
// found; `latestVersion`/`releaseUrl` are null when the check has not succeeded
// yet (offline, rate limited, etc.) so the shell can fail silent.
export type UpdateStatus = {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
};

export type MenuSproutApi = {
  recipes: {
    list: () => Promise<RecipeMetadata[]>;
  };
  git: {
    save: (message?: string) => Promise<GitActionResult>;
    rollback: () => Promise<GitActionResult>;
    // Snapshot of the outstanding agent change session, or null when none is open
    // OR a turn is still running. Lets the renderer re-hydrate a pending
    // Keep/Rollback prompt after a reload, since that prompt is otherwise ephemeral
    // renderer state. Returns null mid-turn so the prompt never appears before the
    // build finishes; pair with agent.getActiveTurn to restore the run strip.
    status: () => Promise<GitSessionSnapshot | null>;
  };
  agent: {
    // Rejects with an AgentTurnFailure when a turn ran and then failed, and with
    // an Error when it failed before any turn started.
    send: (prompt: string) => Promise<AgentChatResult>;
    onStatus: (listener: (status: AgentRuntimeStatus) => void) => () => void;
    // The turn currently running in the main process, or null. Lets the renderer
    // restore the in-progress run strip after the popover view is remounted (e.g.
    // returning from Settings) instead of losing it or showing a premature prompt.
    getActiveTurn: () => Promise<AgentActiveTurn | null>;
    // Asks the running turn to stop; its send() then resolves with `cancelled`.
    cancel: () => Promise<AgentActionResult>;
    // Drops the agent's conversation so the next send starts fresh. Refused while
    // a turn runs or a Keep/Undo change is pending.
    newConversation: () => Promise<AgentActionResult>;
  };
  capabilities: {
    list: () => Promise<MenuSproutCapabilityDescriptor[]>;
    invoke: <T = unknown>(extensionId: string, action: string, input?: unknown) => Promise<T>;
  };
  // Direct access to the shared local SQLite store. Queries run synchronously in the
  // main process, so keep renderer-side queries small and indexed; push heavy work
  // into a background task that writes results back to a table.
  db: {
    query: <T = Record<string, unknown>>(sql: string, params?: SqlParams) => Promise<T[]>;
    get: <T = Record<string, unknown>>(sql: string, params?: SqlParams) => Promise<T | undefined>;
    run: (sql: string, params?: SqlParams) => Promise<SqlRunResult>;
    exec: (sql: string) => Promise<void>;
  };
  widgets: {
    list: () => Promise<MenuSproutWidgetModuleDescriptor[]>;
  };
  // Host-only: the agent-authored root layout module, or null when the workspace
  // has no `layout.tsx` (the renderer then uses the built-in column). Not part of
  // MenuSproutExtensionApi - extensions author the layout, they do not load it.
  layout: {
    get: () => Promise<MenuSproutLayoutModuleDescriptor | null>;
  };
  background: {
    // Fires when an extension's background task finishes a run, so an open widget
    // can re-read its data. Nothing arrives while the task runs with the popover
    // closed - the widget just reads warm data the next time it opens.
    onUpdate: (listener: (event: BackgroundTaskUpdate) => void) => () => void;
  };
  popover: {
    setContentHeight: (height: number) => Promise<{ ok: boolean }>;
    // Reports the desired popover size so both width and height adapt to the
    // layout content. The main process clamps to a usable range and the screen
    // work area, then repositions. `setContentHeight` is retained for older
    // callers; new code should use this.
    setContentSize: (size: { width: number; height: number }) => Promise<{ ok: boolean }>;
    getVisibility: () => Promise<PopoverVisibilityState>;
    onVisibility: (listener: (state: PopoverVisibilityState) => void) => () => void;
  };
  settings: {
    get: () => Promise<MenuSproutSettings>;
    setOpenAtLogin: (openAtLogin: boolean) => Promise<MenuSproutSettings>;
    setTheme: (theme: string) => Promise<MenuSproutSettings>;
    /** Sets light, dark, or system appearance; an unknown value falls back to system. */
    setAppearance: (appearance: "light" | "dark" | "system") => Promise<MenuSproutSettings>;
    /** Saves the privacy switch; the saved choice takes precedence over MENU_SPROUT_TELEMETRY. */
    setTelemetryEnabled: (enabled: boolean) => Promise<MenuSproutSettings>;
    /** Switches the embedded agent; callers should confirm because this resets the current conversation. */
    setAgent: (agentName: string) => Promise<MenuSproutSettings>;
    /** Adds a custom ACP agent. Rejects with an Error(message) on invalid input. */
    addAgent: (input: MenuSproutCustomAgentInput) => Promise<MenuSproutSettings>;
    /** Updates an existing custom agent's label/command (the name/id is immutable). */
    updateAgent: (name: string, input: { label?: string; command: string }) => Promise<MenuSproutSettings>;
    /** Removes a custom agent. Rejects if the agent is currently active. */
    removeAgent: (name: string) => Promise<MenuSproutSettings>;
    /**
     * Saves a built-in agent's model and effort; an empty string means CLI default.
     * Rejects with an Error(message) for a value the CLI would not get.
     */
    setAgentModel: (agentName: string, input: { model?: string; effort?: string }) => Promise<MenuSproutSettings>;
    /** Saves the per-turn limits; null turns a limit off. Rejects with an Error(message) when out of range. */
    setTurnLimits: (limits: { maxTurnMinutes?: number | null; maxToolCalls?: number | null }) => Promise<MenuSproutSettings>;
  };
  app: {
    /** Fully quits the Electron app from the popover shell. */
    quit: () => Promise<{ ok: boolean }>;
    /** Current update status from the host's cached background release check. */
    getUpdateStatus: () => Promise<UpdateStatus>;
    /** Opens the latest release page in the user's default browser. */
    openReleasePage: () => Promise<{ ok: boolean }>;
  };
};

// The slice of the window.menuSprout bridge that extension widgets are meant to
// use: invoking server actions, reading the shared store, reacting to background
// runs, and the popover visibility signal. Host-only surfaces (git, agent,
// settings, app, recipes, widgets) are deliberately excluded. This is the value
// side of the `@menusprout/contracts` public surface; see extensions/menusprout-env.d.ts.
//
// Written out explicitly (not Pick<MenuSproutApi, ...>) so the codegen in
// scripts/generate-extension-dts.mjs can copy it verbatim into the shipped
// declaration file. A type test in tests/extension-contract-surface.test.ts
// asserts it stays structurally equal to the matching MenuSproutApi members, so
// the explicit copy and MenuSproutApi cannot silently drift apart.
export type MenuSproutExtensionApi = {
  capabilities: {
    list: () => Promise<MenuSproutCapabilityDescriptor[]>;
    invoke: <T = unknown>(extensionId: string, action: string, input?: unknown) => Promise<T>;
  };
  db: {
    query: <T = Record<string, unknown>>(sql: string, params?: SqlParams) => Promise<T[]>;
    get: <T = Record<string, unknown>>(sql: string, params?: SqlParams) => Promise<T | undefined>;
    run: (sql: string, params?: SqlParams) => Promise<SqlRunResult>;
    exec: (sql: string) => Promise<void>;
  };
  background: {
    onUpdate: (listener: (event: BackgroundTaskUpdate) => void) => () => void;
  };
  popover: {
    setContentHeight: (height: number) => Promise<{ ok: boolean }>;
    setContentSize: (size: { width: number; height: number }) => Promise<{ ok: boolean }>;
    getVisibility: () => Promise<PopoverVisibilityState>;
    onVisibility: (listener: (state: PopoverVisibilityState) => void) => () => void;
  };
};

declare global {
  interface Window {
    menuSprout?: MenuSproutApi;
    __MENU_SPROUT_WIDGET_HOST__?: {
      React: unknown;
      jsxRuntime: unknown;
      ui: unknown;
    };
  }
}
