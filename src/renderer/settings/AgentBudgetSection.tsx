import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Input, cn } from "../../ui";
import type { MenuSproutAgentModelSettings, MenuSproutTurnLimits } from "../../shared/contracts";
import { ipcErrorMessage } from "../ipc-error";

const selectClass =
  "bg-transparent text-sm text-ink border border-line rounded px-2 py-1 outline-none focus:border-ink-strong focus:ring-1 focus:ring-ink-strong";

type AgentBudgetSectionProps = {
  agentModels: MenuSproutAgentModelSettings[];
  turnLimits: MenuSproutTurnLimits;
  /** Rejects with an Error(message) when the main process refuses the value. */
  onModelChange: (agentName: string, input: { model: string; effort: string }) => Promise<void>;
  onTurnLimitsChange: (limits: { maxTurnMinutes: number | null; maxToolCalls: number | null }) => Promise<void>;
};

// Model and effort per built-in agent, plus the optional per-turn limits.
// Every value is saved as typed or chosen; the main process validates it and
// the adapter passes it as the CLI's own flag.
export function AgentBudgetSection({ agentModels, turnLimits, onModelChange, onTurnLimitsChange }: AgentBudgetSectionProps) {
  return (
    <>
      <section className="flex flex-col gap-3" aria-label="model and effort">
        <span className="text-xxs uppercase tracking-caps text-ink-label">model and effort</span>
        <span className="text-xs text-ink-soft">
          Passed to each built-in agent's CLI as its own flags. CLI default passes nothing. A change applies from the next
          turn, and that agent starts a fresh conversation.
        </span>
        {agentModels.map((agent) => (
          <AgentModelRow key={agent.name} agent={agent} onChange={onModelChange} />
        ))}
      </section>
      <TurnLimitsRows turnLimits={turnLimits} onChange={onTurnLimitsChange} />
    </>
  );
}

function AgentModelRow({
  agent,
  onChange,
}: {
  agent: MenuSproutAgentModelSettings;
  onChange: AgentBudgetSectionProps["onModelChange"];
}) {
  const [model, setModel] = useState(agent.model ?? "");
  const [effort, setEffort] = useState(agent.effort ?? "");
  const [error, setError] = useState<string | null>(null);
  const [settledSaves, setSettledSaves] = useState(0);
  const suggestionsId = useId();
  const chosen = useRef(savedChoice(agent));
  const saved = useRef(agent);
  saved.current = agent;
  const saveQueue = useRef(Promise.resolve());
  const queuedSaves = useRef(0);
  // A saved level this version does not offer still shows as itself, flagged,
  // rather than silently reading as CLI default.
  const unknownEffort = effort && !agent.efforts.includes(effort) ? effort : null;

  useEffect(() => {
    if (queuedSaves.current === 0) adopt(savedChoice(agent));
  }, [agent.model, agent.effort, settledSaves]);

  function adopt(choice: AgentChoice) {
    if (choice.model !== chosen.current.model) setModel(choice.model);
    if (choice.effort !== chosen.current.effort) setEffort(choice.effort);
    chosen.current = choice;
  }

  function choose(next: Partial<AgentChoice>) {
    chosen.current = { ...chosen.current, ...next };
    setError(null);
    queuedSaves.current += 1;
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        await onChange(agent.name, chosen.current);
      } catch (caught) {
        setError(ipcErrorMessage(caught) ?? "Could not save this choice.");
        adopt(savedChoice(saved.current));
      } finally {
        queuedSaves.current -= 1;
        if (queuedSaves.current === 0) setSettledSaves((count) => count + 1);
      }
    });
  }

  function commitModel() {
    if (model.trim() === chosen.current.model.trim()) return;
    choose({ model });
  }

  function onModelKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") commitModel();
  }

  const message = error ?? agent.problem;

  return (
    <div className="flex flex-col gap-1.5" role="group" aria-label={`${agent.label} model and effort`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-sm text-ink">{agent.label}</span>
        <code className="whitespace-nowrap text-xxs text-ink-soft">{agent.flags}</code>
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          aria-label={`${agent.label} model`}
          className="min-w-0 flex-1"
          value={model}
          placeholder="model: CLI default"
          spellCheck={false}
          list={agent.modelSuggestions.length > 0 ? suggestionsId : undefined}
          onChange={(event) => setModel(event.target.value)}
          onBlur={commitModel}
          onKeyDown={onModelKeyDown}
        />
        {agent.modelSuggestions.length > 0 ? (
          <datalist id={suggestionsId}>
            {agent.modelSuggestions.map((suggestion) => (
              <option key={suggestion} value={suggestion} />
            ))}
          </datalist>
        ) : null}
        <select
          aria-label={`${agent.label} effort`}
          value={effort}
          onChange={(event) => {
            setEffort(event.target.value);
            choose({ effort: event.target.value });
          }}
          className={cn(selectClass, "shrink-0")}
        >
          <option value="">effort: CLI default</option>
          {unknownEffort ? <option value={unknownEffort}>{unknownEffort} (not offered)</option> : null}
          {agent.efforts.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </div>
      {message ? <span className="text-xs text-signal-danger">{message}</span> : null}
    </div>
  );
}

type AgentChoice = { model: string; effort: string };

function savedChoice(agent: MenuSproutAgentModelSettings): AgentChoice {
  return { model: agent.model ?? "", effort: agent.effort ?? "" };
}

function TurnLimitsRows({
  turnLimits,
  onChange,
}: {
  turnLimits: MenuSproutTurnLimits;
  onChange: AgentBudgetSectionProps["onTurnLimitsChange"];
}) {
  const [minutes, setMinutes] = useState(limitText(turnLimits.maxTurnMinutes));
  const [toolCalls, setToolCalls] = useState(limitText(turnLimits.maxToolCalls));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMinutes(limitText(turnLimits.maxTurnMinutes));
    setToolCalls(limitText(turnLimits.maxToolCalls));
  }, [turnLimits.maxTurnMinutes, turnLimits.maxToolCalls]);

  async function commit() {
    const next = { maxTurnMinutes: parseLimit(minutes), maxToolCalls: parseLimit(toolCalls) };
    if (next.maxTurnMinutes === (turnLimits.maxTurnMinutes ?? null) && next.maxToolCalls === (turnLimits.maxToolCalls ?? null)) {
      setError(null);
      return;
    }
    setError(null);
    try {
      await onChange(next);
    } catch (caught) {
      setError(ipcErrorMessage(caught) ?? "Could not save the limits.");
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") void commit();
  }

  return (
    <section className="flex flex-col gap-3" aria-label="turn limits">
      <span className="text-xxs uppercase tracking-caps text-ink-label">turn limits</span>
      <span className="text-xs text-ink-soft">
        Off when empty. A turn that reaches a limit stops like Cancel, and any partial changes stay for Keep or Undo.
      </span>
      <LimitRow
        label="max turn time"
        hint="Minutes from send, including agent startup"
        unit="min"
        value={minutes}
        onChange={setMinutes}
        onCommit={() => void commit()}
        onKeyDown={onKeyDown}
      />
      <LimitRow
        label="max tool calls"
        hint="Stops when the agent starts one more"
        unit="calls"
        value={toolCalls}
        onChange={setToolCalls}
        onCommit={() => void commit()}
        onKeyDown={onKeyDown}
      />
      {error ? <span className="text-xs text-signal-danger">{error}</span> : null}
    </section>
  );
}

function LimitRow({
  label,
  hint,
  unit,
  value,
  onChange,
  onCommit,
  onKeyDown,
}: {
  label: string;
  hint: string;
  unit: string;
  value: string;
  onChange: (value: string) => void;
  onCommit: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex flex-col gap-0.5">
        <span className="text-sm text-ink">{label}</span>
        <span className="text-xs text-ink-soft">{hint}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <Input
          aria-label={label}
          className="w-20"
          inputMode="numeric"
          value={value}
          placeholder="off"
          onChange={(event) => onChange(event.target.value)}
          onBlur={onCommit}
          onKeyDown={onKeyDown}
        />
        <span className="w-8 text-xs text-ink-soft">{unit}</span>
      </span>
    </div>
  );
}

function limitText(value: number | undefined): string {
  return value === undefined ? "" : String(value);
}

// Empty is off. Anything else goes to the main process as a number, which
// rejects a value that is not a whole number in range with a clear message.
function parseLimit(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return Number(trimmed);
}
