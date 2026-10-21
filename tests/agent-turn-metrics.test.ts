import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentTurnMeter, parseTokenUsage } from "../src/main/agent-turn-metrics";

describe("AgentTurnMeter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts each tool call once across its updates and measures wall-clock duration", () => {
    let now = 1_000;
    const meter = new AgentTurnMeter(1_000, {}, vi.fn(), () => now);
    meter.recordEvent({ type: "tool_call", text: "Read (in_progress)", tag: "tool_call", toolCallId: "a", status: "in_progress" });
    meter.recordEvent({ type: "tool_call", text: "Read (completed)", tag: "tool_call_update", toolCallId: "a", status: "completed" });
    meter.recordEvent({ type: "tool_call", text: "Bash", tag: "tool_call", toolCallId: "b" });
    meter.recordEvent({ type: "tool_call", text: "untracked", tag: "tool_call" });
    meter.recordEvent({ type: "tool_call", text: "untracked update", tag: "tool_call_update" });
    meter.recordEvent({ type: "text_delta", text: "hello", stream: "output" });
    now = 13_400;
    expect(meter.snapshot()).toEqual({ durationMs: 12_400, toolCalls: 3 });
  });

  it("allows the limit's number of tool calls and stops when the agent starts one more", () => {
    const onLimit = vi.fn();
    const meter = new AgentTurnMeter(Date.now(), { maxToolCalls: 2 }, onLimit);
    meter.recordEvent({ type: "tool_call", text: "1", tag: "tool_call", toolCallId: "1" });
    meter.recordEvent({ type: "tool_call", text: "2", tag: "tool_call", toolCallId: "2" });
    meter.recordEvent({ type: "tool_call", text: "2 done", tag: "tool_call_update", toolCallId: "2" });
    expect(onLimit).not.toHaveBeenCalled();
    meter.recordEvent({ type: "tool_call", text: "3", tag: "tool_call", toolCallId: "3" });
    meter.recordEvent({ type: "tool_call", text: "4", tag: "tool_call", toolCallId: "4" });
    expect(onLimit).toHaveBeenCalledTimes(1);
    expect(onLimit).toHaveBeenCalledWith("tool-call-limit");
    expect(meter.stoppedBy).toBe("tool-call-limit");
  });

  it("stops at the time limit measured from the send, once", () => {
    vi.useFakeTimers();
    const onLimit = vi.fn();
    const meter = new AgentTurnMeter(Date.now(), { maxTurnMinutes: 2 }, onLimit);
    vi.advanceTimersByTime(119_999);
    expect(onLimit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLimit).toHaveBeenCalledWith("time-limit");
    meter.recordEvent({ type: "tool_call", text: "late", tag: "tool_call", toolCallId: "x" });
    expect(onLimit).toHaveBeenCalledTimes(1);
  });

  it("no longer enforces limits once disposed (the user's Cancel decides)", () => {
    vi.useFakeTimers();
    const onLimit = vi.fn();
    const meter = new AgentTurnMeter(Date.now(), { maxTurnMinutes: 1 }, onLimit);
    meter.dispose();
    vi.advanceTimersByTime(120_000);
    expect(onLimit).not.toHaveBeenCalled();
    expect(meter.stoppedBy).toBeNull();
  });

  it("reports tokens only when the agent reported usage", () => {
    const meter = new AgentTurnMeter(Date.now(), {}, vi.fn());
    meter.recordUsage(undefined);
    expect(meter.snapshot().tokens).toBeUndefined();
    meter.recordUsage({ inputTokens: 2_310, outputTokens: 40, totalTokens: 2_350, cachedReadTokens: 300 });
    expect(meter.snapshot().tokens).toEqual({ inputTokens: 2_310, outputTokens: 40, totalTokens: 2_350, cachedReadTokens: 300 });
  });
});

describe("parseTokenUsage", () => {
  it("rejects usage missing a required count rather than filling it in", () => {
    expect(parseTokenUsage({ inputTokens: 1, outputTokens: 2 })).toBeUndefined();
    expect(parseTokenUsage({ inputTokens: -1, outputTokens: 2, totalTokens: 1 })).toBeUndefined();
    expect(parseTokenUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 3, thoughtTokens: "4" })).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
    });
  });
});
