import { describe, expect, it } from "vitest";
import { createAntigravityMapper, type AntigravityEvent } from "../src/adapters/antigravity/mapper";

const step = (fields: Record<string, unknown>): AntigravityEvent => ({
  event: "step_update",
  step_update: { conversation_id: "c1", ...fields },
});

describe("createAntigravityMapper", () => {
  it("ignores init and non-content steps", () => {
    const map = createAntigravityMapper();
    expect(map({ event: "init", conversation_id: "c1" })).toEqual({ updates: [] });
    expect(map(step({ step_index: 0, state: "DONE", step_type: "user_input" }))).toEqual({ updates: [] });
    expect(map(step({ step_index: 1, state: "DONE", step_type: "system_message" }))).toEqual({ updates: [] });
    expect(map({ event: "something_new" })).toEqual({ updates: [] });
  });

  it("emits every agent_response delta as an incremental message chunk", () => {
    const map = createAntigravityMapper();
    const active = map(step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Hello " }));
    const done = map(step({ step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "world\n" }));
    expect(active.updates).toEqual([{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } }]);
    expect(done.updates).toEqual([{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world\n" } }]);
  });

  it("emits nothing for an agent_response step with no text (tool-calling turn)", () => {
    const map = createAntigravityMapper();
    expect(map(step({ step_index: 1, state: "DONE", step_type: "agent_response", usage: {} }))).toEqual({ updates: [] });
  });

  it("opens a tool call on ACTIVE and closes it on DONE, with output", () => {
    const map = createAntigravityMapper();
    const params = { CommandLine: "ls -la\nsecond line" };
    const open = map(step({ step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: params } }));
    expect(open.updates).toEqual([
      { sessionUpdate: "tool_call", toolCallId: "agy-step-2", title: "ls -la", kind: "execute", status: "in_progress", rawInput: params },
    ]);
    const close = map(
      step({ step_index: 2, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: params, output: "total 0\n" } }),
    );
    expect(close.updates).toEqual([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "agy-step-2",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "total 0\n" } }],
      },
    ]);
  });

  it("opens and closes a tool call that only reports DONE, exactly once", () => {
    const map = createAntigravityMapper();
    const done = step({ step_index: 4, state: "DONE", step_type: "tool", tool_name: "write_to_file", tool_info: { name: "write_to_file", parameters: { TargetFile: "/ws/widget.tsx" } } });
    const result = map(done);
    expect(result.updates.map((u) => u.sessionUpdate)).toEqual(["tool_call", "tool_call_update"]);
    expect(result.updates[0]).toMatchObject({ kind: "edit", title: "write_to_file widget.tsx" });
    // A repeated DONE does not re-open the call.
    expect(map(done)).toEqual({ updates: [] });
  });

  it("marks a failed tool step as failed", () => {
    const map = createAntigravityMapper();
    map(step({ step_index: 5, state: "ACTIVE", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: "/a/b.txt" } } }));
    const close = map(step({ step_index: 5, state: "ERROR", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file" } }));
    expect(close.updates).toEqual([{ sessionUpdate: "tool_call_update", toolCallId: "agy-step-5", status: "failed", content: [] }]);
    // A late update for a failed step does not re-open the call.
    expect(map(step({ step_index: 5, state: "DONE", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file" } }))).toEqual({ updates: [] });
  });

  it.each([
    ["run_command", "execute"],
    ["write_to_file", "edit"],
    ["replace_file_content", "edit"],
    ["multi_replace_file_content", "edit"],
    ["view_file", "read"],
    ["list_dir", "read"],
    ["grep_search", "search"],
    ["read_url_content", "fetch"],
    ["ask_question", "other"],
  ])("classifies %s as %s", (name, kind) => {
    const map = createAntigravityMapper();
    const open = map(step({ step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: name, tool_info: { name, parameters: {} } }));
    expect(open.updates[0]).toMatchObject({ kind });
  });

  it("ends the turn with end_turn on a SUCCESS result", () => {
    const map = createAntigravityMapper();
    map(step({ step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "done\n" }));
    expect(map({ event: "result", result: { status: "SUCCESS", response: "done\n" } })).toEqual({ updates: [], stopReason: "end_turn" });
  });

  it("falls back to the aggregated response when no deltas streamed", () => {
    const map = createAntigravityMapper();
    expect(map({ event: "result", result: { status: "SUCCESS", response: "final answer" } })).toEqual({
      updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "final answer" } }],
      stopReason: "end_turn",
    });
  });

  it("maps an ERROR result to a safe typed error without leaking provider detail", () => {
    const map = createAntigravityMapper();
    const auth = map({ event: "result", result: { status: "ERROR", error: "authentication failed or timed out" } });
    expect(auth.terminalError).toMatchObject({
      code: "AUTHENTICATION_FAILED",
      message: "Antigravity is not authenticated. Open Antigravity (`agy`) and sign in, then try again.",
    });
    const rate = map({ event: "result", result: { status: "ERROR", error: "429 quota exhausted for claude" } });
    expect(rate.terminalError).toMatchObject({ code: "RATE_LIMITED", message: "Antigravity is rate limited. Wait for access to recover, then try again." });
    const model = map({
      event: "result",
      result: { status: "ERROR", error: 'invalid model selection (--model "bogus" --effort ""): model bogus is not recognized /private/path' },
    });
    expect(model.terminalError).toMatchObject({
      code: "MODEL_REJECTED",
      message: "Antigravity did not accept the model it was asked to use. Choose another model for Antigravity in Settings.",
    });
    const other = map({ event: "result", result: { status: "ERROR", error: "model exploded with /private/path" } });
    expect(other.terminalError).toMatchObject({ code: "PROVIDER_FAILED", message: "Antigravity provider failed the request." });
    expect(other.stopReason).toBeUndefined();
  });
});
