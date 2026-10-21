/** The model and effort the host chose in Settings; absent means CLI default. */
export type AdapterModelOptions = {
  model?: string;
  effort?: string;
};

/**
 * Parses the adapter-level `--model <id>` and `--effort <level>` arguments the
 * host appends to a built-in adapter's launch command. The host validates the
 * values; each driver maps them to its own CLI's flags.
 */
export function parseAdapterArgs(argv: readonly string[]): AdapterModelOptions {
  const options: AdapterModelOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === "--model" && value) options.model = value;
    else if (argv[index] === "--effort" && value) options.effort = value;
    else continue;
    index += 1;
  }
  return options;
}
