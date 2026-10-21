import type * as schema from "@agentclientprotocol/sdk";
import { EMPTY, providerTurnError, type MapResult } from "../shared/types.js";
import { tokenCount, type TokenCounts } from "../shared/usage.js";

/**
 * Mapping from `agy -p --output-format stream-json` events to ACP session
 * updates. A turn ends on the `result` event. Shapes are from real runs of
 * Antigravity CLI 1.2.x:
 *   {"event":"init","conversation_id":"...","init":{"model","cwd","tools":[...]}}
 *   {"event":"step_update","step_update":{"conversation_id","step_index","state":"ACTIVE"|"DONE",
 *     "step_type":"user_input"|"agent_response"|"tool"|"system_message", ...}}
 *   {"event":"result","result":{"conversation_id","status":"SUCCESS"|"ERROR","response","error"}}
 *
 * `agent_response` steps stream incremental `text_delta` chunks while ACTIVE
 * and carry only the final remaining chunk when DONE, so every delta is emitted
 * as-is. `tool` steps go ACTIVE then DONE with the same `step_index`.
 *
 * The mapper keeps a little per-turn state (open and closed tool calls, whether any text
 * streamed), so create one per turn with `createAntigravityMapper()`.
 */
export type AntigravityEvent = {
  event?: string;
  conversation_id?: string;
  step_update?: AntigravityStep;
  result?: AntigravityResult;
};

type AntigravityStep = {
  conversation_id?: string;
  step_index?: number;
  state?: string;
  step_type?: string;
  text_delta?: string;
  tool_name?: string;
  tool_info?: { name?: string; parameters?: Record<string, unknown>; output?: unknown };
};

type AntigravityResult = {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  usage?: AntigravityUsage;
};

// The result's usage is the conversation's running total (verified against agy
// 1.2.17: a resumed turn reports num_turns 2 and doubled output counts).
// cache_read_tokens is reported beside input_tokens, not inside it, and
// thinking_tokens is part of output_tokens.
type AntigravityUsage = {
  input_tokens?: unknown;
  output_tokens?: unknown;
  thinking_tokens?: unknown;
  cache_read_tokens?: unknown;
};

const FAILED_STEP_STATES = new Set(["ERROR", "FAILED", "CANCELED", "CANCELLED"]);

export function createAntigravityMapper(): (event: AntigravityEvent) => MapResult {
  const openToolCalls = new Set<number>();
  const closedToolCalls = new Set<number>();
  let streamedText = false;

  return (event) => {
    switch (event.event) {
      case "step_update":
        return mapStep(event.step_update);
      case "result":
        return mapResult(event.result);
      // `init` carries the conversation id (read by the driver) and no content.
      default:
        return EMPTY;
    }
  };

  function mapStep(step: AntigravityStep | undefined): MapResult {
    if (!step) return EMPTY;
    if (step.step_type === "agent_response") {
      if (!step.text_delta) return EMPTY;
      streamedText = true;
      return { updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.text_delta } }] };
    }
    if (step.step_type === "tool" && typeof step.step_index === "number") {
      return mapToolStep(step, step.step_index);
    }
    return EMPTY;
  }

  function mapToolStep(step: AntigravityStep, index: number): MapResult {
    if (closedToolCalls.has(index)) return EMPTY;
    const updates: schema.SessionUpdate[] = [];
    if (!openToolCalls.has(index)) {
      openToolCalls.add(index);
      updates.push(openToolCall(step, index));
    }
    if (step.state === "DONE" || (step.state && FAILED_STEP_STATES.has(step.state))) {
      openToolCalls.delete(index);
      closedToolCalls.add(index);
      updates.push(closeToolCall(step, index));
    }
    return { updates };
  }

  function mapResult(result: AntigravityResult | undefined): MapResult {
    if (!result || result.status === "SUCCESS") {
      const tokens = antigravityConversationTokens(result?.usage);
      const usage = tokens ? { tokens } : {};
      // Fall back to the aggregated response when no deltas streamed.
      if (!streamedText && result?.response) {
        return {
          updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: result.response } }],
          stopReason: "end_turn",
          ...usage,
        };
      }
      return { updates: [], stopReason: "end_turn", ...usage };
    }
    return { updates: [], terminalError: providerTurnError("Antigravity", result.error) };
  }
}

function antigravityConversationTokens(usage: AntigravityUsage | undefined): TokenCounts | undefined {
  const input = tokenCount(usage?.input_tokens);
  const output = tokenCount(usage?.output_tokens);
  if (input === undefined || output === undefined) return undefined;
  const cachedRead = tokenCount(usage?.cache_read_tokens);
  const thought = tokenCount(usage?.thinking_tokens);
  return {
    input: input + (cachedRead ?? 0),
    output,
    ...(cachedRead !== undefined ? { cachedRead } : {}),
    ...(thought !== undefined ? { thought } : {}),
  };
}

function toolCallId(index: number): string {
  return `agy-step-${index}`;
}

function openToolCall(step: AntigravityStep, index: number): schema.SessionUpdate {
  const name = step.tool_info?.name ?? step.tool_name ?? "tool";
  return {
    sessionUpdate: "tool_call",
    toolCallId: toolCallId(index),
    title: toolTitle(name, step.tool_info?.parameters),
    kind: toolKind(name),
    status: "in_progress",
    rawInput: step.tool_info?.parameters ?? {},
  };
}

function closeToolCall(step: AntigravityStep, index: number): schema.SessionUpdate {
  const output = step.tool_info?.output;
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: toolCallId(index),
    status: step.state === "DONE" ? "completed" : "failed",
    content: typeof output === "string" && output ? [{ type: "content", content: { type: "text", text: output } }] : [],
  };
}

function toolKind(name: string): schema.ToolKind {
  if (/^(write_to_file|replace_file_content|multi_replace_file_content|edit|create)/.test(name)) return "edit";
  if (/^(delete|remove)/.test(name)) return "delete";
  if (/^(run_command|command|shell|bash)/.test(name)) return "execute";
  if (/(search|grep|find)/.test(name)) return "search";
  if (/^(read_url|browser|fetch)/.test(name)) return "fetch";
  if (/^(view_file|list_dir|read|view)/.test(name)) return "read";
  return "other";
}

function toolTitle(name: string, parameters: Record<string, unknown> | undefined): string {
  const command = parameters?.CommandLine;
  if (typeof command === "string" && command) return command.split("\n")[0]!.slice(0, 80);
  const target = parameters?.TargetFile ?? parameters?.AbsolutePath ?? parameters?.Url;
  if (typeof target === "string" && target) return `${name} ${target.split("/").pop()}`.slice(0, 80);
  return name;
}
