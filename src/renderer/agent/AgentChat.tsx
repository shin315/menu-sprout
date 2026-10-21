import { FormEvent, KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Button } from "../../ui";
import type { AgentTurnMetrics } from "../../shared/contracts";
import { formatTurnMetrics } from "./turn-metrics";
import { useAgentRuntime, type AgentRun, type AgentRuntime, type AgentSessionNotice } from "./useAgentRuntime";

type ComposerPrefillProps = {
  // Text to place in the composer (never sent); applied once, then reported back.
  prefill?: string | null;
  onPrefillApplied?: () => void;
};

export function AgentChat(props: ComposerPrefillProps) {
  return <AgentChatView runtime={useAgentRuntime()} {...props} />;
}

// The chat UI over a runtime owned by the caller, so App can share the same
// Keep/Undo session with the widget error cards.
export function AgentChatView({ runtime, prefill, onPrefillApplied }: { runtime: AgentRuntime } & ComposerPrefillProps) {
  const { run, reply, metrics, session, pendingChange, notice, send, cancel, keep, undo, dismissNotice } = runtime;

  if (run) return <RunStrip run={run} onCancel={cancel} />;

  return (
    <>
      <AgentReply text={reply} />
      <TurnMetricsLine metrics={metrics} />
      <SessionBar session={session} onKeep={keep} onUndo={undo} onDismiss={dismissNotice} />
      {notice && pendingChange ? (
        <SessionBar session={pendingChange} onKeep={keep} onUndo={undo} onDismiss={dismissNotice} />
      ) : null}
      <Composer onSend={send} disabled={runtime.resetting} prefill={prefill} onPrefillApplied={onPrefillApplied} />
    </>
  );
}

function Composer({
  onSend,
  disabled,
  prefill,
  onPrefillApplied,
}: { onSend: (prompt: string) => Promise<boolean>; disabled: boolean } & ComposerPrefillProps) {
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!prefill) return;
    setDraft(prefill);
    textareaRef.current?.focus();
    onPrefillApplied?.();
  }, [prefill, onPrefillApplied]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    if (!draft) {
      textarea.style.height = "";
      return;
    }

    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 96)}px`;
  }, [draft]);

  function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || disabled) return;

    setDraft("");
    void onSend(text).then((sent) => {
      if (!sent) setDraft(draft);
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    submit();
  }

  const hasText = draft.length > 0;

  return (
    <div className="composer-wrap">
      <form className={`composer${hasText ? " has-text" : " empty"}`} onSubmit={submit}>
        <span className="prompt">›</span>
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="talk to the sprout"
          rows={1}
        />
        <button
          type="submit"
          className="send"
          aria-disabled={!hasText || disabled ? "true" : "false"}
          disabled={!hasText || disabled}
        >
          send
        </button>
      </form>
    </div>
  );
}

function RunStrip({ run, onCancel }: { run: AgentRun; onCancel: () => void | Promise<void> }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setElapsed((Date.now() - run.startedAt) / 1000);
    }, 100);

    return () => window.clearInterval(timer);
  }, [run.id, run.startedAt]);

  return (
    <div className="runstrip">
      <span className="dot" />
      <div className="lines">
        <span className="task">› {run.title}</span>
        {run.cancelling ? (
          <span className="step" key="cancelling">
            Cancelling...
          </span>
        ) : run.statusText ? (
          <span className="step" key={run.statusText}>
            {run.statusText}
          </span>
        ) : null}
      </div>
      <span className="timer">{elapsed.toFixed(1)}s</span>
      <Button variant="ghost" size="sm" disabled={run.cancelling} onClick={() => void onCancel()}>
        Cancel
      </Button>
    </div>
  );
}

// The latest turn's final agent reply, collapsed to two lines by default. Only
// one reply is ever shown; this is a status readout, not a chat transcript.
function AgentReply({ text }: { text: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const textId = useId();

  useEffect(() => {
    setExpanded(false);
  }, [text]);

  if (!text) return null;

  return (
    <div className={`reply${expanded ? " expanded" : ""}`}>
      <span className="reply-mark" aria-hidden="true">
        ‹
      </span>
      <p id={textId} className="reply-text">
        {text}
      </p>
      <button
        type="button"
        className="reply-toggle"
        aria-expanded={expanded}
        aria-controls={textId}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? "less" : "more"}
      </button>
    </div>
  );
}

// One compact line of what the host measured for the latest turn.
function TurnMetricsLine({ metrics }: { metrics: AgentTurnMetrics | null }) {
  if (!metrics) return null;
  const { text, title } = formatTurnMetrics(metrics);
  return (
    <p className="turn-metrics" aria-label="last turn" title={title}>
      {text}
    </p>
  );
}

function SessionBar({
  session,
  onKeep,
  onUndo,
  onDismiss,
}: {
  session: AgentSessionNotice | null;
  onKeep: () => void | Promise<void>;
  onUndo: () => void | Promise<void>;
  onDismiss: () => void;
}) {
  if (!session) return null;

  if (session.kind === "pending") {
    return (
      <div className="sessionbar pending">
        <span className="sb-dot" />
        <div className="sb-msg">
          {session.summary}
          <span className="sb-hint">{session.hint}</span>
        </div>
        <Button variant="primary" size="sm" disabled={!session.canKeep} onClick={() => void onKeep()}>
          Keep
        </Button>
        <Button variant="danger" size="sm" disabled={!session.canUndo} onClick={() => void onUndo()}>
          Undo
        </Button>
      </div>
    );
  }

  return (
    <div className={`sessionbar ${session.kind}`}>
      <span className="sb-dot" />
      <div className="sb-msg">
        {session.summary}
        {session.hint ? <span className="sb-hint">{session.hint}</span> : null}
      </div>
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        Dismiss
      </Button>
      <span />
    </div>
  );
}
