import { describe, expect, it, vi } from "vitest";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { BridgeAgent } from "../src/adapters/shared/acp-agent";
import { AdapterTurnError, type SessionDriver } from "../src/adapters/shared/types";

function buildAgent(driver: SessionDriver) {
  const agent = new BridgeAgent(driver, "test-adapter");
  agent.setConnection({ sessionUpdate: vi.fn(async () => undefined) } as unknown as AgentSideConnection);
  return agent;
}

describe("BridgeAgent failure contract", () => {
  it("rejects a typed authentication failure as a safe ACP request error", async () => {
    const driver: SessionDriver = {
      start: vi.fn(async () => undefined),
      prompt: vi.fn(async () => {
        throw new AdapterTurnError(
          "AUTHENTICATION_FAILED",
          "Codex is not authenticated. Run `codex login` and try again.",
        );
      }),
      dispose: vi.fn(async () => undefined),
    };
    const agent = buildAgent(driver);
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });

    await expect(
      agent.prompt({ sessionId, prompt: [{ type: "text", text: "make an edit" }] }),
    ).rejects.toMatchObject({
      name: "RequestError",
      code: -32000,
      message: "Authentication required: Codex is not authenticated. Run `codex login` and try again.",
      data: { adapterCode: "AUTHENTICATION_FAILED" },
    });
  });

  it("sanitizes an untyped adapter exception before it crosses ACP", async () => {
    const driver: SessionDriver = {
      start: vi.fn(async () => undefined),
      prompt: vi.fn(async () => {
        throw new Error("Bearer private-adapter-detail");
      }),
      dispose: vi.fn(async () => undefined),
    };
    const agent = buildAgent(driver);
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });

    const prompt = agent.prompt({ sessionId, prompt: [{ type: "text", text: "make an edit" }] });
    await expect(prompt).rejects.toMatchObject({
      code: -32603,
      message: "Internal error: The embedded agent failed while processing the request.",
      data: { adapterCode: "ADAPTER_FAILED" },
    });
    await expect(prompt).rejects.not.toThrow(/private-adapter-detail/);
  });
});

describe("BridgeAgent token usage", () => {
  it("returns the usage a driver reported as the ACP PromptResponse usage", async () => {
    const usage = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    const driver: SessionDriver = {
      start: vi.fn(async () => undefined),
      prompt: vi.fn(async (_text, _sink, _signal, onUsage) => {
        onUsage?.(usage);
        return "end_turn" as const;
      }),
      dispose: vi.fn(async () => undefined),
    };
    const agent = buildAgent(driver);
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });

    await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] })).resolves.toEqual({ stopReason: "end_turn", usage });
  });

  it("omits usage when the driver reported none", async () => {
    const driver: SessionDriver = {
      start: vi.fn(async () => undefined),
      prompt: vi.fn(async () => "end_turn" as const),
      dispose: vi.fn(async () => undefined),
    };
    const agent = buildAgent(driver);
    const { sessionId } = await agent.newSession({ cwd: "/tmp", mcpServers: [] });

    await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "hi" }] })).resolves.toEqual({ stopReason: "end_turn" });
  });
});
