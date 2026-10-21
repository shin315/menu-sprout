import type { AgentTurnMetrics, AgentTurnTokenUsage } from "../../shared/contracts";

const numberFormat = new Intl.NumberFormat("en-US");

/**
 * The compact post-turn line: duration, tool calls, and tokens only when the
 * agent reported them. Nothing here is estimated; an unreported count is left
 * out rather than shown as zero.
 */
export function formatTurnMetrics(metrics: AgentTurnMetrics): { text: string; title?: string } {
  const parts = [formatDuration(metrics.durationMs), `${numberFormat.format(metrics.toolCalls)} tool ${metrics.toolCalls === 1 ? "call" : "calls"}`];
  if (!metrics.tokens) return { text: parts.join(" · ") };
  parts.push(`${numberFormat.format(metrics.tokens.totalTokens)} tokens`);
  return { text: parts.join(" · "), title: tokenBreakdown(metrics.tokens) };
}

export function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, durationMs) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
}

function tokenBreakdown(tokens: AgentTurnTokenUsage): string {
  const input = [
    tokens.cachedReadTokens !== undefined ? `cache read ${numberFormat.format(tokens.cachedReadTokens)}` : null,
    tokens.cachedWriteTokens !== undefined ? `cache write ${numberFormat.format(tokens.cachedWriteTokens)}` : null,
  ].filter(Boolean);
  const output = tokens.thoughtTokens !== undefined ? [`reasoning ${numberFormat.format(tokens.thoughtTokens)}`] : [];
  return [
    `input ${numberFormat.format(tokens.inputTokens)}${input.length ? ` (${input.join(", ")})` : ""}`,
    `output ${numberFormat.format(tokens.outputTokens)}${output.length ? ` (${output.join(", ")})` : ""}`,
    "as reported by the agent",
  ].join(" · ");
}
