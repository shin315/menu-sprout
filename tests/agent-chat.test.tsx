/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentChat } from "../src/renderer/agent/AgentChat";
import { App } from "../src/renderer/App";
import type { AgentActiveTurn, AgentChatResult, AgentRuntimeStatus, GitSessionSnapshot } from "../src/shared/contracts";

function installMenuSproutAgentMock({
  session = null,
  activeTurn = null,
}: { session?: GitSessionSnapshot | null; activeTurn?: AgentActiveTurn | null } = {}) {
  let statusListener: ((status: AgentRuntimeStatus) => void) | null = null;
  window.menuSprout = {
    recipes: {
      list: vi.fn(),
    },
    git: {
      save: vi.fn(),
      rollback: vi.fn(),
      status: vi.fn(async () => session),
    },
    agent: {
      send: vi.fn(() => new Promise<AgentChatResult>(() => undefined)),
      onStatus: vi.fn((listener: (status: AgentRuntimeStatus) => void) => {
        statusListener = listener;
        return () => {
          statusListener = null;
        };
      }),
      getActiveTurn: vi.fn(async () => activeTurn),
      cancel: vi.fn(async () => ({ ok: true })),
      newConversation: vi.fn(async () => ({ ok: true })),
    },
    capabilities: {
      list: vi.fn(),
      invoke: vi.fn(),
    },
    db: {
      query: vi.fn(async () => []),
      get: vi.fn(async () => undefined),
      run: vi.fn(async () => ({ changes: 0, lastInsertRowid: 0 })),
      exec: vi.fn(async () => undefined),
    },
    widgets: {
      list: vi.fn(async () => []),
    },
    background: { onUpdate: vi.fn(() => () => undefined) },
    layout: { get: vi.fn(async () => null) },
    popover: {
      setContentHeight: vi.fn(async () => ({ ok: true })),
      setContentSize: vi.fn(async () => ({ ok: true })),
      getVisibility: vi.fn(async () => ({ visible: true })),
      onVisibility: vi.fn(() => () => undefined),
    },
    settings: {
      get: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setOpenAtLogin: vi.fn(async (openAtLogin: boolean) => ({ openAtLogin, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setTheme: vi.fn(async (theme: string) => ({ openAtLogin: false, agentName: "claude", agents: [], theme, appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setAppearance: vi.fn(async (appearance: "light" | "dark" | "system") => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setTelemetryEnabled: vi.fn(async (enabled: boolean) => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled, source: "preference" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setAgent: vi.fn(async (agentName: string) => ({ openAtLogin: false, agentName, agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      addAgent: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      updateAgent: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      removeAgent: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setAgentModel: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setTurnLimits: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
    },
    app: {
      quit: vi.fn(async () => ({ ok: true })),
      getUpdateStatus: vi.fn(async () => ({ currentVersion: "0.0.0", latestVersion: null, updateAvailable: false, releaseUrl: null })),
      openReleasePage: vi.fn(async () => ({ ok: true })),
    },
  };

  return {
    emitStatus(status: AgentRuntimeStatus) {
      statusListener?.(status);
    },
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.menuSprout;
});

describe("AgentChat", () => {
  it("replaces the composer with the run strip while the agent is working", async () => {
    installMenuSproutAgentMock();
    render(<AgentChat />);

    const composer = screen.getByPlaceholderText("talk to the sprout");
    fireEvent.change(composer, { target: { value: "add a CPU temperature widget" } });
    fireEvent.submit(composer.closest("form")!);

    expect(await screen.findByText("› add a CPU temperature widget")).toBeTruthy();
    expect(screen.getByText("Working...")).toBeTruthy();
    expect(screen.queryByPlaceholderText("agent working")).toBeNull();
    expect(screen.queryByPlaceholderText("talk to the sprout")).toBeNull();
    expect(screen.queryByRole("button", { name: "send" })).toBeNull();
  });

  it("shows assistant output status text and no synthetic status", async () => {
    const agent = installMenuSproutAgentMock();
    render(<AgentChat />);

    const composer = screen.getByPlaceholderText("talk to the sprout");
    fireEvent.change(composer, { target: { value: "summarize my pull requests" } });
    fireEvent.submit(composer.closest("form")!);

    expect(await screen.findByText("› summarize my pull requests")).toBeTruthy();
    expect(screen.queryByText("starting agent")).toBeNull();
    expect(screen.getByText("Working...")).toBeTruthy();

    act(() => {
      agent.emitStatus({ text: "I found two pull requests", eventType: "text_delta" });
    });

    expect(screen.getByText("I found two pull requests")).toBeTruthy();
  });

  it("restores the in-progress run strip (not a Keep/Undo prompt) when a turn is still running on mount", async () => {
    // Mid-build, the popover view can remount (returning from Settings). Main is
    // the source of truth: it reports an active turn, so the run strip comes back
    // and the Keep/Undo prompt must NOT appear yet.
    installMenuSproutAgentMock({
      activeTurn: { title: "add a codex widget", startedAt: Date.now() - 3_000 },
      // git.status would return null mid-turn, but assert independently of it.
      session: { startedClean: true, canSave: true, canRollback: true, head: null },
    });
    render(<AgentChat />);

    expect(await screen.findByText("› add a codex widget")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Keep" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("re-hydrates a pending Keep/Undo prompt from an outstanding session on mount", async () => {
    installMenuSproutAgentMock({
      session: {
        startedClean: true,
        canSave: true,
        canRollback: true,
        head: null,
        message: "Review the generated changes, then Save or Rollback.",
      },
    });
    render(<AgentChat />);

    expect(await screen.findByRole("button", { name: "Keep" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(screen.getByText("Review the generated changes, then Save or Rollback.")).toBeTruthy();
  });

  it("keeps the draft when a send is refused because a change is still pending", async () => {
    installMenuSproutAgentMock({
      session: { startedClean: true, canSave: true, canRollback: true, head: null, dirty: true },
    });
    render(<AgentChat />);
    await screen.findByRole("button", { name: "Keep" });

    const composer = screen.getByPlaceholderText("talk to the sprout") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "fix the quota widget" } });
    fireEvent.submit(composer.closest("form")!);

    expect(await screen.findByText("Finish this change first")).toBeTruthy();
    await waitFor(() => expect(composer.value).toBe("fix the quota widget"));
    expect(window.menuSprout!.agent.send).not.toHaveBeenCalled();
  });

  it("surfaces the real failure reason when a send rejects", async () => {
    installMenuSproutAgentMock();
    window.menuSprout!.agent.send = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'menu-sprout:agent:send': Error: AgentTurnFailedError: Codex CLI exited with code 127",
      );
    });
    render(<AgentChat />);

    const composer = screen.getByPlaceholderText("talk to the sprout");
    fireEvent.change(composer, { target: { value: "add a widget" } });
    fireEvent.submit(composer.closest("form")!);

    expect(await screen.findByText("Codex CLI exited with code 127")).toBeTruthy();
    expect(screen.queryByText("No changes were made")).toBeNull();
    expect(screen.queryByText("the agent did not edit anything")).toBeNull();
  });

  it("shows the measured numbers of a turn that ran and then failed under its failure reason", async () => {
    installMenuSproutAgentMock();
    window.menuSprout!.agent.send = vi.fn(() =>
      Promise.reject({ message: "Rate limit reached", metrics: { durationMs: 42_000, toolCalls: 9 } }),
    );
    render(<AgentChat />);

    const composer = screen.getByPlaceholderText("talk to the sprout");
    fireEvent.change(composer, { target: { value: "add a widget" } });
    fireEvent.submit(composer.closest("form")!);

    expect(await screen.findByText("Rate limit reached")).toBeTruthy();
    expect(screen.getByLabelText("last turn").textContent).toBe("42.0s · 9 tool calls");
  });

  it("shows no metrics line when a send fails before any turn starts", async () => {
    installMenuSproutAgentMock();
    window.menuSprout!.agent.send = vi.fn(async () => {
      throw new Error("Error invoking remote method 'menu-sprout:agent:send': Error: Codex authentication failed.");
    });
    render(<AgentChat />);

    const composer = screen.getByPlaceholderText("talk to the sprout");
    fireEvent.change(composer, { target: { value: "add a widget" } });
    fireEvent.submit(composer.closest("form")!);

    expect(await screen.findByText("Codex authentication failed.")).toBeTruthy();
    expect(screen.queryByLabelText("last turn")).toBeNull();
  });

  it("keeps partial failed changes reviewable alongside the failure reason", async () => {
    installMenuSproutAgentMock({
      session: {
        startedClean: true,
        canSave: true,
        canRollback: true,
        head: null,
        dirty: true,
        changes: [{ type: "extension", extensionId: "battery", kind: "updated" }],
      },
    });
    window.menuSprout!.agent.send = vi.fn(async () => {
      throw new Error("Codex authentication failed. Sign in and try again.");
    });
    render(<AgentChat />);

    const composer = screen.getByPlaceholderText("talk to the sprout");
    fireEvent.change(composer, { target: { value: "update the battery widget" } });
    fireEvent.submit(composer.closest("form")!);

    expect(await screen.findByText("Codex authentication failed. Sign in and try again.")).toBeTruthy();
    expect(screen.getByText("Updated the battery extension")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  it("labels the Keep prompt from the diff, not the agent prose (updated extension)", async () => {
    installMenuSproutAgentMock();
    // The agent claims it "added" something, but the diff says an existing
    // extension was updated. The label must follow the diff.
    window.menuSprout!.agent.send = vi.fn(async (): Promise<AgentChatResult> => ({
      assistantText: "Added a battery widget for you!",
      session: {
        startedClean: true,
        canSave: true,
        canRollback: true,
        head: null,
        dirty: true,
        changes: [{ type: "extension", extensionId: "battery", kind: "updated" }],
      },
    }));
    render(<AgentChat />);

    const composer = screen.getByPlaceholderText("talk to the sprout");
    fireEvent.change(composer, { target: { value: "make the battery widget bigger" } });
    fireEvent.submit(composer.closest("form")!);

    expect(await screen.findByText("Updated the battery extension")).toBeTruthy();
    expect(screen.queryByText(/Added/)).toBeNull();
  });

  it("labels a layout-only change as Updated the layout", async () => {
    installMenuSproutAgentMock();
    window.menuSprout!.agent.send = vi.fn(async (): Promise<AgentChatResult> => ({
      assistantText: "Done.",
      session: {
        startedClean: true,
        canSave: true,
        canRollback: true,
        head: null,
        dirty: true,
        changes: [{ type: "layout", kind: "updated" }],
      },
    }));
    render(<AgentChat />);

    const composer = screen.getByPlaceholderText("talk to the sprout");
    fireEvent.change(composer, { target: { value: "add a bit more margin between the two columns" } });
    fireEvent.submit(composer.closest("form")!);

    expect(await screen.findByText("Updated the layout")).toBeTruthy();
  });

  it("says no changes were made when the agent edited nothing", async () => {
    installMenuSproutAgentMock();
    window.menuSprout!.agent.send = vi.fn(async (): Promise<AgentChatResult> => ({
      assistantText: "All set!",
      session: { startedClean: true, canSave: true, canRollback: true, head: null, dirty: false, changes: [] },
    }));
    render(<AgentChat />);

    const composer = screen.getByPlaceholderText("talk to the sprout");
    fireEvent.change(composer, { target: { value: "add a bit more margin between the two columns" } });
    fireEvent.submit(composer.closest("form")!);

    expect(await screen.findByText("No changes were made")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Keep" })).toBeNull();
  });

  it("clears the session bar after Keep without a kept confirmation", async () => {
    installMenuSproutAgentMock({
      session: {
        startedClean: true,
        canSave: true,
        canRollback: true,
        head: null,
        message: "Review the generated changes, then Save or Rollback.",
      },
    });
    window.menuSprout!.git.save = vi.fn(async () => ({ ok: true }));
    render(<AgentChat />);

    const keep = await screen.findByRole("button", { name: "Keep" });
    await act(async () => {
      fireEvent.click(keep);
    });

    expect(screen.queryByRole("button", { name: "Keep" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect(screen.queryByText(/Kept/)).toBeNull();
    expect(screen.getByPlaceholderText("talk to the sprout")).toBeTruthy();
  });

  it("does not show a prompt when no change session is open on mount", async () => {
    const agent = installMenuSproutAgentMock({ session: null });
    render(<AgentChat />);

    // Let the mount-time git.status() resolve before asserting absence.
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByRole("button", { name: "Keep" })).toBeNull();
    expect(screen.getByPlaceholderText("talk to the sprout")).toBeTruthy();
    void agent;
  });
});

function sendPrompt(text: string) {
  const composer = screen.getByPlaceholderText("talk to the sprout");
  fireEvent.change(composer, { target: { value: text } });
  fireEvent.submit(composer.closest("form")!);
}

function deferredResult() {
  let resolve!: (result: AgentChatResult) => void;
  const promise = new Promise<AgentChatResult>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const cleanSession: GitSessionSnapshot = {
  startedClean: true,
  canSave: true,
  canRollback: true,
  head: null,
  dirty: false,
  changes: [],
};

const partialSession: GitSessionSnapshot = {
  startedClean: true,
  canSave: true,
  canRollback: true,
  head: null,
  dirty: true,
  changes: [{ type: "extension", extensionId: "battery", kind: "updated" }],
};

describe("AgentChat final reply", () => {
  it.each([cleanSession, partialSession])("shows a refusal reply collapsed beside its failure notice with dirty=$dirty", async (session) => {
    installMenuSproutAgentMock();
    const text = "I cannot make that change. Please choose another request.";
    window.menuSprout!.agent.send = vi.fn(async (): Promise<AgentChatResult> => ({
      assistantText: "Agent refused the request.",
      refused: true,
      reply: text,
      session,
    }));
    render(<AgentChat />);
    sendPrompt("make an edit");

    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.getByText("Agent unavailable")).toBeTruthy();
    expect(screen.getByText("Agent refused the request.")).toBeTruthy();
    expect(screen.queryByText("No changes were made")).toBeNull();
    const toggle = screen.getByRole("button", { name: "more" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "less" }).getAttribute("aria-expanded")).toBe("true");
    if (session.dirty) {
      expect(screen.getByRole("button", { name: "Keep" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    } else {
      expect(screen.queryByRole("button", { name: "Keep" })).toBeNull();
    }
  });

  it("shows only the failure notice for a refusal without a final reply", async () => {
    installMenuSproutAgentMock();
    window.menuSprout!.agent.send = vi.fn(async (): Promise<AgentChatResult> => ({
      assistantText: "Agent refused the request.", refused: true, session: cleanSession,
    }));
    render(<AgentChat />);
    sendPrompt("make an edit");

    expect(await screen.findByText("Agent refused the request.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "more" })).toBeNull();
    expect(screen.queryByText("No changes were made")).toBeNull();
  });

  it("shows the latest turn's final reply collapsed, and expands it on demand", async () => {
    installMenuSproutAgentMock();
    window.menuSprout!.agent.send = vi.fn(async (): Promise<AgentChatResult> => ({
      assistantText: "Let me check.Which battery source should the widget read: pmset or ioreg?",
      reply: "Which battery source should the widget read: pmset or ioreg?",
      session: cleanSession,
    }));
    render(<AgentChat />);

    sendPrompt("add a battery widget");

    const reply = await screen.findByText("Which battery source should the widget read: pmset or ioreg?");
    expect(screen.queryByText(/Let me check/)).toBeNull();
    const toggle = screen.getByRole("button", { name: "more" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(reply.closest(".reply")?.classList.contains("expanded")).toBe(false);

    fireEvent.click(toggle);

    expect(screen.getByRole("button", { name: "less" }).getAttribute("aria-expanded")).toBe("true");
    expect(reply.closest(".reply")?.classList.contains("expanded")).toBe(true);
  });

  it("keeps only the latest turn's reply, never older turns", async () => {
    installMenuSproutAgentMock();
    const second = deferredResult();
    window.menuSprout!.agent.send = vi
      .fn()
      .mockResolvedValueOnce({ assistantText: "First answer.", reply: "First answer.", session: cleanSession })
      .mockReturnValueOnce(second.promise);
    render(<AgentChat />);

    sendPrompt("first question");
    expect(await screen.findByText("First answer.")).toBeTruthy();

    sendPrompt("second question");
    expect(await screen.findByText("› second question")).toBeTruthy();
    expect(screen.queryByText("First answer.")).toBeNull();

    await act(async () => {
      second.resolve({ assistantText: "Second answer.", reply: "Second answer.", session: cleanSession });
    });

    expect(screen.getByText("Second answer.")).toBeTruthy();
    expect(screen.queryByText("First answer.")).toBeNull();
    expect(document.querySelectorAll(".reply")).toHaveLength(1);
  });

  it("shows no reply when the agent said nothing", async () => {
    installMenuSproutAgentMock();
    window.menuSprout!.agent.send = vi.fn(async (): Promise<AgentChatResult> => ({
      assistantText: "Agent finished without a text response.",
      session: cleanSession,
    }));
    render(<AgentChat />);

    sendPrompt("tidy up");

    expect(await screen.findByText("No changes were made")).toBeTruthy();
    expect(document.querySelector(".reply")).toBeNull();
    expect(screen.queryByText("Agent finished without a text response.")).toBeNull();
  });
});

describe("AgentChat cancel", () => {
  it("keeps cancellation pending across polls of the same recovered turn", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const turn = { title: "add a battery widget", startedAt: Date.now() };
    installMenuSproutAgentMock({ activeTurn: turn });
    render(<AgentChat />);
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await act(async () => { fireEvent.click(cancel); });
    expect(screen.getByText("Cancelling...")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect(window.menuSprout!.agent.getActiveTurn).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Cancelling...")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);

    window.menuSprout!.agent.getActiveTurn = vi.fn(async () => ({ ...turn, startedAt: turn.startedAt + 1 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.queryByText("Cancelling...")).toBeNull();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers Cancel on the run strip and asks main to cancel the turn", async () => {
    installMenuSproutAgentMock();
    render(<AgentChat />);

    sendPrompt("add a battery widget");
    const cancel = await screen.findByRole("button", { name: "Cancel" });

    await act(async () => {
      fireEvent.click(cancel);
    });

    expect(window.menuSprout!.agent.cancel).toHaveBeenCalledOnce();
    expect(screen.getByText("Cancelling...")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("says the turn was cancelled and keeps partial changes for Keep or Undo", async () => {
    installMenuSproutAgentMock();
    window.menuSprout!.agent.send = vi.fn(async (): Promise<AgentChatResult> => ({
      assistantText: "The agent turn was cancelled.",
      cancelled: true,
      session: partialSession,
    }));
    render(<AgentChat />);

    sendPrompt("update the battery widget");

    expect(await screen.findByText("Cancelled")).toBeTruthy();
    expect(screen.getByText("partial changes kept - keep or undo them")).toBeTruthy();
    expect(screen.getByText("Updated the battery extension")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(screen.queryByText("No changes were made")).toBeNull();
    expect(document.querySelector(".reply")).toBeNull();
  });

  it("says nothing was changed when a cancelled turn edited nothing", async () => {
    installMenuSproutAgentMock();
    window.menuSprout!.agent.send = vi.fn(async (): Promise<AgentChatResult> => ({
      assistantText: "The agent turn was cancelled.",
      cancelled: true,
      session: cleanSession,
    }));
    render(<AgentChat />);

    sendPrompt("add a battery widget");

    expect(await screen.findByText("Cancelled")).toBeTruthy();
    expect(screen.getByText("nothing was changed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Keep" })).toBeNull();
    expect(screen.getByPlaceholderText("talk to the sprout")).toBeTruthy();
  });
});

describe("AgentChat turn budget", () => {
  it.each([
    ["time-limit", "Stopped: time limit"],
    ["tool-call-limit", "Stopped: tool-call limit"],
  ] as const)("says a %s stop truthfully and keeps partial changes for Keep or Undo", async (stoppedBy, summary) => {
    installMenuSproutAgentMock();
    window.menuSprout!.agent.send = vi.fn(async (): Promise<AgentChatResult> => ({
      assistantText: "The agent turn was stopped at its limit.",
      stoppedBy,
      session: partialSession,
      metrics: { durationMs: 600_000, toolCalls: 41 },
    }));
    render(<AgentChat />);

    sendPrompt("update the battery widget");

    expect(await screen.findByText(summary)).toBeTruthy();
    expect(screen.queryByText("Cancelled")).toBeNull();
    expect(screen.getByText("partial changes kept - keep or undo them")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Keep" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(screen.getByLabelText("last turn").textContent).toBe("10m 00s · 41 tool calls");
  });

  it("shows one compact line of measured numbers after a turn, with tokens only when reported", async () => {
    installMenuSproutAgentMock();
    window.menuSprout!.agent.send = vi
      .fn<() => Promise<AgentChatResult>>()
      .mockResolvedValueOnce({
        assistantText: "done",
        reply: "Added the widget.",
        session: cleanSession,
        metrics: {
          durationMs: 42_100,
          toolCalls: 7,
          tokens: { totalTokens: 24_031, inputTokens: 23_995, outputTokens: 36, cachedWriteTokens: 23_985 },
        },
      })
      .mockResolvedValueOnce({ assistantText: "done", reply: "Again.", session: cleanSession, metrics: { durationMs: 3_000, toolCalls: 0 } });
    render(<AgentChat />);

    sendPrompt("add a battery widget");
    const line = await screen.findByLabelText("last turn");
    expect(line.textContent).toBe("42.1s · 7 tool calls · 24,031 tokens");
    expect(line.getAttribute("title")).toBe("input 23,995 (cache write 23,985) · output 36 · as reported by the agent");

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    sendPrompt("again");
    await waitFor(() => expect(screen.getByLabelText("last turn").textContent).toBe("3.0s · 0 tool calls"));
    expect(screen.getByLabelText("last turn").textContent).not.toContain("tokens");
  });

  it("shows no metrics line when the turn reported none", async () => {
    installMenuSproutAgentMock();
    window.menuSprout!.agent.send = vi.fn(async (): Promise<AgentChatResult> => ({ assistantText: "blocked", session: cleanSession }));
    render(<AgentChat />);

    sendPrompt("add a battery widget");
    await screen.findByText("No changes were made");
    expect(screen.queryByLabelText("last turn")).toBeNull();
  });
});

describe("New conversation", () => {
  it("keeps the last reply when resetting the persisted conversation fails", async () => {
    installMenuSproutAgentMock();
    const reply = "Which battery source should the widget read?";
    window.menuSprout!.agent.send = vi.fn(async () => ({ assistantText: reply, reply, session: cleanSession }));
    window.menuSprout!.agent.newConversation = vi.fn(async () => ({
      ok: false, reason: "Could not reset the saved agent conversation.",
    }));
    render(<App />);
    sendPrompt("add a battery widget");
    await screen.findByText(reply);
    await act(async () => { fireEvent.click(screen.getByLabelText("new conversation")); });

    expect(screen.getByText(reply)).toBeTruthy();
    expect(screen.getByText("Could not reset the saved agent conversation.")).toBeTruthy();
    expect(screen.queryByText("New conversation")).toBeNull();
    expect(screen.getByRole("button", { name: "more" }).getAttribute("aria-expanded")).toBe("false");
  });

  it.each([true, false])("blocks sending while reset is pending and restores the composer after ok=%s", async (ok) => {
    installMenuSproutAgentMock();
    let finish!: (value: { ok: boolean; reason?: string }) => void;
    window.menuSprout!.agent.newConversation = vi.fn(() => new Promise<{ ok: boolean; reason?: string }>((resolve) => { finish = resolve; }));
    window.menuSprout!.agent.send = vi.fn(async () => ({ assistantText: "Done.", session: cleanSession }));
    render(<App />);
    await act(async () => { fireEvent.click(screen.getByLabelText("new conversation")); });
    const composer = screen.getByPlaceholderText("talk to the sprout") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "add a battery widget" } });
    expect((screen.getByRole("button", { name: "send" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("new conversation") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(composer.closest("form")!);
    expect(window.menuSprout!.agent.send).not.toHaveBeenCalled();
    expect(composer.value).toBe("add a battery widget");

    await act(async () => { finish({ ok, reason: ok ? undefined : "Could not reset" }); });
    expect((screen.getByRole("button", { name: "send" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.submit(composer.closest("form")!);
    await waitFor(() => expect(window.menuSprout!.agent.send).toHaveBeenCalledWith("add a battery widget"));
  });

  it("starts a fresh conversation from the header and clears the last reply", async () => {
    installMenuSproutAgentMock();
    window.menuSprout!.agent.send = vi.fn(async (): Promise<AgentChatResult> => ({
      assistantText: "Done.",
      reply: "Which battery source should the widget read?",
      session: cleanSession,
    }));
    render(<App />);

    sendPrompt("add a battery widget");
    expect(await screen.findByText("Which battery source should the widget read?")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("new conversation"));
    });

    expect(window.menuSprout!.agent.newConversation).toHaveBeenCalledOnce();
    expect(screen.queryByText("Which battery source should the widget read?")).toBeNull();
    expect(screen.getByText("New conversation")).toBeTruthy();
  });

  it("refuses a new conversation while a Keep/Undo change is pending", async () => {
    installMenuSproutAgentMock({ session: partialSession });
    render(<App />);
    await screen.findByRole("button", { name: "Keep" });

    await act(async () => {
      fireEvent.click(screen.getByLabelText("new conversation"));
    });

    expect(window.menuSprout!.agent.newConversation).not.toHaveBeenCalled();
    expect(screen.getByText("Finish this change first")).toBeTruthy();
    expect(screen.getByText("keep or undo before starting a new conversation")).toBeTruthy();
  });

  it("disables New conversation while a turn runs", async () => {
    installMenuSproutAgentMock();
    render(<App />);

    sendPrompt("add a battery widget");
    await screen.findByText("› add a battery widget");

    expect((screen.getByLabelText("new conversation") as HTMLButtonElement).disabled).toBe(true);
  });

  it("surfaces main's reason when a new conversation is refused", async () => {
    installMenuSproutAgentMock();
    window.menuSprout!.agent.newConversation = vi.fn(async () => ({
      ok: false,
      reason: "Agent is running. Cancel it or wait for it to finish first.",
    }));
    render(<App />);

    await act(async () => {
      fireEvent.click(screen.getByLabelText("new conversation"));
    });

    expect(screen.getByText("Could not start a new conversation")).toBeTruthy();
    expect(screen.getByText("Agent is running. Cancel it or wait for it to finish first.")).toBeTruthy();
  });
});
