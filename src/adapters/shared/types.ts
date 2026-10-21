import type * as schema from "@agentclientprotocol/sdk";
import type { TokenCounts } from "./usage.js";

/**
 * A sink the mappers/drivers use to emit ACP session updates for the current
 * turn. The generic agent wires this to `AgentSideConnection.sessionUpdate`.
 */
export type UpdateSink = (update: schema.SessionUpdate) => void;

export type AdapterTurnErrorCode =
  | "AUTHENTICATION_FAILED"
  | "RATE_LIMITED"
  | "MODEL_REJECTED"
  | "EFFORT_REJECTED"
  | "PROVIDER_FAILED"
  | "CLI_START_FAILED"
  | "CLI_EXIT_FAILED"
  | "ADAPTER_FAILED";

/** A safe terminal adapter failure whose message may cross ACP into the UI. */
export class AdapterTurnError extends Error {
  constructor(
    readonly code: AdapterTurnErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AdapterTurnError";
  }
}

type AdapterName = "Claude" | "Codex" | "Antigravity";

const AUTH_FAILURE_MESSAGES: Record<AdapterName, string> = {
  Codex: "Codex is not authenticated. Run `codex login` and try again.",
  Claude: "Claude is not authenticated. Run `claude` and complete sign-in, then try again.",
  Antigravity: "Antigravity is not authenticated. Open Antigravity (`agy`) and sign in, then try again.",
};

export function authenticationFailure(agent: AdapterName): AdapterTurnError {
  return new AdapterTurnError("AUTHENTICATION_FAILED", AUTH_FAILURE_MESSAGES[agent]);
}

export function providerTurnError(agent: AdapterName, detail: unknown): AdapterTurnError {
  const text = typeof detail === "string" ? detail : "";
  if (/\b401\b|unauthorized|authentication|not logged in|missing bearer/i.test(text)) {
    return authenticationFailure(agent);
  }
  if (EFFORT_REJECTED_PATTERN.test(text)) return effortRejected(agent);
  if (MODEL_REJECTED_PATTERN.test(text)) return modelRejected(agent);
  if (/\b429\b|rate.?limit|quota/i.test(text)) {
    return new AdapterTurnError("RATE_LIMITED", `${agent} is rate limited. Wait for access to recover, then try again.`);
  }
  return new AdapterTurnError("PROVIDER_FAILED", `${agent} provider failed the request.`);
}

// How each CLI reports a model or effort it will not use, from real runs:
// Claude "There's an issue with the selected model (...)", Codex "The '...'
// model is not supported ..." and "[reasoning.effort] [invalid_enum_value]",
// Antigravity "invalid model selection (...): invalid --effort ..." or "model
// ... is not recognized as a known model", and Claude's stderr warning
// "Unknown --effort value '...' - ignoring it".
const EFFORT_REJECTED_PATTERN = /invalid --effort|unknown --effort value|reasoning\.effort|ReasoningEffortParam/i;
const MODEL_REJECTED_PATTERN =
  /issue with the selected model|model is not supported|model_not_found|not recognized as a known model|invalid model selection|unrecognized_model/i;

export function modelRejected(agent: AdapterName): AdapterTurnError {
  return new AdapterTurnError(
    "MODEL_REJECTED",
    `${agent} did not accept the model it was asked to use. Choose another model for ${agent} in Settings.`,
  );
}

export function effortRejected(agent: AdapterName): AdapterTurnError {
  return new AdapterTurnError(
    "EFFORT_REJECTED",
    `${agent} did not accept the effort level it was asked to use. Choose another effort for ${agent} in Settings, or CLI default.`,
  );
}

/** True for CLI output that says an effort value was ignored rather than used. */
export function isEffortRejection(text: string): boolean {
  return EFFORT_REJECTED_PATTERN.test(text);
}

export function safeAdapterTurnError(error: unknown): AdapterTurnError {
  if (error instanceof AdapterTurnError) return error;
  return new AdapterTurnError("ADAPTER_FAILED", "The embedded agent failed while processing the request.");
}

/**
 * The result of mapping a single CLI event. A mapper is a pure reducer: given a
 * parsed backend event, it returns the ACP updates to emit and, when the turn
 * has ended, the terminal stop reason.
 */
export type MapResult = {
  updates: schema.SessionUpdate[];
  /** Set once the turn completes successfully; resolves the ACP prompt. */
  stopReason?: schema.StopReason;
  /** Safe typed failure for a terminal provider event. */
  terminalError?: AdapterTurnError;
  /** Token counts the CLI reported; per turn or per conversation depending on the CLI. */
  tokens?: TokenCounts;
};

/**
 * Backend-agnostic session driver. Each adapter (claude, codex) implements this
 * over its CLI; the generic ACP agent drives it.
 */
export interface SessionDriver {
  /** Start (or lazily prepare) the backend for a session rooted at `cwd`. */
  start(cwd: string): Promise<void>;
  /**
   * Run one user turn. Emit ACP updates via `sink` as backend events arrive and
   * resolve with the terminal stop reason once the turn completes. Must honor
   * `signal` (ACP cancel) and resolve with "cancelled" when aborted. Calls
   * `onUsage` with the turn's own token usage only when the CLI reported it.
   */
  prompt(
    text: string,
    sink: UpdateSink,
    signal: AbortSignal,
    onUsage?: (usage: schema.Usage) => void,
  ): Promise<schema.StopReason>;
  /** Tear down any backend process. */
  dispose(): Promise<void>;
}

export const EMPTY: MapResult = { updates: [] };
