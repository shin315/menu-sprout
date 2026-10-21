import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { existsSync, watch } from "node:fs";
import { describe, expect, it, afterEach } from "vitest";
import { AntigravityDriver } from "../src/adapters/antigravity/driver";
import type * as schema from "@agentclientprotocol/sdk";

const FAKE = join(__dirname, "fixtures", "fake-clis", "fake-agy.mjs");

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
  const dir = await mkdtemp(join(tmpdir(), "agy-driver-"));
  const sentinel = join(dir, "release-exit");
  const terminated = join(dir, "observed-sigterm");
  return { prompt: `SLOW_CANCEL:${sentinel}:${terminated}`, terminated: waitForFile(terminated), release: () => writeFile(sentinel, "") };
}

function chunkText(updates: schema.SessionUpdate[]): string {
  return updates
    .filter((u): u is Extract<schema.SessionUpdate, { sessionUpdate: "agent_message_chunk" }> => u.sessionUpdate === "agent_message_chunk")
    .map((u) => (u.content.type === "text" ? u.content.text : ""))
    .join("");
}

describe("AntigravityDriver (against a fake agy CLI)", () => {
  let driver: AntigravityDriver | null = null;
  afterEach(async () => {
    await driver?.dispose();
    driver = null;
  });

  function makeDriver(): AntigravityDriver {
    driver = new AntigravityDriver({ command: FAKE });
    return driver;
  }

  async function captureArgs(run: (argsFile: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "agy-args-"));
    process.env.FAKE_AGY_ARGS_FILE = join(dir, "args.json");
    try {
      await run(process.env.FAKE_AGY_ARGS_FILE);
    } finally {
      delete process.env.FAKE_AGY_ARGS_FILE;
    }
  }

  it("streams assistant chunks incrementally and resolves end_turn", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const updates: schema.SessionUpdate[] = [];
    const stop = await d.prompt("hello", (u) => updates.push(u), new AbortController().signal);
    expect(stop).toBe("end_turn");
    // The reply arrives as an ACTIVE delta plus a DONE remainder, not one blob.
    expect(updates.filter((u) => u.sessionUpdate === "agent_message_chunk").length).toBeGreaterThan(1);
    expect(chunkText(updates)).toBe("echo:hello");
  });

  it("runs in print mode with approve-all and no stdin", async () => {
    await captureArgs(async (argsFile) => {
      const d = makeDriver();
      await d.start(tmpdir());
      await d.prompt("hello", () => {}, new AbortController().signal);
      const args = JSON.parse(await readFile(argsFile, "utf8")) as string[];
      expect(args.slice(0, 2)).toEqual(["-p", "hello"]);
      expect(args).toEqual(expect.arrayContaining(["--output-format", "stream-json", "--dangerously-skip-permissions"]));
      expect(args).not.toContain("--conversation");
    });
  });

  it("resumes the conversation on the second prompt (carries memory)", async () => {
    await captureArgs(async (argsFile) => {
      const d = makeDriver();
      await d.start(tmpdir());
      const s = new AbortController().signal;
      await d.prompt("first", () => {}, s);
      const updates: schema.SessionUpdate[] = [];
      await d.prompt("second", (u) => updates.push(u), s);
      // The fake replies "resumed:..." only when invoked with --conversation <id>,
      // proving the driver captured the id from the first turn and threaded it.
      expect(chunkText(updates)).toBe("resumed:second");
      const args = JSON.parse(await readFile(argsFile, "utf8")) as string[];
      expect(args[args.indexOf("--conversation") + 1]).toBe("fake-conversation");
    });
  });

  it("surfaces a tool_call and tool_call_update for a tool step", async () => {
    const d = makeDriver();
    await d.start(tmpdir());
    const updates: schema.SessionUpdate[] = [];
    await d.prompt("please RUN_TOOL now", (u) => updates.push(u), new AbortController().signal);
    expect(updates.filter((u) => u.sessionUpdate === "tool_call")).toHaveLength(1);
    expect(updates.find((u) => u.sessionUpdate === "tool_call_update")).toMatchObject({ status: "completed" });
  });

  it("rejects a nonzero CLI exit with a typed sanitized error", async () => {
    const d = makeDriver();
    await d.start(tmpdir());

    const prompt = d.prompt("EXIT_NONZERO", () => {}, new AbortController().signal);
    await expect(prompt).rejects.toMatchObject({
      name: "AdapterTurnError",
      code: "CLI_EXIT_FAILED",
      message: "Antigravity CLI exited with code 42.",
    });
    await expect(prompt).rejects.not.toThrow(/private detail/);
  });

  it("rejects a provider error result with a sanitized message", async () => {
    const d = makeDriver();
    await d.start(tmpdir());

    const prompt = d.prompt("RESULT_ERROR", () => {}, new AbortController().signal);
    await expect(prompt).rejects.toMatchObject({
      name: "AdapterTurnError",
      code: "PROVIDER_FAILED",
      message: "Antigravity provider failed the request.",
    });
    await expect(prompt).rejects.not.toThrow(/private detail/);
  });

  it("rejects an authentication failure result with sign-in guidance", async () => {
    const d = makeDriver();
    await d.start(tmpdir());

    const prompt = d.prompt("AUTH_ERROR_RESULT", () => {}, new AbortController().signal);
    await expect(prompt).rejects.toMatchObject({
      name: "AdapterTurnError",
      code: "AUTHENTICATION_FAILED",
      message: "Antigravity is not authenticated. Open Antigravity (`agy`) and sign in, then try again.",
    });
    await expect(prompt).rejects.not.toThrow(/sk-private-fixture/);
  });

  it("fails fast with sign-in guidance when agy is signed out and waiting for an OAuth code", async () => {
    // A signed-out agy prints its sign-in prompt to stderr and then blocks for up
    // to 60s. The driver must not wait that out (the fake only exits on SIGTERM
    // or after 30s, so a hang would blow the test timeout).
    const d = makeDriver();
    await d.start(tmpdir());

    await expect(d.prompt("SIGNED_OUT", () => {}, new AbortController().signal)).rejects.toMatchObject({
      name: "AdapterTurnError",
      code: "AUTHENTICATION_FAILED",
      message: "Antigravity is not authenticated. Open Antigravity (`agy`) and sign in, then try again.",
    });
  }, 10_000);

  it("does not treat sign-in wording on stderr after the turn started as signed out", async () => {
    // Tools and MCP servers inside a signed-in turn may log sign-in wording about
    // other services; the turn must not be killed as an Antigravity sign-out.
    const d = makeDriver();
    await d.start(tmpdir());
    const dir = await mkdtemp(join(tmpdir(), "agy-noise-"));
    const gate = join(dir, "started");
    const updates: schema.SessionUpdate[] = [];
    const stop = await d.prompt(
      `STDERR_NOISE:${gate}`,
      (u) => {
        updates.push(u);
        if (u.sessionUpdate === "agent_message_chunk") void writeFile(gate, "");
      },
      new AbortController().signal,
    );
    expect(stop).toBe("end_turn");
    expect(chunkText(updates)).toBe("ready, done");
  });

  it("rejects with a start failure when the agy binary does not exist", async () => {
    driver = new AntigravityDriver({ command: join(tmpdir(), "definitely-not-agy") });
    await driver.start(tmpdir());

    await expect(driver.prompt("hi", () => {}, new AbortController().signal)).rejects.toMatchObject({
      name: "AdapterTurnError",
      code: "CLI_START_FAILED",
      message: "Antigravity CLI could not be started.",
    });
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
    // SIGKILL after the grace period terminates it.
    await d.dispose();
    expect(await prompt).toBe("cancelled");
  });

  it.each([
    ["agy outlives the grace period", "TOOL_CHILD"],
    ["agy exits on SIGTERM", "TOOL_CHILD_EXIT"],
  ])("stops the tool commands agy was running when a turn is cancelled (%s)", async (_case, control) => {
    const d = makeDriver();
    await d.start(tmpdir());
    const pidFile = join(await mkdtemp(join(tmpdir(), "agy-tool-")), "tool.pid");
    const ac = new AbortController();
    let ready!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const prompt = d.prompt(
      `${control}:${pidFile}`,
      (u) => {
        if (u.sessionUpdate === "tool_call") ready();
      },
      ac.signal,
    );
    await readyPromise;
    const toolPid = Number(await readFile(pidFile, "utf8"));

    ac.abort();
    expect(await prompt).toBe("cancelled");
    // The orphaned command is reaped asynchronously once it is killed.
    const deadline = Date.now() + 2000;
    while (isAlive(toolPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(isAlive(toolPid)).toBe(false);
  });
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("AntigravityDriver model, effort, and usage", () => {
  let driver: AntigravityDriver | null = null;
  afterEach(async () => {
    await driver?.dispose();
    driver = null;
  });

  it("passes the chosen model and effort as agy's own --model and --effort flags", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agy-args-"));
    const argsFile = join(dir, "args.json");
    process.env.FAKE_AGY_ARGS_FILE = argsFile;
    try {
      driver = new AntigravityDriver({ command: FAKE, model: "gemini-3.1-pro-high", effort: "low" });
      await driver.start(tmpdir());
      await driver.prompt("hello", () => {}, new AbortController().signal);
      const args = JSON.parse(await readFile(argsFile, "utf8")) as string[];
      expect(args[args.indexOf("--model") + 1]).toBe("gemini-3.1-pro-high");
      expect(args[args.indexOf("--effort") + 1]).toBe("low");

      driver = new AntigravityDriver({ command: FAKE });
      await driver.start(tmpdir());
      await driver.prompt("hello", () => {}, new AbortController().signal);
      const defaults = JSON.parse(await readFile(argsFile, "utf8")) as string[];
      expect(defaults).not.toContain("--model");
      expect(defaults).not.toContain("--effort");
    } finally {
      delete process.env.FAKE_AGY_ARGS_FILE;
    }
  });

  it.each([
    ["MODEL_REJECTED", "Antigravity did not accept the model it was asked to use. Choose another model for Antigravity in Settings."],
    [
      "EFFORT_REJECTED",
      "Antigravity did not accept the effort level it was asked to use. Choose another effort for Antigravity in Settings, or CLI default.",
    ],
  ])("turns agy's %s model selection error into a clear message", async (code, message) => {
    driver = new AntigravityDriver({ command: FAKE });
    await driver.start(tmpdir());
    await expect(driver.prompt(code, () => {}, new AbortController().signal)).rejects.toMatchObject({ code, message });
  });

  it("reports each turn's own usage from agy's running conversation totals", async () => {
    driver = new AntigravityDriver({ command: FAKE });
    await driver.start(tmpdir());
    const s = new AbortController().signal;
    const usage: schema.Usage[] = [];
    await driver.prompt("first", () => {}, s, (reported) => usage.push(reported));
    await driver.prompt("second", () => {}, s, (reported) => usage.push(reported));
    expect(usage).toEqual([
      { inputTokens: 200, outputTokens: 25, totalTokens: 225, cachedReadTokens: 0, thoughtTokens: 10 },
      { inputTokens: 190, outputTokens: 25, totalTokens: 215, cachedReadTokens: 160, thoughtTokens: 10 },
    ]);
  });

  it("omits usage rather than guessing once an earlier turn in the conversation reported none", async () => {
    driver = new AntigravityDriver({ command: FAKE });
    await driver.start(tmpdir());
    const s = new AbortController().signal;
    const usage: schema.Usage[] = [];
    await driver.prompt("first NO_USAGE", () => {}, s, (reported) => usage.push(reported));
    await driver.prompt("second", () => {}, s, (reported) => usage.push(reported));
    expect(usage).toEqual([]);
  });
});
