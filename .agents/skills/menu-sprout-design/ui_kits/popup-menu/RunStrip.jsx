/* global React */
const { useEffect, useState, useRef } = React;

// ─── RunStrip ─────────────────────────────────────────────────────
// One live affordance. Pulsing mint dot + user's task (prompt) on
// top, current agent step underneath, elapsed timer on the right.
// No checklist, no history. When the run finishes the strip is
// removed and a SessionBar takes its place.
function RunStrip({ run }) {
  const [elapsed, setElapsed] = useState(0);
  const startedAt = useRef(run.startedAt);

  useEffect(() => {
    startedAt.current = run.startedAt;
    setElapsed(0);
    if (run.done) return;
    const id = setInterval(() => {
      setElapsed((Date.now() - startedAt.current) / 1000);
    }, 100);
    return () => clearInterval(id);
  }, [run.id, run.done]);

  const currentStep =
    run.steps && run.activeIndex != null && run.activeIndex < run.steps.length
      ? run.steps[run.activeIndex].label
      : (run.steps && run.steps.length ? run.steps[run.steps.length - 1].label : "working");

  return (
    <div className="runstrip">
      <span className="dot"></span>
      <div className="lines">
        <span className="task">› {run.title}</span>
        {/* key on currentStep so React remounts → CSS animation replays per step */}
        <span className="step" key={currentStep}>{currentStep}</span>
      </div>
      <span className="timer">{elapsed.toFixed(1)}s</span>
    </div>
  );
}

window.RunStrip = RunStrip;
