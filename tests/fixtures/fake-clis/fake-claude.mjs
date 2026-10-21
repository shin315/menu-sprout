#!/usr/bin/env node
// Minimal fake of `claude -p [--resume <id>] <prompt> --output-format stream-json --verbose`.
// Emits stream-json events mirroring the real flat shape, then exits (the driver
// runs one process per turn). Echoes whether it was resumed so the driver's
// session threading can be asserted. Kept in sync with
// tests/fixtures/protocols/claude/*.jsonl.
// Special SLOW_* prompts are test controls for cancellation and child-process
// termination behavior rather than captured protocol fixtures.
import { existsSync, writeFileSync } from "node:fs";
import { startToolTree } from "./tool-tree.mjs";

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

const argv = process.argv.slice(2);
// Optional arg capture so driver tests can assert which flags were passed.
if (process.env.FAKE_CLAUDE_ARGS_FILE) {
  writeFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, JSON.stringify(argv));
}
const resumeIdx = argv.indexOf("--resume");
const isResume = resumeIdx >= 0;
// The prompt is the final positional arg.
const prompt = argv[argv.length - 1] ?? "";

if (prompt.includes("TOOL_TREE")) {
  await startToolTree(prompt);
  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ready" }] } });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

if (prompt.includes("PROVIDER_AUTH_ERROR")) {
  emit({ type: "system", subtype: "init", session_id: "fake-session", model: "fake", cwd: process.cwd() });
  emit({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    result: "401 Unauthorized: Missing bearer authentication sk-private-fixture",
    session_id: "fake-session",
  });
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
  emit({ type: "system", subtype: "init", session_id: "fake-session", model: "fake", cwd: process.cwd() });
  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ready" }] } });
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
  emit({ type: "system", subtype: "init", session_id: "fake-session", model: "fake", cwd: process.cwd() });
  emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ready" }] } });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

if (prompt.includes("MODEL_REJECTED")) {
  // Real claude 2.1.x with an unknown --model: a synthetic assistant message and
  // an error result naming the model, then exit 1.
  const text = "There's an issue with the selected model (bogus-model). It may not exist or you may not have access to it. Run --model to pick a different model.";
  emit({ type: "system", subtype: "init", session_id: "fake-session", model: "bogus-model", cwd: process.cwd() });
  emit({ type: "assistant", message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text }] } });
  emit({ type: "result", subtype: "success", is_error: true, api_error_status: 404, result: text, session_id: "fake-session" });
  process.exit(1);
}

if (prompt.includes("UNKNOWN_EFFORT")) {
  // Real claude 2.1.x with an unknown --effort value warns on stderr and then
  // runs the turn at its default effort. Linger so the driver can stop it.
  process.stderr.write("Warning: Unknown --effort value 'bogus' \u2014 ignoring it and using the default effort. Valid values: low, medium, high, xhigh, max.\n");
  emit({ type: "system", subtype: "init", session_id: "fake-session", model: "fake", cwd: process.cwd() });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

// Real claude emits SessionStart hook noise + an init line carrying session_id.
emit({ type: "system", subtype: "hook_started", hook_name: "SessionStart" });
emit({ type: "system", subtype: "init", session_id: "fake-session", model: "fake", cwd: process.cwd() });

if (prompt.includes("RUN_TOOL")) {
  emit({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_fake", name: "Bash", input: { command: "echo hi" } }] },
  });
  emit({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_fake", is_error: false, content: "hi" }] },
  });
}

const reply = isResume ? `resumed:${prompt}` : `echo:${prompt}`;
emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }] } });
// Real claude reports the usage of this one `claude -p` run on the result;
// input_tokens excludes the cache reads and writes beside it.
const usage = prompt.includes("NO_USAGE")
  ? undefined
  : {
      input_tokens: 10,
      cache_creation_input_tokens: 2000,
      cache_read_input_tokens: 300,
      output_tokens: 40,
      output_tokens_details: { thinking_tokens: 12 },
    };
emit({ type: "result", subtype: "success", is_error: false, result: reply, stop_reason: "end_turn", session_id: "fake-session", ...(usage ? { usage } : {}) });
process.exit(0);
