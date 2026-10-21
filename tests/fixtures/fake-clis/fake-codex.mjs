#!/usr/bin/env node
// Minimal fake of `codex exec --json [resume <id>] <prompt>`. Emits codex-exec
// JSONL mirroring the real flat shape, then exits (exec is one-shot per turn).
// Captures resume to prove the driver threads the thread id across turns.
// Kept in sync with tests/fixtures/protocols/codex/exec-*.jsonl.
// Special SLOW_* prompts are test controls for cancellation and child-process
// termination behavior rather than captured protocol fixtures.
import { existsSync, writeFileSync } from "node:fs";
import { startToolTree } from "./tool-tree.mjs";

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

const argv = process.argv.slice(2);
// Optional arg capture so driver tests can assert which flags were passed
// (e.g. --model). Overwritten on every invocation, so the last turn wins.
if (process.env.FAKE_CODEX_ARGS_FILE) {
  writeFileSync(process.env.FAKE_CODEX_ARGS_FILE, JSON.stringify(argv));
}
const isResume = argv[0] === "exec" && argv[1] === "resume";
// The prompt is the final positional arg.
const prompt = argv[argv.length - 1] ?? "";

if (prompt.includes("TOOL_TREE")) {
  await startToolTree(prompt);
  emit({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ready" } });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

// Mirror real codex-cli 0.130.0: `--color` is valid on `codex exec` but the
// `resume` subcommand rejects it with a clap usage error (exit code 2). The
// driver must not pass `--color` to resume.
if (isResume && argv.includes("--color")) {
  process.stderr.write("error: unexpected argument '--color' found\n");
  process.exit(2);
}

if (prompt.includes("EXIT_NONZERO")) {
  process.stderr.write("synthetic CLI failure with private detail\n");
  process.exit(42);
}

if (prompt.includes("PROVIDER_AUTH_ERROR")) {
  emit({ type: "thread.started", thread_id: "fake-thread" });
  emit({ type: "turn.started" });
  emit({ type: "error", message: "401 Unauthorized: Missing bearer authentication sk-private-fixture" });
  emit({ type: "turn.failed", message: "401 Unauthorized: Missing bearer authentication sk-private-fixture" });
  process.exit(1);
}

if (prompt.includes("MODEL_REJECTED")) {
  // Real codex-cli 0.159 with a model the account cannot use.
  const message = JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: "The 'bogus-model' model is not supported when using Codex with a ChatGPT account." } });
  emit({ type: "thread.started", thread_id: "fake-thread" });
  emit({ type: "turn.started" });
  emit({ type: "error", message });
  emit({ type: "turn.failed", error: { message } });
  process.exit(1);
}

if (prompt.includes("EFFORT_REJECTED")) {
  // Real codex-cli 0.159 with -c model_reasoning_effort="bogus".
  const message = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "[ReasoningEffortParam] [reasoning.effort] [invalid_enum_value] Invalid value: 'bogus'. Supported values are: 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', and 'max'." }, status: 400 });
  emit({ type: "thread.started", thread_id: "fake-thread" });
  emit({ type: "turn.started" });
  emit({ type: "error", message });
  emit({ type: "turn.failed", error: { message } });
  process.exit(1);
}

if (prompt.includes("SLOW_CANCEL")) {
  // Register the SIGTERM handler BEFORE announcing readiness. The parent reads
  // "ready" the instant the bytes hit the pipe and may fire SIGTERM while this
  // process is still mid-script; registering after the emit left a window where
  // SIGTERM hit Node's default action (immediate termination) and the child
  // died early. Once terminated, exit only when the test creates the sentinel
  // release file encoded in the prompt, so the driver's disposal
  // and cancellation promises stay pending until the test releases us - no
  // wall-clock race decides the outcome.
  const [, releaseFile = null, terminatedFile = null] = prompt.match(/SLOW_CANCEL:(\S+):(\S+)/) ?? [];
  let terminating = false;
  process.on("SIGTERM", () => {
    terminating = true;
    if (terminatedFile) writeFileSync(terminatedFile, "");
  });
  emit({ type: "thread.started", thread_id: "fake-thread" });
  emit({ type: "turn.started" });
  emit({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ready" } });
  setInterval(() => {
    if (terminating && (!releaseFile || existsSync(releaseFile))) process.exit(0);
  }, 5);
  await new Promise(() => {});
}

if (prompt.includes("SLOW_FORCE_KILL")) {
  // Swallow SIGTERM entirely so only the driver's SIGKILL after the termination
  // grace period can stop us. The test proves force-kill happened simply by
  // observing that disposal completes at all. Registered before "ready" for the
  // same reason as SLOW_CANCEL above.
  process.on("SIGTERM", () => {});
  emit({ type: "thread.started", thread_id: "fake-thread" });
  emit({ type: "turn.started" });
  emit({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: "ready" } });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

if (!isResume) {
  emit({ type: "thread.started", thread_id: "fake-thread" });
}
emit({ type: "turn.started" });
emit({ type: "item.completed", item: { id: "item_0", type: "reasoning", text: "**Thinking**" } });

if (prompt.includes("RUN_TOOL")) {
  emit({
    type: "item.completed",
    item: { id: "item_x", type: "command_execution", command: "echo hi", status: "completed", exit_code: 0, aggregated_output: "hi\n" },
  });
}

const reply = isResume ? `resumed:${prompt}` : `echo:${prompt}`;
emit({ type: "item.completed", item: { id: "item_1", type: "agent_message", text: reply } });
// Real codex reports the thread's running totals, so a resumed turn's usage
// includes every earlier turn (cached_input_tokens is part of input_tokens).
const usage = isResume
  ? { input_tokens: 250, cached_input_tokens: 140, cache_write_input_tokens: 0, output_tokens: 25, reasoning_output_tokens: 5 }
  : { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 2 };
emit({ type: "turn.completed", ...(prompt.includes("NO_USAGE") ? {} : { usage }) });
process.exit(0);
