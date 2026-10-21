import type * as schema from "@agentclientprotocol/sdk";

/**
 * Token counts one CLI reported, normalized so `input` always includes cache
 * reads and writes and `cachedRead`/`cachedWrite`/`thought` are parts of the
 * input and output totals rather than extra tokens.
 */
export type TokenCounts = {
  input: number;
  output: number;
  cachedRead?: number;
  cachedWrite?: number;
  thought?: number;
};

const FIELDS = ["input", "output", "cachedRead", "cachedWrite", "thought"] as const;

/** Reads a reported count; anything but a finite non-negative number is unreported. */
export function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The ACP per-turn usage for a PromptResponse. */
export function toAcpUsage(counts: TokenCounts): schema.Usage {
  return {
    inputTokens: counts.input,
    outputTokens: counts.output,
    totalTokens: counts.input + counts.output,
    ...(counts.cachedRead !== undefined ? { cachedReadTokens: counts.cachedRead } : {}),
    ...(counts.cachedWrite !== undefined ? { cachedWriteTokens: counts.cachedWrite } : {}),
    ...(counts.thought !== undefined ? { thoughtTokens: counts.thought } : {}),
  };
}

/**
 * Turns a CLI's running conversation totals into per-turn counts. Codex and
 * Antigravity report usage summed over the whole conversation, so a turn's own
 * usage is the difference from the previous turn's totals. When that baseline is
 * unknown (an earlier turn in the conversation ended without reporting totals)
 * or the totals went backwards, the turn's usage is not reported at all rather
 * than guessed.
 */
export class ConversationUsage {
  private baseline: TokenCounts | null = { input: 0, output: 0 };

  /** Per-turn counts for these conversation totals, or undefined when they cannot be known. */
  next(totals: TokenCounts): TokenCounts | undefined {
    const baseline = this.baseline;
    this.baseline = totals;
    if (!baseline) return undefined;
    const delta: TokenCounts = { input: totals.input - baseline.input, output: totals.output - baseline.output };
    for (const field of FIELDS) {
      const current = totals[field];
      if (current === undefined) continue;
      const value = current - (baseline[field] ?? 0);
      if (value < 0) return undefined;
      delta[field] = value;
    }
    if (delta.input < 0 || delta.output < 0) return undefined;
    return delta;
  }

  /** A turn in this conversation ended without reporting totals. */
  lose(): void {
    this.baseline = null;
  }
}
