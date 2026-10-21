import { runAdapter } from "../shared/acp-agent.js";
import { parseAdapterArgs } from "../shared/adapter-args.js";
import { AntigravityDriver } from "./driver.js";

// Entry point: acpx spawns `node <this> [--model <id>] [--effort <level>]` and
// speaks ACP over stdio. The host appends those arguments from Settings.
runAdapter(new AntigravityDriver(parseAdapterArgs(process.argv.slice(2))), "antigravity-adapter");
