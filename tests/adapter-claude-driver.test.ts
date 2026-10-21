import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import { describe, expect, it, afterEach, vi } from "vitest";
import { ClaudeDriver } from "../src/adapters/claude/driver";
import type * as schema from "@agentclientprotocol/sdk";

const FAKE = join(__dirname, "fixtures", "fake-clis", "fake-claude.mjs");

function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(path), (_event, filename) => {
      if (filename === basename(path) && existsSync(path)) {
        watcher.close();
        resolve();
      }
    });
    watcher.on("error", (error) => {
      watcher.close();
      reject(error);
    });
  });
}

async function slowCancelGate(): Promise<{ prompt: string; terminated: Promise<void>; release: () => Promise<void> }> {
  // The fake CLI reports SIGTERM through one file and waits on the other before
  // exiting, which lets the tests assert ordering without wall-clock races.
  const dir = await mkdtemp(join(tmpdir(), "claude-driver-"));
  const sentinel = join(dir, "release-exit");
  const terminated = join(dir, "observed-sigterm");
  return { prompt: `SLOW_CANCEL:${sentinel}:${terminated}`, terminated: waitForFile(terminated), release: () => writeFile(sentinel, "") };
}

describe("ClaudeDriver (against a fake claude CLI)", () => {
  let driver: ClaudeDriver | null = null;
  afterEach(async () => {
    await driver?.dispose();
    driver = null;
  });

  function makeDriver(): ClaudeDriver {
    driver = new ClaudeDriver({ command: FAKE });
    return driver;
  }

  it("streams an assistant chunk and resolves end_turn", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const updates: schema.SessionUpdate[] = [];
    const stop = await d.prompt("hello", (u) => updates.push(u), new AbortController().signal);
    expect(stop).toBe("end_turn");
    expect(updates.find((u) => u.sessionUpdate === "agent_message_chunk")).toMatchObject({
      content: { type: "text", text: "echo:hello" },
    });
  });

  it("resumes the session on the second prompt (carries memory)", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const s = new AbortController().signal;
    await d.prompt("first", () => {}, s);
    const updates: schema.SessionUpdate[] = [];
    await d.prompt("second", (u) => updates.push(u), s);
    // The fake replies "resumed:..." only when invoked via `--resume <id>`,
    // proving the driver captured session_id and threaded it through.
    expect(updates.find((u) => u.sessionUpdate === "agent_message_chunk")).toMatchObject({
      content: { type: "text", text: "resumed:second" },
    });
  });

  it("rejects a terminal provider authentication failure with safe guidance", async () => {
    const d = makeDriver();
    await d.start(tmpdir());

    await expect(d.prompt("PROVIDER_AUTH_ERROR", () => {}, new AbortController().signal)).rejects.toMatchObject({
      name: "AdapterTurnError",
      code: "AUTHENTICATION_FAILED",
      message: "Claude is not authenticated. Run `claude` and complete sign-in, then try again.",
    });
  });

  it("surfaces a tool_call and tool_call_update", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const updates: schema.SessionUpdate[] = [];
    await d.prompt("please RUN_TOOL now", (u) => updates.push(u), new AbortController().signal);
    expect(updates.some((u) => u.sessionUpdate === "tool_call")).toBe(true);
    expect(updates.some((u) => u.sessionUpdate === "tool_call_update")).toBe(true);
  });

  it("resolves cancelled when the signal aborts before spawning", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const ac = new AbortController();
    ac.abort();
    expect(await d.prompt("hi", () => {}, ac.signal)).toBe("cancelled");
  });

  it("waits for the child process to exit before resolving cancellation", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const gate = await slowCancelGate();
    const ac = new AbortController();
    let ready!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const prompt = d.prompt(
      gate.prompt,
      (u) => {
        if (u.sessionUpdate === "agent_message_chunk") ready();
      },
      ac.signal,
    );
    await readyPromise;
    let released = false;
    let settled = false;
    const settlement = prompt.then((result) => {
      settled = true;
      return { result, released };
    });
    ac.abort();
    await gate.terminated;
    await Promise.resolve();
    expect(settled).toBe(false);

    released = true;
    await gate.release();
    expect(await settlement).toEqual({ result: "cancelled", released: true });
  });

  it("waits for the child process to exit before resolving disposal", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const gate = await slowCancelGate();
    let ready!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const prompt = d.prompt(
      gate.prompt,
      (u) => {
        if (u.sessionUpdate === "agent_message_chunk") ready();
      },
      new AbortController().signal,
    );
    await readyPromise;

    const disposal = d.dispose();
    let released = false;
    let disposed = false;
    const settlement = disposal.then(() => {
      disposed = true;
      return { released };
    });
    await gate.terminated;
    await Promise.resolve();
    expect(disposed).toBe(false);

    released = true;
    await gate.release();
    expect(await settlement).toEqual({ released: true });
    expect(disposed).toBe(true);
    expect(await prompt).toBe("cancelled");
  });

  it("force-kills a child that outlives the termination grace period", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    let ready!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const prompt = d.prompt(
      "SLOW_FORCE_KILL",
      (u) => {
        if (u.sessionUpdate === "agent_message_chunk") ready();
      },
      new AbortController().signal,
    );
    await readyPromise;

    // The child swallows SIGTERM, so disposal can only resolve once the driver's
    // SIGKILL after TERMINATION_GRACE_MS terminates it. Awaiting disposal is a
    // deterministic proof of force-kill: if it never fired, this would hang and
    // fail via the test timeout instead of flaking on a race window.
    await d.dispose();
    expect(await prompt).toBe("cancelled");
  });
});

describe("ClaudeDriver model, effort, and usage", () => {
  let driver: ClaudeDriver | null = null;
  afterEach(async () => {
    await driver?.dispose();
    driver = null;
  });

  async function argsFor(options: { model?: string; effort?: string }, prompt = "hello"): Promise<string[]> {
    const dir = await mkdtemp(join(tmpdir(), "claude-args-"));
    const argsFile = join(dir, "args.json");
    process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
    try {
      driver = new ClaudeDriver({ command: FAKE, ...options });
      await driver.start(tmpdir());
      await driver.prompt(prompt, () => {}, new AbortController().signal);
      return JSON.parse(await readFile(argsFile, "utf8")) as string[];
    } finally {
      delete process.env.FAKE_CLAUDE_ARGS_FILE;
    }
  }

  it("passes the chosen model and effort as claude's own --model and --effort flags", async () => {
    const args = await argsFor({ model: "sonnet", effort: "high" });
    expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
  });

  it("passes neither flag for CLI default", async () => {
    const args = await argsFor({});
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--effort");
  });

  it("fails with a clear message instead of running at the default effort when claude ignores --effort", async () => {
    driver = new ClaudeDriver({ command: FAKE, effort: "bogus" });
    await driver.start(tmpdir());
    await expect(driver.prompt("UNKNOWN_EFFORT", () => {}, new AbortController().signal)).rejects.toMatchObject({
      name: "AdapterTurnError",
      code: "EFFORT_REJECTED",
      message: "Claude did not accept the effort level it was asked to use. Choose another effort for Claude in Settings, or CLI default.",
    });
  });

  it("names a rejected model as the cause rather than a generic provider failure", async () => {
    driver = new ClaudeDriver({ command: FAKE, model: "bogus-model" });
    await driver.start(tmpdir());
    await expect(driver.prompt("MODEL_REJECTED", () => {}, new AbortController().signal)).rejects.toMatchObject({
      code: "MODEL_REJECTED",
      message: "Claude did not accept the model it was asked to use. Choose another model for Claude in Settings.",
    });
  });

  it("reports the turn's token usage from the result event, counting cache reads and writes as input", async () => {
    driver = new ClaudeDriver({ command: FAKE });
    await driver.start(tmpdir());
    const usage: schema.Usage[] = [];
    await driver.prompt("hello", () => {}, new AbortController().signal, (reported) => usage.push(reported));
    expect(usage).toEqual([
      { inputTokens: 2310, outputTokens: 40, totalTokens: 2350, cachedReadTokens: 300, cachedWriteTokens: 2000, thoughtTokens: 12 },
    ]);
  });

  it("reports no usage when claude does not report it", async () => {
    driver = new ClaudeDriver({ command: FAKE });
    await driver.start(tmpdir());
    const onUsage = vi.fn();
    await driver.prompt("NO_USAGE", () => {}, new AbortController().signal, onUsage);
    expect(onUsage).not.toHaveBeenCalled();
  });
});
