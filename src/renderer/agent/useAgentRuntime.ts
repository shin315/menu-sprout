import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentTurnFailure,
  AgentTurnMetrics,
  AgentTurnStopLimit,
  GitSessionSnapshot,
  WorkspaceChange,
  WorkspaceChangeKind,
} from "../../shared/contracts";
import { ipcErrorMessage } from "../ipc-error";

const unavailableText = "open menu_sprout from the tray to talk to the agent";

export type AgentRun = {
  id: string;
  title: string;
  startedAt: number;
  statusText?: string;
  // True when this run strip was restored from the main process (a turn that is
  // still running but whose original send() promise lives in an unmounted
  // instance). Recovered runs are polled until the turn ends.
  recovered?: boolean;
  // True once the user pressed Cancel and main accepted it; the strip stays
  // until the turn actually stops.
  cancelling?: boolean;
};

export type AgentSessionNotice =
  | {
      kind: "pending";
      summary: string;
      hint: string;
      canKeep: boolean;
      canUndo: boolean;
    }
  | {
      kind: "blocked" | "saved" | "error" | "cancelled";
      summary: string;
      hint?: string;
    };

export type AgentRuntime = ReturnType<typeof useAgentRuntime>;

export function useAgentRuntime() {
  const [run, setRun] = useState<AgentRun | null>(null);
  const [pendingChange, setPendingChange] = useState<AgentSessionNotice | null>(null);
  const [notice, setNotice] = useState<AgentSessionNotice | null>(null);
  const [resetting, setResetting] = useState(false);
  const resetInFlight = useRef(false);
  // The latest turn's final agent reply only. It is replaced by the next turn and
  // cleared by a new conversation, so the popover never becomes a transcript.
  const [reply, setReply] = useState<string | null>(null);
  // What the host measured for the latest turn; replaced or cleared like the reply.
  const [metrics, setMetrics] = useState<AgentTurnMetrics | null>(null);

  useEffect(() => {
    return window.menuSprout?.agent.onStatus((status) => {
      setRun((current) => (current ? { ...current, statusText: status.text } : current));
    });
  }, []);

  // Reconcile renderer state from the main process. The run strip and the
  // Keep/Rollback prompt are otherwise ephemeral renderer state, so remounting the
  // popover view (returning from Settings, or an HMR/window reload) would drop a
  // turn that is still running or a change session that is still open. Main is the
  // source of truth: if a turn is running, restore the run strip; once it finishes,
  // surface the pending prompt. This is why the prompt no longer appears mid-build.
  const reconcile = useCallback(async () => {
    const api = window.menuSprout;
    if (!api) return;

    const turn = await api.agent.getActiveTurn();
    if (turn) {
      // Do not clobber a live run this instance is already driving via send().
      setRun((current) =>
        current && !current.recovered
          ? current
          : {
              id: current?.startedAt === turn.startedAt ? current.id : crypto.randomUUID(),
              title: turn.title,
              startedAt: turn.startedAt,
              statusText: current?.startedAt === turn.startedAt ? current.statusText : "Working...",
              recovered: true,
              cancelling: current?.startedAt === turn.startedAt ? current.cancelling : false,
            },
      );
      return;
    }

    setRun((current) => (current?.recovered ? null : current));
    const snapshot = await api.git.status();
    if (snapshot) {
      const notice = sessionNoticeForSnapshot(snapshot);
      if (notice) setPendingChange(notice);
    }
  }, []);

  useEffect(() => {
    void reconcile();
  }, [reconcile]);

  // While a restored run strip is showing (a turn whose send() promise is not in
  // this instance), poll until the turn ends so the prompt flips in at the right
  // time. Live sends resolve their own promise and never set `recovered`.
  useEffect(() => {
    if (!run?.recovered) return undefined;
    const timer = window.setInterval(() => void reconcile(), 1000);
    return () => window.clearInterval(timer);
  }, [run?.recovered, reconcile]);

  // Resolves false when the prompt was refused without being sent, so the
  // composer can keep the draft.
  async function send(prompt: string): Promise<boolean> {
    const trimmed = prompt.trim();
    if (!trimmed || run || resetInFlight.current) return false;

    if (pendingChange?.kind === "pending") {
      setNotice({
        kind: "blocked",
        summary: "Finish this change first",
        hint: "keep or undo before asking again",
      });
      return false;
    }

    const startedAt = Date.now();
    setNotice(null);
    setReply(null);
    setMetrics(null);
    setRun({
      id: crypto.randomUUID(),
      title: trimmed,
      startedAt,
      statusText: "Working...",
    });

    try {
      if (!window.menuSprout) throw new Error(unavailableText);
      const result = await window.menuSprout.agent.send(trimmed);
      const nextChange = sessionNoticeForResult(result.session);
      setPendingChange(nextChange.kind === "pending" ? nextChange : null);
      setMetrics(result.metrics ?? null);
      if (result.stoppedBy) {
        // A limit stops the turn through Cancel, so partial changes stay pending too.
        setNotice({
          kind: "cancelled",
          summary: stoppedSummary(result.stoppedBy),
          hint: nextChange.kind === "pending" ? "partial changes kept - keep or undo them" : "nothing was changed",
        });
      } else if (result.cancelled) {
        // Like a failed turn, partial changes stay pending for Keep or Undo.
        setNotice({
          kind: "cancelled",
          summary: "Cancelled",
          hint: nextChange.kind === "pending" ? "partial changes kept - keep or undo them" : "nothing was changed",
        });
      } else {
        setNotice(
          result.refused
            ? { kind: "error", summary: "Agent unavailable", hint: result.assistantText }
            : nextChange.kind === "pending" ? null : nextChange,
        );
        setReply(result.reply?.trim() || null);
      }
    } catch (error) {
      const failedTurn = isTurnFailure(error) ? error : null;
      const snapshot = await window.menuSprout?.git.status().catch(() => null);
      const recoveredChange = snapshot ? sessionNoticeForSnapshot(snapshot) : null;
      setPendingChange(recoveredChange?.kind === "pending" ? recoveredChange : null);
      setMetrics(failedTurn?.metrics ?? null);
      setNotice({
        kind: "error",
        summary: "Agent unavailable",
        hint: (failedTurn ? failedTurn.message : ipcErrorMessage(error)) || unavailableText,
      });
    } finally {
      setRun(null);
    }
    return true;
  }

  async function cancel() {
    if (!window.menuSprout || !run || run.cancelling) return;
    const result = await window.menuSprout.agent.cancel().catch(() => null);
    // A refusal means the turn already ended; its own result will land shortly.
    if (result?.ok) setRun((current) => (current ? { ...current, cancelling: true } : current));
  }

  async function newConversation() {
    if (!window.menuSprout || run || resetInFlight.current) return;

    if (pendingChange?.kind === "pending") {
      setNotice({
        kind: "blocked",
        summary: "Finish this change first",
        hint: "keep or undo before starting a new conversation",
      });
      return;
    }

    resetInFlight.current = true;
    setResetting(true);
    try {
      const result = await window.menuSprout.agent.newConversation().catch((error: unknown) => ({
        ok: false,
        reason: ipcErrorMessage(error) ?? undefined,
      }));
      if (!result.ok) {
        setNotice({ kind: "error", summary: "Could not start a new conversation", hint: result.reason });
        return;
      }
      setReply(null);
      setMetrics(null);
      setNotice({ kind: "saved", summary: "New conversation", hint: "the agent starts fresh on your next ask" });
    } finally {
      resetInFlight.current = false;
      setResetting(false);
    }
  }

  async function keep() {
    if (!window.menuSprout || pendingChange?.kind !== "pending") return;

    const result = await window.menuSprout.git.save();
    if (!result.ok) {
      setNotice({ kind: "error", summary: "Could not keep this change" });
      return;
    }

    // Keep is the happy path: clear the bar and return to the composer. A
    // separate "kept" confirmation with its own Dismiss button is just noise.
    setPendingChange(null);
    setNotice(null);
  }

  async function undo() {
    if (!window.menuSprout || pendingChange?.kind !== "pending") return;

    const result = await window.menuSprout.git.rollback();
    if (!result.ok) {
      setNotice({ kind: "error", summary: "Could not undo this change" });
      return;
    }

    setPendingChange(null);
    setNotice({ kind: "saved", summary: "Undone" });
  }

  function dismissNotice() {
    setNotice(null);
  }

  return {
    run,
    resetting,
    reply,
    metrics,
    session: notice ?? pendingChange,
    pendingChange,
    notice,
    send,
    cancel,
    newConversation,
    keep,
    undo,
    dismissNotice,
  };
}

function stoppedSummary(limit: AgentTurnStopLimit): string {
  return limit === "time-limit" ? "Stopped: time limit" : "Stopped: tool-call limit";
}

function sessionNoticeForResult(snapshot: GitSessionSnapshot | undefined): AgentSessionNotice {
  // The agent reported back without touching any file. Say so plainly instead of
  // claiming a change and offering a Keep button with nothing behind it.
  if (snapshot && snapshot.dirty === false) {
    return { kind: "blocked", summary: "No changes were made", hint: "the agent did not edit anything" };
  }

  if (snapshot?.canSave || snapshot?.canRollback) {
    return {
      kind: "pending",
      summary: summarizeChanges(snapshot.changes) ?? "Review the changes",
      hint: "keep it, or undo",
      canKeep: snapshot.canSave,
      canUndo: snapshot.canRollback,
    };
  }

  return {
    kind: "blocked",
    summary: "Finish this change first",
    hint: "keep or undo before asking again",
  };
}

// Builds a pending notice from a re-hydrated session snapshot after a reload.
// The summary is derived from the diff, the same as the live result. Returns
// null when the session can no longer be saved/rolled back or made no change.
function sessionNoticeForSnapshot(snapshot: GitSessionSnapshot): AgentSessionNotice | null {
  if (!snapshot.canSave && !snapshot.canRollback) return null;
  if (snapshot.dirty === false) return null;
  return {
    kind: "pending",
    summary: summarizeChanges(snapshot.changes) ?? snapshot.message?.trim() ?? "Unsaved agent changes",
    hint: "keep it, or undo",
    canKeep: snapshot.canSave,
    canUndo: snapshot.canRollback,
  };
}

// Turns the diff-derived change list into a short, honest label for the
// Keep/Rollback bar. Extension changes lead (a created/updated extension is the
// headline); the root layout is described only when nothing else changed.
// Returns null when there is nothing attributable to name.
function summarizeChanges(changes: WorkspaceChange[] | undefined): string | null {
  if (!changes || changes.length === 0) return null;

  const extensions = changes.filter(
    (change): change is Extract<WorkspaceChange, { type: "extension" }> => change.type === "extension",
  );

  if (extensions.length === 1) {
    return `${verbFor(extensions[0].kind)} the ${extensions[0].extensionId} extension`;
  }
  if (extensions.length > 1) {
    const kinds = new Set(extensions.map((change) => change.kind));
    const verb = kinds.size === 1 ? verbFor(extensions[0].kind) : "Changed";
    return `${verb} ${extensions.length} extensions`;
  }

  const layout = changes.find((change) => change.type === "layout");
  if (layout) return `${verbFor(layout.kind)} the layout`;

  return null;
}

function isTurnFailure(error: unknown): error is AgentTurnFailure {
  return typeof error === "object" && error !== null && "metrics" in error && "message" in error;
}

function verbFor(kind: WorkspaceChangeKind): string {
  if (kind === "created") return "Added";
  if (kind === "removed") return "Removed";
  return "Updated";
}
