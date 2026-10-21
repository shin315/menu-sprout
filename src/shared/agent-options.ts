import type { MenuSproutAgentModelSettings } from "./contracts";

// Model and effort choices for the built-in agents, and the optional per-turn
// limits. The host validates and persists these; the bundled adapters map them
// to each CLI's own flags (see src/adapters/*/driver.ts).

export type BuiltInAgentOptionName = "claude" | "codex" | "antigravity";

/** A built-in agent's saved choices. An absent field means "CLI default": nothing is passed. */
export type AgentModelOptions = {
  model?: string;
  effort?: string;
};

export type AgentModelOptionsMap = Partial<Record<BuiltInAgentOptionName, AgentModelOptions>>;

export type AgentOptionSpec = {
  /** Effort levels the CLI documents, in its own spelling. */
  efforts: readonly string[];
  /** Documented model aliases offered as suggestions; any model id is accepted. */
  modelSuggestions: readonly string[];
  /** The flags the adapter passes, for the Settings hint. */
  flags: string;
};

// Checked against each CLI's current help and docs: `claude --help` (2.1.x)
// lists --effort low|medium|high|xhigh|max and --model accepts the documented
// aliases or a full model name; `codex exec` takes --model and the reasoning
// effort as `-c model_reasoning_effort=...` (the values the Codex API accepts);
// `agy --help` (1.2.x) lists --model and --effort low|medium|high|xhigh|max.
export const AGENT_OPTION_SPECS: Record<BuiltInAgentOptionName, AgentOptionSpec> = {
  claude: {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    modelSuggestions: ["fable", "opus", "sonnet", "haiku"],
    flags: "--model, --effort",
  },
  codex: {
    efforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
    modelSuggestions: [],
    flags: "--model, -c model_reasoning_effort",
  },
  antigravity: {
    efforts: ["low", "medium", "high", "xhigh", "max"],
    modelSuggestions: [],
    flags: "--model, --effort",
  },
};

const AGENT_LABELS: Record<BuiltInAgentOptionName, string> = {
  claude: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
};

// A model id is one CLI argument: no whitespace or quotes, and never a leading
// dash, so it cannot be read as another flag.
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]*$/;
const MODEL_MAX_LENGTH = 100;

export function isBuiltInAgentOptionName(name: string): name is BuiltInAgentOptionName {
  return Object.prototype.hasOwnProperty.call(AGENT_OPTION_SPECS, name);
}

/** Why a saved model value cannot be passed to the CLI, or undefined when it can. */
export function modelProblem(agent: BuiltInAgentOptionName, model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  if (model.length > MODEL_MAX_LENGTH || !MODEL_PATTERN.test(model)) {
    return `${AGENT_LABELS[agent]} model "${model}" is not a valid model id. Use letters, numbers, and . _ : / @ [ ] - with no spaces, or CLI default.`;
  }
  return undefined;
}

/** Why a saved effort value cannot be passed to the CLI, or undefined when it can. */
export function effortProblem(agent: BuiltInAgentOptionName, effort: string | undefined): string | undefined {
  if (effort === undefined) return undefined;
  const { efforts } = AGENT_OPTION_SPECS[agent];
  if (!efforts.includes(effort)) {
    return `${AGENT_LABELS[agent]} effort "${effort}" is not one Menu Sprout can pass (${efforts.join(", ")}). Choose another level in Settings, or CLI default.`;
  }
  return undefined;
}

/** The first problem with an agent's saved options, so a turn can refuse to start instead of dropping it. */
export function agentOptionsProblem(agentName: string, options: AgentModelOptionsMap | undefined): string | undefined {
  if (!isBuiltInAgentOptionName(agentName)) return undefined;
  const saved = options?.[agentName];
  return modelProblem(agentName, saved?.model) ?? effortProblem(agentName, saved?.effort);
}

/**
 * Validates a Settings change. Empty strings mean CLI default and drop the field.
 * Throws an Error with a user-facing message for anything the CLI would not get.
 */
export function validateAgentOptionsInput(agentName: string, input: { model?: string; effort?: string }): AgentModelOptions {
  if (!isBuiltInAgentOptionName(agentName)) {
    throw new Error(`Model and effort can only be set for the built-in agents, not "${agentName}".`);
  }
  const model = input.model?.trim() || undefined;
  const effort = input.effort?.trim() || undefined;
  const problem = modelProblem(agentName, model) ?? effortProblem(agentName, effort);
  if (problem) throw new Error(problem);
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

/**
 * Normalizes options read back from preferences.json: keeps string values for
 * the built-in agents as saved, even unknown ones, so a removed or mistyped value
 * surfaces as a problem instead of silently falling back to CLI default.
 */
export function normalizeAgentModelOptions(value: unknown): AgentModelOptionsMap | undefined {
  if (!value || typeof value !== "object") return undefined;
  const normalized: AgentModelOptionsMap = {};
  for (const name of Object.keys(AGENT_OPTION_SPECS) as BuiltInAgentOptionName[]) {
    const entry = (value as Record<string, unknown>)[name];
    if (!entry || typeof entry !== "object") continue;
    const { model, effort } = entry as Record<string, unknown>;
    const options: AgentModelOptions = {
      ...(typeof model === "string" && model.trim() ? { model: model.trim() } : {}),
      ...(typeof effort === "string" && effort.trim() ? { effort: effort.trim() } : {}),
    };
    if (options.model || options.effort) normalized[name] = options;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * The adapter-level arguments appended to a built-in adapter's launch command.
 * Only valid values are passed; an invalid saved value blocks the turn instead
 * (see agentOptionsProblem), so nothing is silently dropped.
 */
export function adapterArgsForOptions(agent: BuiltInAgentOptionName, options: AgentModelOptions | undefined): string[] {
  const args: string[] = [];
  if (options?.model && !modelProblem(agent, options.model)) args.push("--model", options.model);
  if (options?.effort && !effortProblem(agent, options.effort)) args.push("--effort", options.effort);
  return args;
}

/** The Settings view of every built-in agent's model and effort choices. */
export function agentModelSettings(saved: AgentModelOptionsMap | undefined): MenuSproutAgentModelSettings[] {
  return (Object.keys(AGENT_OPTION_SPECS) as BuiltInAgentOptionName[]).map((name) => {
    const spec = AGENT_OPTION_SPECS[name];
    const options = saved?.[name];
    const problem = agentOptionsProblem(name, saved);
    return {
      name,
      label: AGENT_LABELS[name],
      ...(options?.model ? { model: options.model } : {}),
      ...(options?.effort ? { effort: options.effort } : {}),
      efforts: [...spec.efforts],
      modelSuggestions: [...spec.modelSuggestions],
      flags: spec.flags,
      ...(problem ? { problem } : {}),
    };
  });
}

/** Optional per-turn limits. Absent fields are off. */
export type AgentTurnLimits = {
  maxTurnMinutes?: number;
  maxToolCalls?: number;
};

export const TURN_LIMIT_BOUNDS = {
  maxTurnMinutes: { min: 1, max: 240 },
  maxToolCalls: { min: 1, max: 1000 },
} as const;

/**
 * Validates a Settings change to the turn limits. `null`/undefined turns a limit
 * off. Throws an Error with a user-facing message for an out-of-range value.
 */
export function validateTurnLimitsInput(input: { maxTurnMinutes?: number | null; maxToolCalls?: number | null }): AgentTurnLimits {
  const limits: AgentTurnLimits = {};
  for (const key of ["maxTurnMinutes", "maxToolCalls"] as const) {
    const value = input[key];
    if (value === null || value === undefined) continue;
    const { min, max } = TURN_LIMIT_BOUNDS[key];
    if (!Number.isInteger(value) || value < min || value > max) {
      const label = key === "maxTurnMinutes" ? "Max turn time" : "Max tool calls";
      throw new Error(`${label} must be a whole number from ${min} to ${max}, or off.`);
    }
    limits[key] = value;
  }
  return limits;
}

/** Normalizes limits read back from preferences.json, keeping only in-range whole numbers. */
export function normalizeTurnLimits(value: unknown): AgentTurnLimits | undefined {
  if (!value || typeof value !== "object") return undefined;
  const limits: AgentTurnLimits = {};
  for (const key of ["maxTurnMinutes", "maxToolCalls"] as const) {
    const candidate = (value as Record<string, unknown>)[key];
    const { min, max } = TURN_LIMIT_BOUNDS[key];
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= min && candidate <= max) {
      limits[key] = candidate;
    }
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}
