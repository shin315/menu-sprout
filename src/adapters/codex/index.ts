import { runAdapter } from "../shared/acp-agent.js";
import { parseAdapterArgs } from "../shared/adapter-args.js";
import { CodexDriver } from "./driver.js";
import { readCodexModel } from "./config.js";

// Entry point: acpx spawns `node <this> [--model <id>] [--effort <level>]` and
// speaks ACP over stdio. The host appends those arguments from Settings.
// Without a model from Settings, we still run codex with --ignore-user-config to
// stay lean, which also discards the user's configured model, so read just that
// one setting back and pass it as --model. Without it, codex defaults to a model
// unsupported on ChatGPT-account logins and every turn dies with a 400.
const options = parseAdapterArgs(process.argv.slice(2));
runAdapter(
  new CodexDriver({ model: options.model ?? readCodexModel() ?? undefined, effort: options.effort }),
  "codex-adapter",
);
