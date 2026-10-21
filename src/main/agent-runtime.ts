import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
  type AcpRuntimeEvent,
  type AcpRuntimeHandle,
  type AcpRuntimeTurn,
  type AcpxRuntime,
} from "acpx/runtime";
import type {
  AgentActionResult,
  AgentActiveTurn,
  AgentChatResult,
  AgentTurnMetrics,
  GitActionResult,
  GitSessionSnapshot,
  WorkspaceChange,
} from "../shared/contracts";
import { agentOptionsProblem, type AgentModelOptionsMap, type AgentTurnLimits } from "../shared/agent-options";
import type { AgentRuntimeStatus } from "../shared/contracts";
import { BUILT_IN_AGENT_NAMES, type AgentDefinition, resolveAgentCatalog } from "./agent-catalog";
import { getAgentStateDir, getDevExtensionSnapshotDir, getExtensionsDir } from "../shared/paths";
import { AgentTurnLogRecorder } from "./agent-turn-log";
import { AgentTurnMeter, recordFailedTurnMetrics } from "./agent-turn-metrics";
import { DevExtensionChangeSession } from "./dev-extension-change-session";
import { GitChangeSession } from "./git-change-session";
import type { TelemetryClient } from "./telemetry";
import type { WidgetCaptureEndpoint } from "./widget-capture";

export type MenuSproutAgentRuntimeOptions = {
  agentName?: string;
  /** Where the agent can capture its rendered widget; see widget-capture-server. */
  capture?: WidgetCaptureEndpoint;
  registryOverrides?: Record<string, string>;
  requestTimeoutMs?: number;
  paths?: MenuSproutAgentRuntimePaths;
  telemetry?: TelemetryClient;
  /**
   * Settles once a GUI launch's PATH is fully expanded. Turns wait for it, and a
   * default (not chosen) agent is re-detected against the expanded PATH.
   */
  shellPathReady?: Promise<void>;
  /** Saved model and effort choices; a turn is refused while the active agent's are invalid. */
  agentOptions?: AgentModelOptionsMap;
  /** Optional per-turn limits; each stops the turn through the Cancel path. */
  turnLimits?: AgentTurnLimits;
};

export type MenuSproutAgentRuntimePaths = {
  extensionsDir: string;
  agentStateDir: string;
  snapshotDir: string;
  isPackaged?: boolean;
};

export type MenuSproutAgentRuntimeSendOptions = {
  onStatus?: (status: AgentRuntimeStatus) => void | Promise<void>;
};

type ResolveDefaultAgentNameOptions = {
  env?: Partial<Pick<NodeJS.ProcessEnv, "MENU_SPROUT_AGENT" | "PATH">>;
  commandExists?: (command: string) => boolean;
  allowFallbackWhenMissing?: boolean;
  catalog?: readonly AgentDefinition[];
};

const DEFAULT_AGENT_TIMEOUT_MS = 300_000;

// One persistent conversation per app, keyed for the file session store. The
// persisted record outlives the app process, so a fresh launch tries to resume
// it - see SESSION_KEY use below and the resume-recovery path in runSend.
const SESSION_KEY = "menu-sprout-agent-chat";

// acpx flags a failed turn with this detailCode when a persisted session cannot
// be resumed because the agent reports loadSession:false. The bundled adapters
// mint a fresh session per process and never support session/load, so every
// launch with a leftover persisted record hits this until we drop the record.
const SESSION_RESUME_REQUIRED_DETAIL_CODE = "SESSION_RESUME_REQUIRED";

// Bounds the final reply sent to the renderer; the popover shows it collapsed.
const REPLY_MAX_CHARS = 4_000;

// How long Cancel and the idle timeout let an agent end its turn (or finish
// starting its session) before its process is forced down, and how long the
// turn then gets to settle after that forced stop.
export const AGENT_STOP_GRACE_MS = 5_000;

type AgentProcessClient = {
  close(): Promise<void>;
  prompt(...args: unknown[]): Promise<unknown>;
};

// Every acpx client (one agent process each) a runtime has created; see
// trackAgentClients.
const agentClients = new WeakMap<AcpxRuntime, Set<AgentProcessClient>>();

function telemetryAgentName(agentName: string): string {
  return BUILT_IN_AGENT_NAMES.has(agentName) ? agentName : "custom";
}

type AgentChangeSession = {
  readonly startedClean: boolean;
  readonly canSave: boolean;
  readonly canRollback: boolean;
  snapshot(message?: string): GitSessionSnapshot;
  describeChanges(): Promise<WorkspaceChange[]>;
  hasChanges(): Promise<boolean>;
  save(message?: string): Promise<GitActionResult>;
  rollback(): Promise<GitActionResult>;
};

// Builds the renderer-facing snapshot and attaches the diff-derived change
// classification plus dirty flag, so the Keep/Rollback bar can label what
// actually changed instead of guessing from the agent's prose. Inspection
// failures degrade to an unannotated snapshot rather than breaking the turn.
async function enrichSnapshot(session: AgentChangeSession, message: string): Promise<GitSessionSnapshot> {
  const snapshot = session.snapshot(message);
  try {
    const [changes, dirty] = await Promise.all([session.describeChanges(), session.hasChanges()]);
    snapshot.changes = changes;
    snapshot.dirty = dirty;
  } catch {
    // Leave changes/dirty undefined; the renderer falls back to a generic label.
  }
  return snapshot;
}

export class AgentTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly phase: string,
  ) {
    super(`Agent request timed out after ${timeoutMs}ms while ${phase}.`);
    this.name = "AgentTimeoutError";
  }
}

// Carries the acpx turn-result error so callers can branch on the structured
// detailCode (for example to recover from SESSION_RESUME_REQUIRED) instead of
// string-matching a flattened message.
export class AgentTurnFailedError extends Error {
  readonly code?: string;
  readonly detailCode?: string;
  readonly retryable?: boolean;

  constructor(error: { message?: string; code?: string; detailCode?: string; retryable?: boolean }) {
    super(error.message || "Agent turn failed");
    this.name = "AgentTurnFailedError";
    this.code = error.code;
    this.detailCode = error.detailCode;
    this.retryable = error.retryable;
  }
}

export class AgentTurnCancelledError extends Error {
  constructor() {
    super("Agent turn was cancelled");
    this.name = "AgentTurnCancelledError";
  }
}

function isSessionResumeRequiredError(error: unknown): boolean {
  return error instanceof AgentTurnFailedError && error.detailCode === SESSION_RESUME_REQUIRED_DETAIL_CODE;
}

function turnFailureDetail(error: unknown): { message: string; code?: string; detailCode?: string } {
  if (error instanceof AgentTurnFailedError) {
    return { message: error.message, code: error.code, detailCode: error.detailCode };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

export function commandExists(command: string): boolean {
  const lookupCommand = process.platform === "win32" ? "where" : "sh";
  const lookupArgs = process.platform === "win32" ? [command] : ["-c", "command -v \"$1\"", "sh", command];
  return spawnSync(lookupCommand, lookupArgs, { stdio: "ignore" }).status === 0;
}

export function resolveDefaultAgentName(options: ResolveDefaultAgentNameOptions = {}): string | null {
  const configuredAgent = options.env?.MENU_SPROUT_AGENT ?? process.env.MENU_SPROUT_AGENT;
  if (configuredAgent?.trim()) return configuredAgent.trim();

  const catalog = options.catalog ?? resolveAgentCatalog();
  if (catalog.length === 0) return null;
  const hasCommand = options.commandExists ?? commandExists;
  const detected = catalog.find((agent) => (agent.launchCommand ? true : hasCommand(agent.command)))?.name;
  if (detected) return detected;
  return options.allowFallbackWhenMissing === false ? null : catalog[0].name;
}

export function resolveAgentTimeoutMs(env: Partial<Pick<NodeJS.ProcessEnv, "MENU_SPROUT_AGENT_TIMEOUT_MS">> = process.env) {
  const parsed = Number(env.MENU_SPROUT_AGENT_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AGENT_TIMEOUT_MS;
}

export function getAgentRuntimeCwd(
  rootDir: string,
  env: Partial<Pick<NodeJS.ProcessEnv, "MENU_SPROUT_EXTENSIONS_DIR">> = process.env,
  paths?: Pick<MenuSproutAgentRuntimePaths, "extensionsDir">,
): string {
  if (paths) return paths.extensionsDir;
  return getExtensionsDir(rootDir, env);
}

export function selectAgentChangeSessionKind({
  isPackaged,
  rootDir,
  extensionsDir,
}: {
  isPackaged?: boolean;
  rootDir: string;
  extensionsDir: string;
}): "git" | "snapshot" {
  if (isPackaged) return "snapshot";
  return resolve(extensionsDir) === resolve(join(rootDir, "extensions")) ? "git" : "snapshot";
}

export function withAgentTimeout<T>(
  operation: Promise<T>,
  options: { timeoutMs: number; phase: string; onTimeout?: () => void },
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      options.onTimeout?.();
      reject(new AgentTimeoutError(options.timeoutMs, options.phase));
    }, options.timeoutMs);
    timeout.unref?.();
  });

  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

export function collectAgentTurnOutput(
  turn: AcpRuntimeTurn,
  options: {
    idleTimeoutMs: number;
    onEvent?: (event: AcpRuntimeEvent) => void | Promise<void>;
    onStatus?: (status: AgentRuntimeStatus) => void | Promise<void>;
    cancelSignal?: AbortSignal;
    forceStop?: () => Promise<void>;
  },
): Promise<string> {
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let stopError: Error | null = null;
  let markStopRequested!: () => void;
  const stopRequested = new Promise<void>((resolve) => {
    markStopRequested = resolve;
  });
  let assistantOutput = "";
  let publishedStatusText: string | null = null;

  const clearIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };

  // Cancel and the idle timeout both ask the agent to stop; the first request
  // decides how the turn ends, whatever the agent reports afterwards.
  const requestStop = (reason: "timeout" | "user-cancel", error: Error) => {
    clearIdleTimer();
    if (stopError) return;
    stopError = error;
    void turn.cancel({ reason }).catch(() => undefined);
    markStopRequested();
  };

  const refreshIdleTimer = () => {
    clearIdleTimer();
    if (stopError) return;
    idleTimer = setTimeout(() => {
      requestStop("timeout", new AgentTimeoutError(options.idleTimeoutMs, "waiting for agent activity"));
    }, options.idleTimeoutMs);
    idleTimer.unref?.();
  };

  const onCancel = () => {
    requestStop("user-cancel", new AgentTurnCancelledError());
  };
  if (options.cancelSignal?.aborted) onCancel();
  else options.cancelSignal?.addEventListener("abort", onCancel, { once: true });

  const collectOutput = (async () => {
    let output = "";
    refreshIdleTimer();

    for await (const event of turn.events) {
      refreshIdleTimer();
      await Promise.resolve(options.onEvent?.(event)).catch(() => undefined);
      const outputText = outputTextForEvent(event);
      output += outputText;

      if (outputText) {
        assistantOutput += outputText;
        const statusText = latestCompleteAssistantStatusText(assistantOutput);
        if (statusText && statusText !== publishedStatusText) {
          publishedStatusText = statusText;
          await Promise.resolve(options.onStatus?.({ text: statusText, eventType: "text_delta" })).catch(() => undefined);
        }
      }
    }

    const result = await turn.result;
    if (result.status === "failed") {
      throw new AgentTurnFailedError(result.error);
    }
    if (result.status === "cancelled") {
      throw new AgentTurnCancelledError();
    }
    // ACP refusal is a normal protocol stop reason, so acpx reports it as a
    // completed turn. For Menu Sprout's editing contract it is still a failure.
    // Never use streamed provider text as the error because it may contain
    // credential-bearing diagnostics or raw upstream payload details.
    if (result.stopReason === "refusal") {
      throw new AgentTurnFailedError({
        message: "Agent refused the request.",
        code: "AGENT_REFUSED",
        detailCode: "ACP_REFUSAL",
        retryable: false,
      });
    }
    return output;
  })();
  void collectOutput.catch(() => undefined);

  const settled = collectOutput.then(
    (output) => {
      if (stopError) throw stopError;
      return output;
    },
    (error: unknown) => {
      throw stopError ?? error;
    },
  );
  const stopped = stopRequested.then(async () => {
    await settleOrForceStop(collectOutput, options.forceStop);
    throw stopError;
  });

  return Promise.race([settled, stopped])
    .finally(() => {
      clearIdleTimer();
      options.cancelSignal?.removeEventListener("abort", onCancel);
    });
}

// Keeps only the agent's final message: the output text after its last tool
// call. Earlier narration ("Let me read the file...") is dropped because the
// popover shows the latest reply, never a transcript.
export class AgentFinalReply {
  private text = "";

  record(event: AcpRuntimeEvent): void {
    if (event.type === "tool_call") {
      this.text = "";
      return;
    }
    const outputText = outputTextForEvent(event);
    if (!outputText) return;
    this.text += outputText;
  }

  get value(): string | undefined {
    const reply = this.text.trim();
    if (!reply) return undefined;
    return reply.length > REPLY_MAX_CHARS ? `${reply.slice(0, REPLY_MAX_CHARS - 3)}...` : reply;
  }
}

export function agentRuntimeStatusForEvent(event: AcpRuntimeEvent): AgentRuntimeStatus | null {
  if (event.type !== "text_delta" || event.stream !== "output") return null;
  return statusFromText(event.text, event.type);
}

function statusFromText(text: string | undefined, eventType: AgentRuntimeStatus["eventType"]): AgentRuntimeStatus | null {
  const normalized = text?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return {
    text: normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized,
    eventType,
  };
}

export function latestCompleteAssistantStatusText(output: string): string | null {
  const normalized = output.replace(/\r\n/g, "\n");
  const inline = normalized.replace(/\s+/g, " ").trim();
  const completeSentences = [...inline.matchAll(/[^.!?]+[.!?](?=\s|$)/g)].map((match) => match[0].trim());
  const latestSentence = completeSentences.at(-1);
  if (latestSentence) return truncateStatusText(latestSentence);

  const lines = normalized.split("\n");
  if (!normalized.endsWith("\n")) lines.pop();
  const latestLine = lines
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .at(-1);
  return latestLine ? truncateStatusText(latestLine) : null;
}

function truncateStatusText(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function outputTextForEvent(event: AcpRuntimeEvent): string {
  if (event.type === "text_delta" && (event.stream ?? "output") === "output") {
    return event.text ?? "";
  }
  return "";
}

export type MenuSproutAgentPromptOptions = {
  capture?: WidgetCaptureEndpoint;
};

// The visual self-check is plain shell + a PNG on disk so every built-in agent
// (Claude Code, Codex, Antigravity) can use it with no agent-specific path.
function buildVisualSelfCheckInstructions(capture: WidgetCaptureEndpoint): string {
  return `
Before reporting the work done, also look at the finished widget as it actually renders, not only at its data. Run this command (replace <widget-id> with the id declared in your widget.tsx; it captures only that widget):
curl -sS -H "Authorization: Bearer ${capture.token}" "${capture.url}/capture?widget=<widget-id>"
It renders the real widget in a fresh hidden popover and answers with JSON whose path field is a PNG file on disk; open that PNG file with your image-viewing or file-reading tool and actually look at it. Check the layout, clipping or overflow at the edges, any empty or error state, and that the expected value is visible and correct; a blank or error screen means the widget is not done.
If anything looks wrong, fix the widget and capture again until it looks right. Captures are saved outside your extension workspace on purpose so they never appear as changes; opening that returned PNG is the one read outside the workspace this allows. Capturing is the only thing this endpoint does.`;
}

export function buildMenuSproutAgentPrompt(prompt: string, options: MenuSproutAgentPromptOptions = {}): string {
  return `${prompt}

You are editing the menu-sprout repository in dev mode.
Prefer small, focused changes in your current extension workspace.
Build self-contained extensions under <extension-id>/ inside your current extension workspace so they can be shared as a directory behind the stable window.menuSprout bridge.
For recipe-backed widgets, read the matching self-contained spec from recipes/ before editing.
Do not modify files outside your current extension workspace unless the user explicitly asks.
Renderer widgets should call privileged work with window.menuSprout.capabilities.invoke(extensionId, action, input).
Extension server actions live in server.ts files and export an actions object.
Do not add new preload methods or one-off IPC method names for each widget.
Put privileged filesystem, shell, network, credential, and token work behind an extension-owned server action that is invoked through a stable generic capability bridge.
Do not write test files, and do not write README or other documentation files for extensions.
When a widget or server action surfaces live or system data - local files, command output, credentials, or an API response - inspect that actual source directly (read the real file, run the real command, call the real endpoint) to confirm its true current shape before writing any parsing or rendering code; never guess or pattern-complete a field name or response shape from memory or documentation.
Treat live-source verification as a targeted, read-only check against a specific known source already named by the recipe or server code - a known credential file, known command, or known endpoint - not permission to run broad or recursive searches outside the extension workspace.
If inspecting a source that can contain secrets, print only non-secret metadata or explicitly redacted placeholders; never echo raw tokens, credential blobs, cookies, auth headers, or secret-bearing payloads to stdout, the agent transcript, logs, or the widget UI.
Before reporting the work done, verify the finished widget against that same live data yourself: run the server action (or an equivalent one-off check) against the real source and confirm the exact value you expect actually renders - reasoning about the return shape on paper is not enough.${options.capture ? buildVisualSelfCheckInstructions(options.capture) : ""}`;
}

export class MenuSproutAgentRuntime {
  private runtime: AcpxRuntime | null = null;
  private handle: AcpRuntimeHandle | null = null;
  private activeSession: AgentChangeSession | null = null;
  private activeTurn = false;
  private lifecycle: Promise<void> = Promise.resolve();
  private activeTurnInfo: AgentActiveTurn | null = null;
  private turnCancel: AbortController | null = null;
  private turnMeter: AgentTurnMeter | null = null;
  private agentOptions: AgentModelOptionsMap | undefined;
  private turnLimits: AgentTurnLimits;
  private agentName: string;
  private agentNameChosen: boolean;
  private readonly shellPathReady: Promise<void> | undefined;
  private registryOverrides: Record<string, string> | undefined;
  private registryOverridesStale = false;
  private readonly requestTimeoutMs: number;
  private readonly paths: MenuSproutAgentRuntimePaths | undefined;
  private readonly telemetry: TelemetryClient | undefined;
  private readonly capture: WidgetCaptureEndpoint | undefined;

  constructor(
    private readonly rootDir: string,
    options: string | MenuSproutAgentRuntimeOptions = {},
  ) {
    const chosenAgent = typeof options === "string" ? options : options.agentName;
    const detectAgent = () => resolveDefaultAgentName() ?? resolveAgentCatalog()[0].name;
    this.agentName = chosenAgent ?? detectAgent();
    this.agentNameChosen = chosenAgent !== undefined;
    this.shellPathReady =
      typeof options === "string"
        ? undefined
        : options.shellPathReady?.then(() => {
            if (!this.agentNameChosen) this.agentName = detectAgent();
          });
    this.registryOverrides = typeof options === "string" ? undefined : options.registryOverrides;
    this.requestTimeoutMs = typeof options === "string" ? resolveAgentTimeoutMs() : options.requestTimeoutMs ?? resolveAgentTimeoutMs();
    this.paths = typeof options === "string" ? undefined : options.paths;
    this.telemetry = typeof options === "string" ? undefined : options.telemetry;
    this.capture = typeof options === "string" ? undefined : options.capture;
    this.agentOptions = typeof options === "string" ? undefined : options.agentOptions;
    this.turnLimits = typeof options === "string" ? {} : options.turnLimits ?? {};
  }

  /** Replaces the saved model and effort choices checked before each turn. */
  setAgentOptions(options: AgentModelOptionsMap | undefined): void {
    this.agentOptions = options;
  }

  /** Replaces the per-turn limits; they apply from the next turn. */
  setTurnLimits(limits: AgentTurnLimits | undefined): void {
    this.turnLimits = limits ?? {};
  }

  get session(): AgentChangeSession | null {
    return this.activeSession;
  }

  /**
   * Snapshot of the outstanding change session for the renderer to re-hydrate a
   * pending Keep/Rollback prompt after a reload. Returns null when no session is
   * open OR a turn is still running. The change session is created at the start of
   * a turn (so it is "saveable" the whole time the build runs); returning null
   * mid-turn keeps the renderer from showing a Keep/Rollback prompt before the
   * build has actually finished. Use currentTurn() to restore the run strip then.
   */
  async currentSessionSnapshot(): Promise<GitSessionSnapshot | null> {
    if (this.activeTurn) return null;
    return this.withLifecycle(async () => {
      if (this.activeTurn || !this.activeSession) return null;
      if (!this.activeSession.canSave && !this.activeSession.canRollback) return null;
      return this.enrichActiveSessionSnapshot(this.activeSession, "Review the generated changes, then Save or Rollback.");
    });
  }

  /**
   * The turn currently running in the main process, or null. Lets the renderer
   * restore the in-progress run strip after the popover view is remounted (e.g.
   * returning from Settings) instead of losing it or surfacing a premature prompt.
   */
  currentTurn(): AgentActiveTurn | null {
    return this.activeTurnInfo;
  }

  get currentAgent(): string {
    return this.agentName;
  }

  /**
   * Replaces the acpx registry overrides used to launch agents.
   */
  async setRegistryOverrides(overrides: Record<string, string> | undefined): Promise<void> {
    const previousCommand = this.registryOverrides?.[this.agentName];
    this.registryOverrides = overrides && Object.keys(overrides).length > 0 ? overrides : undefined;
    // Only a change to the active agent's launch command needs a new agent
    // process; other agents pick up their overrides when switched to.
    if (this.registryOverrides?.[this.agentName] === previousCommand) return;
    if (this.agentSwitchDisabledReason) {
      this.registryOverridesStale = true;
      return;
    }
    await this.withLifecycle(() => this.closeRuntime("registry-overrides-change", undefined, true));
  }

  get agentSwitchDisabledReason(): string | undefined {
    if (this.activeTurn) return "Agent is running. Wait for it to finish before switching agents.";
    if (this.activeSession?.canSave || this.activeSession?.canRollback) {
      return "Save or Rollback the current agent changes before switching agents.";
    }
    return undefined;
  }

  /**
   * Switches the embedded agent and resets the live conversation. Closing the
   * runtime with discardPersistentState drops the persisted "menu-sprout-agent-chat"
   * session so the next send() starts the new agent with a fresh conversation.
   */
  async setAgent(name: string): Promise<void> {
    const next = name.trim();
    if (!next) return;
    if (next === this.agentName) {
      this.agentNameChosen = true;
      return;
    }

    const disabledReason = this.agentSwitchDisabledReason;
    if (disabledReason) throw new Error(disabledReason);

    await this.withLifecycle(async () => {
      if (this.activeSession?.canSave || this.activeSession?.canRollback) {
        throw new Error("Save or Rollback the current agent changes before switching agents.");
      }
      await this.closeRuntime("agent-switch", true, true);
      this.activeSession = null;
      this.agentName = next;
      this.agentNameChosen = true;
      this.telemetry?.track("agent_switch", { agent: telemetryAgentName(next) });
    });
  }

  async send(prompt: string, options: MenuSproutAgentRuntimeSendOptions = {}): Promise<AgentChatResult> {
    if (this.activeTurn) {
      return {
        assistantText: "An agent turn is already running. Wait for it to finish before asking again.",
      };
    }

    // A saved model or effort the CLI would not get blocks the turn instead of
    // silently running at the CLI default.
    const optionsProblem = agentOptionsProblem(this.agentName, this.agentOptions);
    if (optionsProblem) throw new Error(optionsProblem);

    const startedAt = Date.now();
    const turnCancel = new AbortController();
    this.activeTurn = true;
    this.activeTurnInfo = { title: prompt.trim(), startedAt };
    this.turnCancel = turnCancel;
    // A limit stops the turn exactly like Cancel, so it shares that bounded stop.
    this.turnMeter = new AgentTurnMeter(startedAt, this.turnLimits, () => turnCancel.abort());

    try {
      return await this.withLifecycle(() => this.runSend(prompt, options));
    } finally {
      this.turnMeter.dispose();
      this.activeTurn = false;
      this.activeTurnInfo = null;
      this.turnCancel = null;
      this.turnMeter = null;
    }
  }

  /**
   * Asks the running turn to stop, forcing the agent process down if the turn
   * has not ended within AGENT_STOP_GRACE_MS. send() then resolves with
   * `cancelled: true`, and any partial changes stay in the change session for
   * Keep or Undo, exactly like a failed turn.
   */
  cancel(): AgentActionResult {
    if (!this.activeTurn || !this.turnCancel) return { ok: false, reason: "No agent turn is running." };
    // The user's Cancel decides how the turn ends, even if a limit is hit while it stops.
    this.turnMeter?.dispose();
    this.turnCancel.abort();
    return { ok: true };
  }

  /**
   * Drops the persisted conversation so the next send() starts a fresh one.
   * Refused while a turn runs or a change can still be kept or undone, the same
   * rule that blocks a new turn.
   */
  async newConversation(): Promise<AgentActionResult> {
    if (this.activeTurn) {
      return { ok: false, reason: "Agent is running. Cancel it or wait for it to finish first." };
    }
    return this.withLifecycle(async () => {
      if (this.activeSession?.canSave || this.activeSession?.canRollback) {
        return { ok: false, reason: "Keep or Undo the current change before starting a new conversation." };
      }
      try {
        await this.discardPersistedSession("new-conversation");
      } catch {
        return { ok: false, reason: "Could not reset the saved agent conversation." };
      }
      return { ok: true };
    });
  }

  private async runSend(prompt: string, options: MenuSproutAgentRuntimeSendOptions = {}): Promise<AgentChatResult> {
    await this.shellPathReady;
    const agentCwd = await this.ensureAgentRuntimeCwd();
    const changeSession = await this.beginChangeSession(agentCwd);
    this.activeSession = changeSession;
    const telemetryAgent = telemetryAgentName(this.agentName);

    if (!changeSession.startedClean) {
      this.telemetry?.track("agent_turn", { agent: telemetryAgent, status: "blocked_dirty" });
      return {
        assistantText:
          "I cannot start an editing session because the git working tree is already dirty. Commit or stash those changes first so Save and Rollback can stay safe.",
        session: changeSession.snapshot("Working tree was dirty before the agent started."),
      };
    }

    try {
      return await this.runTurnAttempt(prompt, options, agentCwd, changeSession, telemetryAgent);
    } catch (error) {
      // A persisted session that the bundled (loadSession:false) adapter cannot
      // resume after a restart fails the FIRST turn with SESSION_RESUME_REQUIRED.
      // Drop the stale record and start a fresh session once so the agent does
      // not look permanently "unavailable" until the cache is cleared by hand.
      if (isSessionResumeRequiredError(error)) {
        try {
          await this.discardPersistedSession("session-resume-required");
          return await this.runTurnAttempt(prompt, options, agentCwd, changeSession, telemetryAgent);
        } catch (retryError) {
          await this.closeCleanFailedSession(changeSession);
          throw this.reportTurnError(retryError, telemetryAgent);
        }
      }
      await this.closeCleanFailedSession(changeSession);
      throw this.reportTurnError(error, telemetryAgent);
    }
  }

  private async runTurnAttempt(
    prompt: string,
    options: MenuSproutAgentRuntimeSendOptions,
    agentCwd: string,
    changeSession: AgentChangeSession,
    telemetryAgent: string,
  ): Promise<AgentChatResult> {
    let runtime: AcpxRuntime | null = null;
    let handle: AcpRuntimeHandle | null = null;
    let sessionStartup: Promise<AcpRuntimeHandle> | null = null;
    let turn: AcpRuntimeTurn | null = null;
    let turnLog: AgentTurnLogRecorder | null = null;
    const requestId = randomUUID();
    const cancelSignal = this.turnCancel?.signal;
    const finalReply = new AgentFinalReply();

    try {
      turnLog = await AgentTurnLogRecorder.start({
        rootDir: this.rootDir,
        agentName: this.agentName,
        requestId,
        prompt,
      });
      throwIfCancelled(cancelSignal);
      runtime = await this.ensureRuntime(agentCwd);
      sessionStartup = runtime.ensureSession({
        sessionKey: SESSION_KEY,
        agent: this.agentName,
        mode: "persistent",
        cwd: agentCwd,
      });
      handle = await withAgentTimeout(untilCancelled(sessionStartup, cancelSignal), {
        timeoutMs: this.requestTimeoutMs,
        phase: "starting agent session",
      });
      this.handle = handle;
      throwIfCancelled(cancelSignal);

      turn = runtime.startTurn({
        handle,
        text: this.buildPrompt(prompt),
        mode: "prompt",
        requestId,
        timeoutMs: 0,
      });

      const output = await this.collectTurnOutput(turn, turnLog, options, finalReply, cancelSignal, runtime);
      await turnLog.finish("completed").catch(() => undefined);

      this.telemetry?.track("agent_turn", { agent: telemetryAgent, status: "success" });
      const reply = finalReply.value;
      return {
        assistantText: output.trim() || "Agent finished without a text response.",
        ...(reply ? { reply } : {}),
        session: await this.enrichActiveSessionSnapshot(
          changeSession,
          "Review the generated repo changes, then Save or Rollback.",
        ),
        ...this.turnMetrics(),
      };
    } catch (error) {
      if (
        runtime &&
        (error instanceof AgentTimeoutError || (error instanceof AgentTurnCancelledError && !turn))
      ) {
        const stoppedRuntime = runtime;
        const reason = error instanceof AgentTimeoutError ? "timeout" : "cancel";
        if (this.runtime === runtime) {
          this.runtime = null;
          this.handle = null;
        }
        if (handle) {
          await stoppedRuntime.close({ handle, reason }).catch(() => undefined);
        } else if (
          sessionStartup &&
          (await settleOrForceStop(sessionStartup, () => this.stopAgentProcesses(stoppedRuntime)))
        ) {
          await sessionStartup
            .then((lateHandle) => stoppedRuntime.close({ handle: lateHandle, reason }))
            .catch(() => undefined);
        }
      }
      const stoppedBy = this.turnMeter?.stoppedBy;
      if (error instanceof AgentTurnCancelledError && stoppedBy) {
        await turnLog?.finish("limit_stopped").catch(() => undefined);
        this.telemetry?.track("agent_turn", { agent: telemetryAgent, status: "limit_stopped" });
        const limit = stoppedBy === "time-limit" ? "time limit" : "tool-call limit";
        return {
          assistantText: `The agent turn was stopped at its ${limit}.`,
          stoppedBy,
          session: await this.enrichActiveSessionSnapshot(
            changeSession,
            `Agent turn stopped at its ${limit}. Review any partial repo changes, then Save or Rollback.`,
          ),
          ...this.turnMetrics(),
        };
      }
      if (error instanceof AgentTurnCancelledError) {
        await turnLog?.finish("cancelled").catch(() => undefined);
        this.telemetry?.track("agent_turn", { agent: telemetryAgent, status: "cancelled" });
        // Partial changes stay reviewable; a clean session closes, as after a failure.
        return {
          assistantText: "The agent turn was cancelled.",
          cancelled: true,
          session: await this.enrichActiveSessionSnapshot(
            changeSession,
            "Agent turn was cancelled. Review any partial repo changes, then Save or Rollback.",
          ),
          ...this.turnMetrics(),
        };
      }
      if (!(error instanceof AgentTimeoutError)) {
        await turnLog?.finishFailed(turnFailureDetail(error)).catch(() => undefined);
        if (error instanceof AgentTurnFailedError && error.detailCode === "ACP_REFUSAL") {
          this.telemetry?.track("agent_turn", { agent: telemetryAgent, status: "error" });
          const reply = finalReply.value;
          return {
            assistantText: "Agent refused the request.",
            refused: true,
            ...(reply ? { reply } : {}),
            session: await this.enrichActiveSessionSnapshot(
              changeSession,
              "Agent refused the request. Review any partial repo changes, then Save or Rollback.",
            ),
            ...this.turnMetrics(),
          };
        }
        const { metrics } = this.turnMetrics();
        if (turn && metrics) recordFailedTurnMetrics(error, metrics);
        throw error;
      }
      await turnLog?.recordTimeout(error).catch(() => undefined);
      this.telemetry?.track("agent_turn", { agent: telemetryAgent, status: "timeout" });

      return {
        assistantText: `The ${this.agentName} agent timed out after ${error.timeoutMs}ms while ${error.phase}. It may have made partial repo changes. Review the working tree, then Save or Rollback. You can retry with MENU_SPROUT_AGENT_TIMEOUT_MS set higher if needed.`,
        session: await this.enrichActiveSessionSnapshot(
          changeSession,
          "Agent timed out. Review any partial repo changes, then Save or Rollback.",
        ),
        ...this.turnMetrics(),
      };
    }
  }

  // Measured once the turn has settled, so the duration covers the whole send.
  private turnMetrics(): { metrics?: AgentTurnMetrics } {
    return this.turnMeter ? { metrics: this.turnMeter.snapshot() } : {};
  }

  private async enrichActiveSessionSnapshot(session: AgentChangeSession, message: string): Promise<GitSessionSnapshot> {
    const snapshot = await enrichSnapshot(session, message);
    if (snapshot.dirty === false && this.activeSession === session) {
      await session.save().catch(() => undefined);
      this.activeSession = null;
      await this.refreshRuntimeAfterRegistryChange();
    }
    return snapshot;
  }

  private async closeCleanFailedSession(session: AgentChangeSession): Promise<void> {
    if (this.activeSession !== session) return;
    try {
      if (await session.hasChanges()) return;
    } catch {
      // If inspection fails, preserve the session so a possible partial change
      // remains reviewable instead of being silently discarded.
      return;
    }

    await session.save().catch(() => undefined);
    this.activeSession = null;
    await this.refreshRuntimeAfterRegistryChange();
  }

  private reportTurnError(error: unknown, telemetryAgent: string): unknown {
    this.telemetry?.track("agent_turn", { agent: telemetryAgent, status: "error" });
    return error;
  }

  /**
   * Drops the persisted ACP session so the next turn starts a fresh one. The
   * acpx file session store exposes no delete, and runtime.close's
   * discardPersistentState does NOT remove the on-disk record, so we close the
   * live runtime and delete the persisted session file ourselves.
   */
  private async discardPersistedSession(reason: string): Promise<void> {
    await this.closeRuntime(reason, true, true);
    try {
      await rm(this.persistedSessionFilePath(), { force: true });
    } catch {
      throw new Error("Could not reset the saved agent conversation.");
    }
  }

  private persistedSessionFilePath(): string {
    const stateDir = this.paths?.agentStateDir ?? getAgentStateDir(this.rootDir);
    return join(stateDir, "sessions", `${SESSION_KEY}.json`);
  }

  async save(message?: string) {
    if (this.activeTurn) return { ok: false, reason: "Agent is running. Wait for it to finish first." };
    return this.withLifecycle(async () => {
      if (!this.activeSession) return { ok: false, reason: "No active agent change session" };
      const result = await this.activeSession.save(message);
      if (result.ok) {
        this.activeSession = null;
        await this.refreshRuntimeAfterRegistryChange();
      }
      return result;
    });
  }

  async rollback() {
    if (this.activeTurn) return { ok: false, reason: "Agent is running. Wait for it to finish first." };
    return this.withLifecycle(async () => {
      if (!this.activeSession) return { ok: false, reason: "No active agent change session" };
      const result = await this.activeSession.rollback();
      if (result.ok) {
        this.activeSession = null;
        await this.refreshRuntimeAfterRegistryChange();
      }
      return result;
    });
  }

  async close() {
    await this.withLifecycle(() => this.closeRuntime("menu-sprout-shutdown"));
  }

  private withLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.then(() => undefined, () => undefined);
    return result;
  }

  private async closeRuntime(reason: string, discardPersistentState?: boolean, ignoreCloseError = false): Promise<void> {
    if (!this.runtime || !this.handle) {
      this.runtime = null;
      this.handle = null;
      this.registryOverridesStale = false;
      return;
    }

    const runtime = this.runtime;
    const handle = this.handle;
    this.runtime = null;
    this.handle = null;
    this.registryOverridesStale = false;
    const close = runtime.close({ handle, reason, discardPersistentState });
    if (ignoreCloseError) {
      await close.catch(() => undefined);
      return;
    }
    await close;
  }

  // Stops every agent process this runtime started through acpx's own client
  // shutdown: end stdin, SIGTERM, then SIGKILL.
  // The bundled adapters stop their tool processes on that SIGTERM.
  private async stopAgentProcesses(runtime: AcpxRuntime): Promise<void> {
    if (this.runtime === runtime) {
      this.runtime = null;
      this.handle = null;
    }
    const clients = [...(agentClients.get(runtime) ?? [])];
    await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
  }

  private async refreshRuntimeAfterRegistryChange(): Promise<void> {
    if (!this.registryOverridesStale) return;
    await this.closeRuntime("registry-overrides-change", undefined, true);
  }

  private async ensureAgentRuntimeCwd(): Promise<string> {
    const agentCwd = getAgentRuntimeCwd(this.rootDir, process.env, this.paths);
    await mkdir(agentCwd, { recursive: true });
    return agentCwd;
  }

  private async beginChangeSession(agentCwd: string): Promise<AgentChangeSession> {
    if (selectAgentChangeSessionKind({ isPackaged: this.paths?.isPackaged, rootDir: this.rootDir, extensionsDir: agentCwd }) === "snapshot") {
      return DevExtensionChangeSession.begin(agentCwd, this.paths?.snapshotDir ?? getDevExtensionSnapshotDir(this.rootDir));
    }

    return GitChangeSession.begin(this.rootDir, agentCwd);
  }

  private async ensureRuntime(agentCwd: string): Promise<AcpxRuntime> {
    if (this.runtime) return this.runtime;

    const stateDir = this.paths?.agentStateDir ?? getAgentStateDir(this.rootDir);
    await mkdir(stateDir, { recursive: true });
    const runtime = createAcpRuntime({
      cwd: agentCwd,
      sessionStore: createFileSessionStore({ stateDir }),
      agentRegistry: createAgentRegistry(
        this.registryOverrides ? { overrides: this.registryOverrides } : undefined,
      ),
      permissionMode: "approve-all",
      nonInteractivePermissions: "deny",
      timeoutMs: this.requestTimeoutMs,
    });
    agentClients.set(runtime, await trackAgentClients(runtime, () => this.turnMeter));
    this.runtime = runtime;
    return runtime;
  }

  private collectTurnOutput(
    turn: AcpRuntimeTurn,
    turnLog: AgentTurnLogRecorder,
    options: MenuSproutAgentRuntimeSendOptions,
    finalReply: AgentFinalReply,
    cancelSignal: AbortSignal | undefined,
    runtime: AcpxRuntime,
  ): Promise<string> {
    return collectAgentTurnOutput(turn, {
      idleTimeoutMs: this.requestTimeoutMs,
      onEvent: async (event) => {
        this.turnMeter?.recordEvent(event);
        finalReply.record(event);
        await turnLog.recordEvent(event);
      },
      onStatus: options.onStatus,
      cancelSignal,
      forceStop: () => this.stopAgentProcesses(runtime),
    });
  }

  private buildPrompt(prompt: string): string {
    return buildMenuSproutAgentPrompt(prompt, { capture: this.capture });
  }
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AgentTurnCancelledError();
}

// Stops waiting on a pre-turn step (starting the agent session) once cancel is
// requested; the step itself finishes in the background.
function untilCancelled<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return operation;
  void operation.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AgentTurnCancelledError());
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

// acpx exposes no way to stop the agent process of a turn that is still
// running: runtime.close() only requests cancellation and releases idle
// clients. Wrapping the session manager's client factory records each client
// so a bounded stop can close the live ones too.
// acpx also drops the ACP PromptResponse.usage (the agent's own per-turn token
// count) from its turn result, so each client's prompt is wrapped to hand that
// usage to the meter of the turn that sent the prompt.
async function trackAgentClients(
  runtime: AcpxRuntime,
  currentMeter: () => AgentTurnMeter | null,
): Promise<Set<AgentProcessClient>> {
  const manager = await (
    runtime as unknown as {
      getManager(): Promise<{ createClient(options: unknown): AgentProcessClient }>;
    }
  ).getManager();
  const clients = new Set<AgentProcessClient>();
  const createClient = manager.createClient.bind(manager);
  manager.createClient = (options) => {
    const client = createClient(options);
    clients.add(client);
    const prompt = client.prompt.bind(client);
    client.prompt = (...args) => {
      const meter = currentMeter();
      return prompt(...args).then((response) => {
        meter?.recordUsage((response as { usage?: unknown } | undefined)?.usage);
        return response;
      });
    };
    return client;
  };
  return clients;
}

// Gives `operation` AGENT_STOP_GRACE_MS to settle after a stop request, then
// forces the agent down and allows it the same grace once more. Resolves
// whether it settled; never waits longer than that.
async function settleOrForceStop(operation: Promise<unknown>, forceStop?: () => Promise<void>): Promise<boolean> {
  if (await settlesWithin(operation, AGENT_STOP_GRACE_MS)) return true;
  await forceStop?.().catch(() => undefined);
  return settlesWithin(operation, AGENT_STOP_GRACE_MS);
}

function settlesWithin(operation: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  return Promise.race([operation.then(() => true, () => true), expired]).finally(() => clearTimeout(timer));
}

function isDevExtensionWorkspace(rootDir: string, agentCwd: string): boolean {
  return resolve(agentCwd) !== resolve(join(rootDir, "extensions"));
}
