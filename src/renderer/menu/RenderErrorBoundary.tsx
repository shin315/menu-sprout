import { Component, createContext, useContext, type ReactNode } from "react";
import { Button } from "../../ui";

// What an error card can offer the user. App provides it from the agent runtime;
// without a provider (capture windows, isolated tests) the card shows no actions.
export type RenderRecoveryActions = {
  // Pre-fills the composer with a fix request. Never sends it.
  askAgentToFix: (prompt: string) => void;
  // Rolls back the open Keep/Undo session; null while no session can be undone.
  undoLastTurn: (() => void) | null;
  // True while a Keep/Undo session is open; the agent refuses new prompts until
  // it is kept or undone, so asking for a fix is disabled.
  changePending: boolean;
};

export const RenderRecoveryContext = createContext<RenderRecoveryActions | null>(null);

// Catches a render error in its subtree and shows `fallback` instead, so one broken
// widget (or a broken menu surface) never unmounts the rest of the popover. Clears
// the error when `resetKey` changes, e.g. the agent fixes the module or the user
// reloads, so the subtree can recover live.
export class RenderErrorBoundary extends Component<
  { resetKey: unknown; fallback: (error: unknown) => ReactNode; children: ReactNode },
  { failed: boolean; error: unknown }
> {
  state = { failed: false, error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }

  componentDidUpdate(prev: { resetKey: unknown }) {
    if (this.state.failed && !Object.is(prev.resetKey, this.props.resetKey)) this.setState({ failed: false, error: null });
  }

  render() {
    return this.state.failed ? this.props.fallback(this.state.error) : this.props.children;
  }
}

export function RenderErrorCard({ title, error, fixSubject }: { title: string; error: unknown; fixSubject: string }) {
  const recovery = useContext(RenderRecoveryContext);
  const reason = sanitizeRenderError(error);

  return (
    <section className="render-error" role="alert">
      <span className="re-dot" />
      <div className="re-msg">
        <span>{title}</span>
        <span className="re-reason">{reason}</span>
      </div>
      {recovery ? (
        <div className="re-actions">
          {recovery.undoLastTurn ? (
            <Button variant="primary" size="sm" onClick={recovery.undoLastTurn}>
              Undo last turn
            </Button>
          ) : null}
          <Button
            size="sm"
            disabled={recovery.changePending}
            onClick={() => recovery.askAgentToFix(`${fixSubject} throws while rendering: ${reason}. Fix it so it renders again.`)}
          >
            Ask the agent to fix
          </Button>
          {recovery.changePending ? <span className="re-note">Keep or undo the last change first</span> : null}
        </div>
      ) : null}
    </section>
  );
}

const MAX_REASON_LENGTH = 160;

// Reduces a render error to one short line that is safe to show and to hand to
// the agent: the first message line only (no stack), URLs and absolute paths cut
// to their last segment (no home directory, no query strings), and long
// token-like runs redacted so a widget cannot echo a credential into the card.
export function sanitizeRenderError(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const firstLine = raw.split("\n").find((line) => line.trim()) ?? "";
  const reason = firstLine
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s)"'`]+/gi, lastSegment)
    .replace(/(^|[\s("'`])((?:~|\/)[^\s)"'`]*\/[^\s)"'`]+)/g, (_match, lead: string, path: string) => lead + lastSegment(path))
    .replace(/[A-Za-z0-9_\-+/=.]{32,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (!reason) return "unknown render error";
  return reason.length > MAX_REASON_LENGTH ? `${reason.slice(0, MAX_REASON_LENGTH - 3)}...` : reason;
}

function lastSegment(pathOrUrl: string): string {
  const withoutQuery = pathOrUrl.replace(/[?#].*$/, "").replace(/\/+$/, "");
  return withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1) || "path";
}
