/* global React */

// ─── SessionBar ───────────────────────────────────────────────────
// Human-facing summary of what the agent just did, with two
// actions (Keep / Undo). Internally maps to GitSessionSnapshot but
// never exposes commits, file counts, or the word "git" to the user.
function SessionBar({ session, onSave, onRollback, onDismiss }) {
  if (!session) return null;

  if (session.kind === "refused") {
    return (
      <div className="sessionbar blocked">
        <span className="sb-dot"></span>
        <div className="sb-msg">
          Finish this change first
          <span className="sb-hint">keep or undo before asking again</span>
        </div>
        <button type="button" className="btn btn-ghost" onClick={onDismiss}>Dismiss</button>
        <span />
      </div>
    );
  }

  if (session.kind === "saved") {
    return (
      <div className="sessionbar saved">
        <span className="sb-dot"></span>
        <div className="sb-msg">{session.summary || "Kept"}</div>
        <button type="button" className="btn btn-ghost" onClick={onDismiss}>Dismiss</button>
        <span />
      </div>
    );
  }

  // pending
  return (
    <div className="sessionbar pending">
      <span className="sb-dot"></span>
      <div className="sb-msg">
        {session.summary}
        <span className="sb-hint">keep it, or undo</span>
      </div>
      <button type="button" className="btn btn-primary" onClick={onSave}>Keep</button>
      <button type="button" className="btn btn-danger"  onClick={onRollback}>Undo</button>
    </div>
  );
}

window.SessionBar = SessionBar;
