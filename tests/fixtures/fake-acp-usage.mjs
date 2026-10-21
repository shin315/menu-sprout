#!/usr/bin/env node
// A fake ACP agent that runs two tool calls and, when the prompt asks for it,
// reports the turn's token usage in its PromptResponse the way the bundled
// adapters do. Without REPORT_USAGE it reports none.
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

let connection;
let sessionId = null;

const agent = {
  async initialize() {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: false }, authMethods: [] };
  },
  async authenticate() {
    return {};
  },
  async newSession() {
    sessionId = randomUUID();
    return { sessionId };
  },
  async prompt(params) {
    const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("\n");
    for (const id of ["call-1", "call-2"]) {
      await connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "tool_call", toolCallId: id, title: "Read", kind: "read", status: "in_progress" },
      });
      await connection.sessionUpdate({
        sessionId,
        update: { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" },
      });
    }
    await connection.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } },
    });
    if (!text.includes("REPORT_USAGE")) return { stopReason: "end_turn" };
    return {
      stopReason: "end_turn",
      usage: { inputTokens: 2310, outputTokens: 40, totalTokens: 2350, cachedReadTokens: 300, cachedWriteTokens: 2000 },
    };
  },
  async cancel() {},
};

connection = new AgentSideConnection(() => agent, ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
