/* global React */
const { useState, useEffect } = React;

// ─── MenuBar ───────────────────────────────────────────────────────
// Fake macOS menu bar; the tray button toggles the popover.
function MenuBar({ open, onToggle }) {
  const [time, setTime] = useState(() => formatClock(new Date()));
  useEffect(() => {
    const id = setInterval(() => setTime(formatClock(new Date())), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="menubar">
      <div className="left">
        <span className="apple"></span>
        <span className="app-name">Code</span>
        <span className="item">File</span>
        <span className="item">Edit</span>
        <span className="item">Selection</span>
        <span className="item">View</span>
        <span className="item">Go</span>
      </div>
      <div className="right">
        <span>78%</span>
        <span>wi-fi</span>
        <button
          type="button"
          className={"tray-btn" + (open ? " open" : "")}
          onClick={onToggle}
          aria-label="menu_sprout"
          title="menu_sprout"
        >
          b
        </button>
        <span>{time}</span>
      </div>
    </div>
  );
}

function formatClock(d) {
  const h = d.getHours() % 12 || 12;
  const m = d.getMinutes().toString().padStart(2, "0");
  return `${h}:${m}`;
}

window.MenuBar = MenuBar;
