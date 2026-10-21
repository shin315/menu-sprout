import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type * as schema from "@agentclientprotocol/sdk";
import { AdapterTurnError, authenticationFailure, type SessionDriver, type UpdateSink } from "../shared/types.js";
import { LineReader } from "../shared/line-reader.js";
import { logDebug } from "../shared/log.js";
import { childEnv } from "../shared/child-env.js";
import { createAntigravityMapper, type AntigravityEvent } from "./mapper.js";
import { terminateProcessTree } from "../shared/process-tree.js";
import { ConversationUsage, toAcpUsage, type TokenCounts } from "../shared/usage.js";

const SCOPE = "antigravity-adapter";
const TERMINATION_GRACE_MS = 1000;

// A signed-out `agy -p` does not emit protocol events. It prints this prompt to
// stderr and waits (up to 60s) for an OAuth code on stdin, which we never send,
// so detect it before the first protocol event and fail fast with the sign-in
// guidance instead of hanging.
const SIGNED_OUT_PATTERN = /authentication required|visit the url to log in|not logged in|sign in to continue/i;

export type AntigravityDriverOptions = {
  /** Override the agy binary (tests inject a fake). Defaults to "agy". */
  command?: string;
  /** Passed as `--model`; undefined leaves the CLI's default. */
  model?: string;
  /** Passed as `--effort`; undefined leaves the CLI's default. */
  effort?: string;
};

/**
 * Drives `agy -p --output-format stream-json` per turn. The first turn runs
 * `agy -p <prompt>` and captures the conversation id from the stream; later
 * turns add `--conversation <id>` so conversation memory carries over.
 *
 * Antigravity has no ACP mode, so this is the thinnest bridge over its headless
 * print mode: one short-lived child per turn, text streamed as it arrives, and
 * cancellation by terminating the child. menu-sprout is approve-all and agy edits
 * cwd directly (captured by the change-session snapshot), so we pass
 * `--dangerously-skip-permissions`.
 */
export class AntigravityDriver implements SessionDriver {
  private readonly command: string;
  private readonly optionArgs: string[];
  private cwd: string | null = null;
  private conversationId: string | null = null;
  private usage = new ConversationUsage();
  private child: ChildProcessWithoutNullStreams | null = null;
  private activePrompt: Promise<schema.StopReason> | null = null;
  private activeCancel: (() => void) | null = null;

  constructor(options: AntigravityDriverOptions = {}) {
    this.command = options.command ?? "agy";
    this.optionArgs = [
      ...(options.model ? ["--model", options.model] : []),
      ...(options.effort ? ["--effort", options.effort] : []),
    ];
  }

  async start(cwd: string): Promise<void> {
    this.cwd = cwd;
  }

  async prompt(
    text: string,
    sink: UpdateSink,
    signal: AbortSignal,
    onUsage?: (usage: schema.Usage) => void,
  ): Promise<schema.StopReason> {
    const cwd = this.cwd;
    if (!cwd) throw new Error("antigravity session not started");
    if (this.child) throw new Error("a prompt is already in progress");

    const args = [
      "-p",
      text,
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      // Keep the embedded agent to the prompt we send rather than expanding
      // user-level slash commands and skills.
      "--disable-slash-commands",
      ...this.optionArgs,
      ...(this.conversationId ? ["--conversation", this.conversationId] : []),
    ];

    logDebug(SCOPE, "spawn", this.command, this.conversationId ? "(resume)" : "(new)", "<prompt>");
    // Own process group, so cancellation also stops the tool commands agy runs.
    const child = spawn(this.command, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: childEnv(), detached: true });
    this.child = child;
    // Never feed stdin: a signed-out agy would otherwise wait for an OAuth code.
    child.stdin.end();
    const reader = new LineReader();
    const mapEvent = createAntigravityMapper();

    const activePrompt = new Promise<schema.StopReason>((resolve, reject) => {
      let settled = false;
      let stopReason: schema.StopReason | null = null;
      let terminalError: AdapterTurnError | null = null;
      let cancelled = false;
      let protocolStarted = false;
      let termination: Promise<void> | null = null;
      let conversationTokens: TokenCounts | undefined;

      const finish = (done: () => void) => {
        if (settled) return;
        settled = true;
        this.child = null;
        this.activePrompt = null;
        this.activeCancel = null;
        signal.removeEventListener("abort", onAbort);
        done();
      };
      const settle = (reason: schema.StopReason) => finish(() => resolve(reason));
      const fail = (err: Error) => finish(() => reject(err));

      const terminate = () => {
        termination ??= terminateProcessTree(child.pid, TERMINATION_GRACE_MS);
      };
      const onAbort = () => {
        if (settled || cancelled) return;
        cancelled = true;
        logDebug(SCOPE, "cancel: killing agy");
        terminate();
      };
      this.activeCancel = onAbort;
      const onSignedOut = () => {
        if (terminalError?.code === "AUTHENTICATION_FAILED") return;
        terminalError = authenticationFailure("Antigravity");
        if (!cancelled) terminate();
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        for (const line of reader.push(chunk)) {
          let event: AntigravityEvent;
          try {
            event = JSON.parse(line) as AntigravityEvent;
          } catch {
            if (!protocolStarted && SIGNED_OUT_PATTERN.test(line)) onSignedOut();
            logDebug(SCOPE, "non-json stdout line");
            continue;
          }
          protocolStarted = true;
          // The driver owns conversation id capture (the mapper is pure/ACP-only).
          // Failed starts report an empty id, which must not clobber a good one.
          if (event.conversation_id) this.conversationId = event.conversation_id;
          if (event.result?.conversation_id) this.conversationId = event.result.conversation_id;
          const result = mapEvent(event);
          for (const update of result.updates) sink(update);
          // A typed sign-in failure from the stderr prompt outranks the generic
          // "authentication failed or timed out" result agy emits afterwards.
          if (result.terminalError && terminalError?.code !== "AUTHENTICATION_FAILED") {
            terminalError = result.terminalError;
          }
          if (result.stopReason) stopReason = result.stopReason;
          if (result.tokens) conversationTokens = result.tokens;
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        if (!protocolStarted && SIGNED_OUT_PATTERN.test(chunk)) onSignedOut();
        logDebug(SCOPE, "stderr", chunk.trimEnd());
      });
      child.on("error", async () => {
        if (termination) await termination;
        if (cancelled) settle("cancelled");
        else fail(new AdapterTurnError("CLI_START_FAILED", "Antigravity CLI could not be started."));
      });
      child.on("exit", async (code) => {
        logDebug(SCOPE, "agy exited", code);
        // agy reports conversation totals, so the turn's own usage is the change
        // since the last turn; a turn without totals leaves the next unknown.
        let turnTokens: TokenCounts | undefined;
        if (conversationTokens) turnTokens = this.usage.next(conversationTokens);
        else if (this.conversationId) this.usage.lose();
        if (termination) await termination;
        if (cancelled) {
          settle("cancelled");
          return;
        }
        if (terminalError) {
          fail(terminalError);
          return;
        }
        if (code !== 0) {
          fail(new AdapterTurnError("CLI_EXIT_FAILED", `Antigravity CLI exited with code ${code ?? "unknown"}.`));
          return;
        }
        if (turnTokens) onUsage?.(toAcpUsage(turnTokens));
        settle(stopReason ?? "end_turn");
      });
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    this.activePrompt = activePrompt;
    return activePrompt;
  }

  async dispose(): Promise<void> {
    const activePrompt = this.activePrompt;
    const activeCancel = this.activeCancel;
    if (activePrompt && activeCancel) {
      activeCancel();
      await activePrompt.catch(() => undefined);
      return;
    }
  }
}
