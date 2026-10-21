import type { AcpRuntimeEvent } from "acpx/runtime";
import type { AgentTurnMetrics, AgentTurnStopLimit, AgentTurnTokenUsage } from "../shared/contracts";
import type { AgentTurnLimits } from "../shared/agent-options";

/**
 * Measures one agent turn from what actually happened: wall-clock time since the
 * send started, tool calls seen on the ACP event stream, and token usage only
 * when the agent reported it in its ACP prompt response. Also enforces the
 * optional per-turn limits by calling `onLimit` once, the first time one is hit.
 */
export class AgentTurnMeter {
  private readonly toolCallIds = new Set<string>();
  private unidentifiedToolCalls = 0;
  private tokens: AgentTurnTokenUsage | undefined;
  private limitHit: AgentTurnStopLimit | null = null;
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private limitsActive = true;

  constructor(
    readonly startedAt: number,
    private readonly limits: AgentTurnLimits,
    private readonly onLimit: (limit: AgentTurnStopLimit) => void,
    private readonly now: () => number = Date.now,
  ) {
    if (limits.maxTurnMinutes) {
      const remainingMs = startedAt + limits.maxTurnMinutes * 60_000 - now();
      this.limitTimer = setTimeout(() => this.hit("time-limit"), Math.max(0, remainingMs));
      this.limitTimer.unref?.();
    }
  }

  get stoppedBy(): AgentTurnStopLimit | null {
    return this.limitHit;
  }

  get toolCalls(): number {
    return this.toolCallIds.size + this.unidentifiedToolCalls;
  }

  /**
   * Counts a tool call once, when it first appears. acpx reports both the call
   * and its later updates as `tool_call` events, so calls are keyed by id.
   */
  recordEvent(event: AcpRuntimeEvent): void {
    if (event.type !== "tool_call") return;
    if (event.toolCallId) {
      this.toolCallIds.add(event.toolCallId);
    } else if (event.tag === "tool_call") {
      this.unidentifiedToolCalls += 1;
    } else {
      return;
    }
    // The limit allows that many tool calls; the turn stops when the agent
    // starts one more.
    if (this.limits.maxToolCalls !== undefined && this.toolCalls > this.limits.maxToolCalls) {
      this.hit("tool-call-limit");
    }
  }

  /** Records the ACP PromptResponse.usage the agent reported, if it is well formed. */
  recordUsage(usage: unknown): void {
    const parsed = parseTokenUsage(usage);
    if (parsed) this.tokens = parsed;
  }

  snapshot(): AgentTurnMetrics {
    return {
      durationMs: Math.max(0, this.now() - this.startedAt),
      toolCalls: this.toolCalls,
      ...(this.tokens ? { tokens: this.tokens } : {}),
    };
  }

  /** Stops enforcing limits; measuring continues. */
  dispose(): void {
    this.limitsActive = false;
    if (this.limitTimer) clearTimeout(this.limitTimer);
    this.limitTimer = null;
  }

  private hit(limit: AgentTurnStopLimit): void {
    if (this.limitHit || !this.limitsActive) return;
    this.limitHit = limit;
    this.dispose();
    this.onLimit(limit);
  }
}

const OPTIONAL_TOKEN_FIELDS = ["cachedReadTokens", "cachedWriteTokens", "thoughtTokens"] as const;

/**
 * Reads an ACP `Usage` object. The required counts must all be finite and
 * non-negative or nothing is reported; optional counts are kept only when valid.
 */
export function parseTokenUsage(usage: unknown): AgentTurnTokenUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const totalTokens = count(record.totalTokens);
  const inputTokens = count(record.inputTokens);
  const outputTokens = count(record.outputTokens);
  if (totalTokens === undefined || inputTokens === undefined || outputTokens === undefined) return undefined;
  const parsed: AgentTurnTokenUsage = { totalTokens, inputTokens, outputTokens };
  for (const field of OPTIONAL_TOKEN_FIELDS) {
    const value = count(record[field]);
    if (value !== undefined) parsed[field] = value;
  }
  return parsed;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

const failedTurnMetrics = new WeakMap<object, AgentTurnMetrics>();

// A turn that ran and then failed keeps what it measured on its error, so the
// send route can still report what the turn cost.
export function recordFailedTurnMetrics(error: unknown, metrics: AgentTurnMetrics): void {
  if (typeof error === "object" && error !== null) failedTurnMetrics.set(error, metrics);
}

export function metricsOfFailedTurn(error: unknown): AgentTurnMetrics | undefined {
  return typeof error === "object" && error !== null ? failedTurnMetrics.get(error) : undefined;
}
