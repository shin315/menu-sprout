import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Leaf, MessageSquarePlus, Power, RotateCw, Settings, X } from "lucide-react";
import { Button, Tooltip } from "../ui";
import { AgentChatView } from "./agent/AgentChat";
import { useAgentRuntime } from "./agent/useAgentRuntime";
import { MenuSurface } from "./menu/MenuSurface";
import {
  RenderErrorBoundary,
  RenderErrorCard,
  RenderRecoveryContext,
  type RenderRecoveryActions,
} from "./menu/RenderErrorBoundary";
import { measurePopoverContentSize } from "./popover-content-height";
import { SettingsView } from "./settings/SettingsView";
import { UpdateIndicator } from "./UpdateIndicator";

type AppView = "menu" | "settings";

export function App() {
  const [view, setView] = useState<AppView>("menu");
  // Bumping this remounts the menu surface, forcing widget + layout discovery to
  // re-run and resetting all widget React state - a manual full layout reload.
  const [reloadNonce, setReloadNonce] = useState(0);
  const shellRef = useRef<HTMLElement>(null);
  const agent = useAgentRuntime();
  const recovery = useRenderRecovery(agent, setView);
  usePopoverContentHeight();
  useDropHeaderAutoFocus();

  useEffect(() => {
    void window.menuSprout?.settings.get().then((settings) => {
      if (!document.documentElement.hasAttribute("data-theme")) {
        document.documentElement.setAttribute("data-theme", settings.theme);
      }
    });
  }, []);

  const settingsOpen = view === "settings";

  function openSettings() {
    setView("settings");
  }

  function closeSettings() {
    setView("menu");
  }

  function reloadLayout() {
    setReloadNonce((nonce) => nonce + 1);
  }

  function quitApp() {
    void window.menuSprout?.app.quit();
  }

  return (
    <main ref={shellRef} className="app-shell" aria-label="menu_sprout tray popover">
      {/* The default view stays mounted underneath settings so its React state
          (agent chat, widgets) survives opening and closing settings. It is made
          inert while covered so focus and pointer events cannot reach behind the
          overlay. */}
      <div className="app-view" inert={settingsOpen}>
        <header className="pop-head">
          <span className="mark flex items-center gap-0.5">
            <Leaf className="size-3.5 -mt-0.5" />
            <span>menu<span className="sep">_</span>sprout</span>
          </span>
          <div className="flex items-center gap-1">
            <UpdateIndicator />
            <Tooltip content="New conversation">
              <Button
                variant="ghost"
                size="sm"
                className="w-7 px-0"
                aria-label="new conversation"
                disabled={agent.run !== null || agent.resetting}
                onClick={() => void agent.newConversation()}
              >
                <MessageSquarePlus className="size-4" />
              </Button>
            </Tooltip>
            <Tooltip content="Reload layout">
              <Button
                variant="ghost"
                size="sm"
                className="w-7 px-0"
                aria-label="reload layout"
                onClick={reloadLayout}
              >
                <RotateCw className="size-4" />
              </Button>
            </Tooltip>
            <Tooltip content="Open settings">
              <Button variant="ghost" size="sm" className="w-7 px-0" aria-label="open settings" onClick={openSettings}>
                <Settings className="size-4" />
              </Button>
            </Tooltip>
            <Tooltip content="Quit menu sprout">
              <Button
                variant="ghost"
                size="sm"
                className="w-7 px-0 hover:text-signal-danger"
                aria-label="quit menu_sprout"
                onClick={quitApp}
              >
                <Power className="size-4" />
              </Button>
            </Tooltip>
          </div>
        </header>
        {/* The root boundary keeps the header and agent chat mounted even if the
            menu surface itself throws; Reload (a new nonce) clears it. */}
        <RenderRecoveryContext.Provider value={recovery.actions}>
          <div className="pop-body">
            <RenderErrorBoundary
              resetKey={reloadNonce}
              fallback={(error) => (
                <RenderErrorCard title="The menu failed to render" error={error} fixSubject="The menu surface" />
              )}
            >
              <MenuSurface key={reloadNonce} />
            </RenderErrorBoundary>
          </div>
        </RenderRecoveryContext.Provider>
        <AgentChatView runtime={agent} prefill={recovery.prefill} onPrefillApplied={recovery.clearPrefill} />
      </div>

      {settingsOpen ? (
        <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="settings">
          <header className="pop-head">
            <span className="mark">settings</span>
            <Tooltip content="Close settings">
              <Button variant="ghost" size="sm" className="w-7 px-0" aria-label="close settings" onClick={closeSettings}>
                <X className="size-4" />
              </Button>
            </Tooltip>
          </header>
          <div className="pop-body">
            <RenderRecoveryContext.Provider value={recovery.actions}>
              <SettingsView />
            </RenderRecoveryContext.Provider>
          </div>
        </div>
      ) : null}
    </main>
  );
}

// Error-card actions backed by the shared agent runtime, for widget, menu, and
// settings-section error cards: "Ask the agent to fix" only pre-fills the
// composer (closing settings so it is visible) and is disabled while a Keep/Undo
// session is open, and "Undo last turn" exists only while that session can roll
// back. The context value changes only when the session state does, so widgets
// do not re-render on every agent status update.
function useRenderRecovery(agent: ReturnType<typeof useAgentRuntime>, setView: (view: AppView) => void) {
  const [prefill, setPrefill] = useState<string | null>(null);
  const undoRef = useRef(agent.undo);
  useEffect(() => {
    undoRef.current = agent.undo;
  });
  const changePending = agent.pendingChange?.kind === "pending";
  const canUndo = agent.pendingChange?.kind === "pending" && agent.pendingChange.canUndo;

  const actions = useMemo<RenderRecoveryActions>(
    () => ({
      askAgentToFix: (prompt) => {
        setPrefill(prompt);
        setView("menu");
      },
      undoLastTurn: canUndo ? () => void undoRef.current() : null,
      changePending,
    }),
    [canUndo, changePending, setView],
  );
  const clearPrefill = useCallback(() => setPrefill(null), []);

  return { actions, prefill, clearPrefill };
}

// The popover opens focused (main calls window.focus()); if that focus lands on a
// header control it gets ring-highlighted before the user does anything. Clear
// that auto-focus without touching genuine keyboard focus elsewhere.
function useDropHeaderAutoFocus() {
  useEffect(() => {
    const drop = () => {
      requestAnimationFrame(() => {
        const active = document.activeElement as HTMLElement | null;
        if (active && active.closest(".pop-head")) active.blur();
      });
    };
    drop();
    window.addEventListener("focus", drop);
    return () => window.removeEventListener("focus", drop);
  }, []);
}

function usePopoverContentHeight() {
  useEffect(() => {
    const element = document.querySelector<HTMLElement>(".app-shell");
    if (!element || !window.menuSprout?.popover) return undefined;

    let animationFrame = 0;
    let lastWidth = 0;
    let lastHeight = 0;
    const report = () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = 0;
        const { width, height } = measurePopoverContentSize(element);
        if (!height || (width === lastWidth && height === lastHeight)) return;
        lastWidth = width;
        lastHeight = height;
        void window.menuSprout?.popover.setContentSize({ width, height });
      });
    };

    report();

    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(report);
    resizeObserver?.observe(element);

    // Overlays (Dialog/Select/Dropdown) portal outside .app-shell, so watch the
    // body subtree to react when one opens or closes. Also observe the overlay
    // itself: a tall overlay can be max-h-clamped while the window is small, then
    // expand once the window grows, so we need to re-measure until it settles.
    // Observe the overlay and the layout canvas directly. The shell width is
    // 100% of the window, so a custom layout that changes only its own width (the
    // canvas overflows the shell) does not resize .app-shell and would otherwise
    // be missed; observing the canvas catches it so the window keeps adapting.
    const observed = new Map<string, Element>();
    const syncExtraObservations = () => {
      for (const selector of ["[data-bm-overlay]", "[data-bm-canvas]"]) {
        const next = document.querySelector(selector);
        const current = observed.get(selector) ?? null;
        if (next === current) continue;
        if (current) resizeObserver?.unobserve(current);
        if (next) {
          observed.set(selector, next);
          resizeObserver?.observe(next);
        } else {
          observed.delete(selector);
        }
      }
    };
    syncExtraObservations();
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            syncExtraObservations();
            report();
          });
    mutationObserver?.observe(document.body, { childList: true, subtree: true });

    return () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
    };
  }, []);
}
