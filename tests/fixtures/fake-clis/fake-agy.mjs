#!/usr/bin/env node
// Minimal fake of `agy -p <prompt> --output-format stream-json [--conversation <id>]`.
// Emits stream-json events mirroring the real shapes recorded from Antigravity
// CLI 1.2.x (init, step_update for user_input/agent_response/tool, result), then
// exits (print mode is one-shot per turn). Resume is proved by echoing
// "resumed:" only when invoked with `--conversation <id>`.
// Special prompt keywords are test controls for failure, cancellation and
// child-process termination behavior.
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

const argv = process.argv.slice(2);
// Optional arg capture so driver tests can assert which flags were passed.
if (process.env.FAKE_AGY_ARGS_FILE) {
  writeFileSync(process.env.FAKE_AGY_ARGS_FILE, JSON.stringify(argv));
}
const prompt = argv[argv.indexOf("-p") + 1] ?? "";
const conversationFlag = argv.indexOf("--conversation");
const isResume = conversationFlag >= 0;
const conversationId = isResume ? argv[conversationFlag + 1] : "fake-conversation";

const result = (fields) =>
  emit({
    event: "result",
    result: { conversation_id: conversationId, status: "SUCCESS", response: "", duration_seconds: 0, num_turns: 1, ...fields },
  });
const step = (fields) =>
  emit({ event: "step_update", step_update: { conversation_id: conversationId, ...fields } });

if (prompt.includes("EXIT_NONZERO")) {
  process.stderr.write("synthetic CLI failure with private detail\n");
  process.exit(42);
}

if (prompt.includes("SIGNED_OUT")) {
  // A signed-out agy prints the sign-in prompt to stderr and waits for an OAuth
  // code on stdin; it only exits when terminated (or after its own 60s timeout).
  process.on("SIGTERM", () => process.exit(1));
  process.stderr.write("Authentication required. Please visit the URL to log in:\n  https://example.invalid/oauth\n");
  setTimeout(() => process.exit(1), 30_000);
  await new Promise(() => {});
}

if (prompt.includes("AUTH_ERROR_RESULT")) {
  emit({
    event: "result",
    result: { conversation_id: "", status: "ERROR", response: "", error: "authentication failed or timed out sk-private-fixture" },
  });
  process.exit(1);
}

if (prompt.includes("RESULT_ERROR")) {
  emit({ event: "init", conversation_id: conversationId, init: { cwd: process.cwd(), tools: [] } });
  emit({
    event: "result",
    result: { conversation_id: conversationId, status: "ERROR", response: "", error: "model exploded with private detail" },
  });
  process.exit(1);
}

if (prompt.includes("MODEL_REJECTED") || prompt.includes("EFFORT_REJECTED")) {
  // Real agy 1.2.17 validates --model and --effort together before starting.
  const error = prompt.includes("EFFORT_REJECTED")
    ? 'invalid model selection (--model "" --effort "bogus"): invalid --effort "bogus" (valid: low, medium, high, xhigh, max)'
    : 'invalid model selection (--model "bogus-model" --effort ""): model bogus-model is not recognized as a known model or custom model in settings';
  process.stderr.write(`error: ${error}\n`);
  emit({ event: "result", result: { conversation_id: "", status: "ERROR", response: "", error, duration_seconds: 0, num_turns: 0 } });
  process.exit(1);
}

if (prompt.includes("SLOW_CANCEL")) {
  // Register the SIGTERM handler BEFORE announcing readiness (see fake-codex for
  // why), then exit only when the test creates the release file in the prompt.
  const [, releaseFile = null, terminatedFile = null] = prompt.match(/SLOW_CANCEL:(\S+):(\S+)/) ?? [];
  let terminating = false;
  process.on("SIGTERM", () => {
    terminating = true;
    if (terminatedFile) writeFileSync(terminatedFile, "");
  });
  emit({ event: "init", conversation_id: conversationId, init: { cwd: process.cwd(), tools: [] } });
  step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "ready" });
  setInterval(() => {
    if (terminating && (!releaseFile || existsSync(releaseFile))) process.exit(0);
  }, 5);
  await new Promise(() => {});
}

if (prompt.includes("STDERR_NOISE")) {
  // Once the driver has seen protocol events (the test creates the gate file on
  // the first chunk), log sign-in wording for some other service, then linger so
  // a driver that reacts to it has time to terminate the turn.
  const [, gateFile] = prompt.match(/STDERR_NOISE:(\S+)/) ?? [];
  emit({ event: "init", conversation_id: conversationId, init: { cwd: process.cwd(), tools: [] } });
  step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "ready" });
  while (!existsSync(gateFile)) await new Promise((resolve) => setTimeout(resolve, 5));
  process.stderr.write("Warning: not logged into example-service; sign in to continue using it\n");
  await new Promise((resolve) => setTimeout(resolve, 200));
  step({ step_index: 1, state: "DONE", step_type: "agent_response", text_delta: ", done" });
  result({ response: "ready, done" });
  process.exit(0);
}

if (prompt.includes("TOOL_CHILD")) {
  // Like real agy mid-tool: a shell command runs as agy's child in its own
  // session (agy gives each tool a pty). agy either does not exit within the
  // grace period after SIGTERM, or (TOOL_CHILD_EXIT) exits without reaping it.
  const [, exitOnSigterm, pidFile] = prompt.match(/TOOL_CHILD(_EXIT)?:(\S+)/) ?? [];
  process.on("SIGTERM", () => {
    if (exitOnSigterm) process.exit(1);
  });
  const tool = spawn("sleep", ["60"], { stdio: "ignore", detached: true });
  writeFileSync(pidFile, String(tool.pid));
  emit({ event: "init", conversation_id: conversationId, init: { cwd: process.cwd(), tools: [] } });
  step({ step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "sleep 60" } } });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

if (prompt.includes("SLOW_FORCE_KILL")) {
  process.on("SIGTERM", () => {});
  emit({ event: "init", conversation_id: conversationId, init: { cwd: process.cwd(), tools: [] } });
  step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "ready" });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

emit({ event: "init", conversation_id: isResume ? undefined : conversationId, init: { cwd: process.cwd(), tools: [] } });
step({ step_index: 0, state: "DONE", step_type: "user_input" });

if (prompt.includes("RUN_TOOL")) {
  step({ step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "echo hi" } } });
  step({
    step_index: 1,
    state: "DONE",
    step_type: "tool",
    tool_name: "run_command",
    tool_info: { name: "run_command", parameters: { CommandLine: "echo hi" }, output: "hi\n" },
  });
}

const reply = isResume ? `resumed:${prompt}` : `echo:${prompt}`;
// Real agy streams the reply in ACTIVE deltas and ends with a DONE step that
// carries only the final remaining chunk.
const half = Math.ceil(reply.length / 2);
step({ step_index: 2, state: "ACTIVE", step_type: "agent_response", text_delta: reply.slice(0, half) });
step({ step_index: 2, state: "DONE", step_type: "agent_response", text_delta: reply.slice(half) });
// Real agy reports the conversation's running totals, so a resumed turn's usage
// includes every earlier turn (cache_read_tokens is beside input_tokens).
const usage = isResume
  ? { input_tokens: 230, output_tokens: 50, thinking_tokens: 20, cache_read_tokens: 160, total_tokens: 280 }
  : { input_tokens: 200, output_tokens: 25, thinking_tokens: 10, cache_read_tokens: 0, total_tokens: 225 };
result({ response: reply, ...(prompt.includes("NO_USAGE") ? {} : { usage }) });
process.exit(0);
