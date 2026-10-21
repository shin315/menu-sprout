import { describe, expect, it } from "vitest";
import { formatDuration, formatTurnMetrics } from "../src/renderer/agent/turn-metrics";

describe("post-turn metrics line", () => {
  it("shows duration and tool calls and leaves tokens out when none were reported", () => {
    expect(formatTurnMetrics({ durationMs: 12_400, toolCalls: 1 })).toEqual({ text: "12.4s · 1 tool call" });
    expect(formatTurnMetrics({ durationMs: 0, toolCalls: 0 })).toEqual({ text: "0.0s · 0 tool calls" });
  });

  it("adds the reported token total with its breakdown", () => {
    const formatted = formatTurnMetrics({
      durationMs: 125_000,
      toolCalls: 12,
      tokens: { totalTokens: 24_031, inputTokens: 23_995, outputTokens: 36, cachedReadTokens: 0, cachedWriteTokens: 23_985, thoughtTokens: 29 },
    });
    expect(formatted.text).toBe("2m 05s · 12 tool calls · 24,031 tokens");
    expect(formatted.title).toBe(
      "input 23,995 (cache read 0, cache write 23,985) · output 36 (reasoning 29) · as reported by the agent",
    );
  });

  it("formats durations", () => {
    expect(formatDuration(59_949)).toBe("59.9s");
    expect(formatDuration(60_000)).toBe("1m 00s");
  });
});
