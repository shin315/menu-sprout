import { describe, expect, it } from "vitest";
import {
  adapterArgsForOptions,
  agentModelSettings,
  agentOptionsProblem,
  normalizeAgentModelOptions,
  normalizeTurnLimits,
  validateAgentOptionsInput,
  validateTurnLimitsInput,
} from "../src/shared/agent-options";

describe("built-in agent model and effort options", () => {
  it("passes nothing for CLI default", () => {
    expect(validateAgentOptionsInput("claude", { model: "  ", effort: "" })).toEqual({});
    expect(adapterArgsForOptions("claude", undefined)).toEqual([]);
    expect(adapterArgsForOptions("codex", {})).toEqual([]);
  });

  it("turns valid choices into the adapter's --model and --effort arguments", () => {
    const options = validateAgentOptionsInput("codex", { model: " gpt-5.5 ", effort: "xhigh" });
    expect(options).toEqual({ model: "gpt-5.5", effort: "xhigh" });
    expect(adapterArgsForOptions("codex", options)).toEqual(["--model", "gpt-5.5", "--effort", "xhigh"]);
    expect(adapterArgsForOptions("antigravity", { model: "gemini-3.1-pro-high" })).toEqual(["--model", "gemini-3.1-pro-high"]);
    expect(adapterArgsForOptions("claude", { model: "sonnet[1m]" })).toEqual(["--model", "sonnet[1m]"]);
  });

  it("offers each CLI's documented effort levels", () => {
    const byName = Object.fromEntries(agentModelSettings(undefined).map((agent) => [agent.name, agent]));
    expect(byName.claude.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(byName.claude.modelSuggestions).toEqual(["fable", "opus", "sonnet", "haiku"]);
    expect(byName.antigravity.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(byName.codex.efforts).toContain("minimal");
  });

  it("refuses an effort the CLI does not document, with the levels it does", () => {
    expect(() => validateAgentOptionsInput("claude", { effort: "ultra" })).toThrow(
      'Claude Code effort "ultra" is not one Menu Sprout can pass (low, medium, high, xhigh, max). Choose another level in Settings, or CLI default.',
    );
  });

  it("refuses a model id that is not a single safe CLI argument", () => {
    for (const model of ["two words", "--dangerous", 'quote"d', "x".repeat(101)]) {
      expect(() => validateAgentOptionsInput("codex", { model })).toThrow(/is not a valid model id/);
    }
  });

  it("refuses model and effort for agents that are not built in", () => {
    expect(() => validateAgentOptionsInput("pi", { model: "x" })).toThrow(
      'Model and effort can only be set for the built-in agents, not "pi".',
    );
  });

  it("keeps an unknown saved value and reports it instead of silently dropping it", () => {
    const saved = normalizeAgentModelOptions({ claude: { effort: "ultra" }, codex: { model: "gpt-5.5" }, custom: { model: "x" } });
    expect(saved).toEqual({ claude: { effort: "ultra" }, codex: { model: "gpt-5.5" } });
    expect(agentOptionsProblem("claude", saved)).toMatch(/Claude Code effort "ultra" is not one Menu Sprout can pass/);
    expect(agentOptionsProblem("codex", saved)).toBeUndefined();
    expect(agentOptionsProblem("pi", saved)).toBeUndefined();
    // The invalid value never reaches the CLI; the turn is refused instead.
    expect(adapterArgsForOptions("claude", saved?.claude)).toEqual([]);
    const claude = agentModelSettings(saved).find((agent) => agent.name === "claude");
    expect(claude).toMatchObject({ effort: "ultra", problem: expect.stringMatching(/not one Menu Sprout can pass/) });
  });
});

describe("turn limits", () => {
  it("are off unless set, and accept whole numbers in range", () => {
    expect(validateTurnLimitsInput({ maxTurnMinutes: null, maxToolCalls: undefined })).toEqual({});
    expect(validateTurnLimitsInput({ maxTurnMinutes: 10, maxToolCalls: 40 })).toEqual({ maxTurnMinutes: 10, maxToolCalls: 40 });
  });

  it("refuse a value out of range or not whole", () => {
    expect(() => validateTurnLimitsInput({ maxTurnMinutes: 0 })).toThrow("Max turn time must be a whole number from 1 to 240, or off.");
    expect(() => validateTurnLimitsInput({ maxToolCalls: 2.5 })).toThrow("Max tool calls must be a whole number from 1 to 1000, or off.");
    expect(() => validateTurnLimitsInput({ maxToolCalls: Number.NaN })).toThrow(/Max tool calls/);
  });

  it("normalize saved limits to in-range whole numbers", () => {
    expect(normalizeTurnLimits({ maxTurnMinutes: 5, maxToolCalls: "10" })).toEqual({ maxTurnMinutes: 5 });
    expect(normalizeTurnLimits({})).toBeUndefined();
  });
});
