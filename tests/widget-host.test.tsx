// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GitSessionSnapshot,
  MenuSproutApi,
  MenuSproutLayout,
  PopoverVisibilityState,
  RefreshableMenuSproutWidget } from "../src/shared/contracts";
import { App } from "../src/renderer/App";
import { WidgetHost, widgetsFromModule } from "../src/renderer/menu/WidgetHost";
import { useViewRefresh } from "../src/renderer/menu/useViewRefresh";

// Runtime discovery imports widget modules by URL; serve them from this map so the
// App-level tests exercise the real discovery path without a module server.
const runtimeModules = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../src/renderer/extension-modules", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/renderer/extension-modules")>();
  return { ...actual, importRuntimeModule: vi.fn(async (url: string) => runtimeModules.get(url)) };
});

type VisibilityListener = (state: PopoverVisibilityState) => void;

function installPopoverVisibility(initialVisible?: boolean) {
  let listener: VisibilityListener | null = null;
  window.menuSprout = {
    popover: {
      setContentHeight: vi.fn(async () => ({ ok: true })),
      getVisibility:
        initialVisible === undefined ? undefined : vi.fn(async () => ({ visible: initialVisible })),
      onVisibility: vi.fn((cb: VisibilityListener) => {
        listener = cb;
        return () => {
          listener = null;
        };
      }),
    },
  } as unknown as typeof window.menuSprout;
  return {
    emit(visible: boolean) {
      listener?.({ visible });
    },
  };
}

afterEach(() => {
  cleanup();
  delete window.menuSprout;
  runtimeModules.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const goodWidget: RefreshableMenuSproutWidget = { id: "clock", title: "Clock", render: () => <span>09:41</span> };

function throwingWidget(message = "quota.used is undefined"): RefreshableMenuSproutWidget {
  return {
    id: "quota",
    title: "Quota",
    render: () => {
      throw new Error(message);
    },
  };
}

// React reports errors caught by a boundary through console.error; keep test output quiet.
function silenceCaughtRenderErrors() {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
}

function installAppApi({ session = null }: { session?: GitSessionSnapshot | null } = {}) {
  const settings = { openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const };
  const api = {
    recipes: { list: vi.fn(async () => []) },
    git: {
      save: vi.fn(async () => ({ ok: true })),
      rollback: vi.fn(async () => ({ ok: true })),
      status: vi.fn(async () => session),
    },
    agent: {
      send: vi.fn(),
      onStatus: vi.fn(() => () => undefined),
      getActiveTurn: vi.fn(async () => null),
      cancel: vi.fn(async () => ({ ok: true })),
      newConversation: vi.fn(async () => ({ ok: true })),
    },
    capabilities: { list: vi.fn(async () => []), invoke: vi.fn() },
    db: { query: vi.fn(), get: vi.fn(), run: vi.fn(), exec: vi.fn() },
    widgets: {
      list: vi.fn(async () => [{ moduleUrl: "menu-sprout-widget://broken/widget.js" }, { moduleUrl: "menu-sprout-widget://clock/widget.js" }]),
    },
    background: { onUpdate: vi.fn(() => () => undefined) },
    layout: { get: vi.fn(async () => null) },
    popover: {
      setContentHeight: vi.fn(async () => ({ ok: true })),
      setContentSize: vi.fn(async () => ({ ok: true })),
      getVisibility: vi.fn(async () => ({ visible: true })),
      onVisibility: vi.fn(() => () => undefined),
    },
    settings: { get: vi.fn(async () => settings) },
    app: {
      quit: vi.fn(async () => ({ ok: true })),
      getUpdateStatus: vi.fn(async () => ({ currentVersion: "0.0.0", latestVersion: null, updateAvailable: false, releaseUrl: null })),
      openReleasePage: vi.fn(async () => ({ ok: true })),
    },
  };
  runtimeModules.set("menu-sprout-widget://broken/widget.js", { quotaWidget: throwingWidget() });
  runtimeModules.set("menu-sprout-widget://clock/widget.js", { clockWidget: goodWidget });
  window.menuSprout = api as unknown as MenuSproutApi;
  return api;
}

const pendingSession: GitSessionSnapshot = {
  startedClean: true,
  canSave: true,
  canRollback: true,
  head: "abc123",
  message: "Review the generated repo changes, then Save or Rollback.",
  dirty: true,
  changes: [{ type: "extension", extensionId: "quota", kind: "updated" }],
};

describe("widget error isolation", () => {
  it("keeps a good widget rendering next to one that throws", () => {
    silenceCaughtRenderErrors();

    const { container } = render(<WidgetHost widgets={[throwingWidget(), goodWidget]} layout={null} />);

    expect(screen.getByText("09:41")).toBeTruthy();
    const card = container.querySelector('article.widget[data-widget-id="quota"]');
    expect(card?.querySelector('[role="alert"]')?.textContent).toContain("Quota failed to render");
    expect(card?.textContent).toContain("quota.used is undefined");
  });

  it("isolates a throwing widget placed by an agent-authored layout", () => {
    silenceCaughtRenderErrors();
    const layout: MenuSproutLayout = ({ widgets, renderWidget }) => (
      <div data-testid="grid">{widgets.map((widget) => <div key={widget.id}>{renderWidget(widget.id)}</div>)}</div>
    );

    render(<WidgetHost widgets={[throwingWidget(), goodWidget]} layout={layout} />);

    // The layout itself survives; only the broken widget's slot shows the error card.
    expect(screen.getByTestId("grid")).toBeTruthy();
    expect(screen.getByText("09:41")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Quota failed to render");
  });

  it("shows only a sanitized one-line reason, never a stack or local paths", () => {
    silenceCaughtRenderErrors();
    const message =
      "Cannot read properties of undefined (reading 'used') at /Users/someone/.menu-sprout/extensions/quota/widget.tsx:12\n    at render (file:///Users/someone/.menu-sprout/compiled/quota.js:4:9)";

    render(<WidgetHost widgets={[throwingWidget(message)]} layout={null} />);

    const text = screen.getByRole("alert").textContent ?? "";
    expect(text).toContain("Cannot read properties of undefined (reading 'used')");
    expect(text).toContain("widget.tsx:12");
    expect(text).not.toContain("/Users/someone");
    expect(text).not.toContain("at render");
  });

  it("recovers when the widget module is replaced with a working version", () => {
    silenceCaughtRenderErrors();
    const { rerender } = render(<WidgetHost widgets={[throwingWidget()]} layout={null} />);
    expect(screen.queryByRole("alert")).not.toBeNull();

    rerender(<WidgetHost widgets={[{ id: "quota", title: "Quota", render: () => <span>42%</span> }]} layout={null} />);

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("42%")).toBeTruthy();
  });

  it("keeps the header and agent chat mounted when a discovered widget throws", async () => {
    silenceCaughtRenderErrors();
    installAppApi();

    render(<App />);

    await waitFor(() => expect(screen.getByText("09:41")).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toContain("Quota failed to render");
    expect(screen.getByLabelText("reload layout")).toBeTruthy();
    expect(screen.getByLabelText("open settings")).toBeTruthy();
    expect(screen.getByLabelText("quit menu_sprout")).toBeTruthy();
    expect(screen.getByPlaceholderText("talk to the sprout")).toBeTruthy();
  });

  it("pre-fills the composer from the error card without sending anything", async () => {
    silenceCaughtRenderErrors();
    const api = installAppApi();

    render(<App />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Undo last turn" })).toBeNull();
    expect(screen.queryByText("Keep or undo the last change first")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Ask the agent to fix" }));

    const composer = screen.getByPlaceholderText("talk to the sprout") as HTMLTextAreaElement;
    await waitFor(() => expect(composer.value).toContain("Quota"));
    expect(composer.value).toContain("quota.used is undefined");
    expect(api.agent.send).not.toHaveBeenCalled();
  });

  it("offers Undo last turn and disables Ask the agent to fix while a Keep/Undo session is open", async () => {
    silenceCaughtRenderErrors();
    const api = installAppApi({ session: pendingSession });

    render(<App />);
    const undo = await screen.findByRole("button", { name: "Undo last turn" });
    const ask = screen.getByRole("button", { name: "Ask the agent to fix" }) as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("Keep or undo the last change first");

    fireEvent.click(ask);
    const composer = screen.getByPlaceholderText("talk to the sprout") as HTMLTextAreaElement;
    expect(composer.value).toBe("");

    fireEvent.click(undo);

    await waitFor(() => expect(api.git.rollback).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Undo last turn" })).toBeNull());
    expect((screen.getByRole("button", { name: "Ask the agent to fix" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText("Keep or undo the last change first")).toBeNull();
  });
});

describe("settings section error isolation", () => {
  function installThrowingSettingsSection() {
    runtimeModules.set("menu-sprout-widget://broken/widget.js", {
      quotaSettings: {
        extensionId: "quota",
        title: "QUOTA",
        render: () => {
          throw new Error("quota.plan is undefined");
        },
      },
    });
  }

  it("shows the error card with Undo primary and Ask disabled while a Keep/Undo session is open", async () => {
    silenceCaughtRenderErrors();
    const api = installAppApi({ session: pendingSession });
    installThrowingSettingsSection();

    render(<App />);
    await screen.findByRole("button", { name: "Keep" });
    fireEvent.click(screen.getByLabelText("open settings"));

    const settings = screen.getByRole("dialog", { name: "settings" });
    const alert = await within(settings).findByRole("alert");
    expect(alert.textContent).toContain("QUOTA settings failed to render");
    expect(alert.textContent).toContain("Keep or undo the last change first");
    expect((within(alert).getByRole("button", { name: "Ask the agent to fix" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(within(alert).getByRole("button", { name: "Undo last turn" }));
    await waitFor(() => expect(api.git.rollback).toHaveBeenCalledTimes(1));
  });

  it("closes settings and pre-fills the composer when asked to fix a section", async () => {
    silenceCaughtRenderErrors();
    const api = installAppApi();
    installThrowingSettingsSection();

    render(<App />);
    fireEvent.click(screen.getByLabelText("open settings"));
    const alert = await within(screen.getByRole("dialog", { name: "settings" })).findByRole("alert");
    expect(within(alert).queryByRole("button", { name: "Undo last turn" })).toBeNull();

    fireEvent.click(within(alert).getByRole("button", { name: "Ask the agent to fix" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "settings" })).toBeNull());
    const composer = screen.getByPlaceholderText("talk to the sprout") as HTMLTextAreaElement;
    await waitFor(() => expect(composer.value).toContain("quota.plan is undefined"));
    expect(api.agent.send).not.toHaveBeenCalled();
  });
});

describe("useViewRefresh", () => {
  it("refreshes a widget on its interval", () => {
    vi.useFakeTimers();
    const refreshView = vi.fn();

    renderHook(() => useViewRefresh({ id: "quota", viewRefreshIntervalMs: 1000, refreshView }));

    expect(refreshView).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(2500));

    expect(refreshView).toHaveBeenCalledTimes(3);
  });

  it("pauses the interval while the popover is hidden and resumes on show", () => {
    vi.useFakeTimers();
    const popover = installPopoverVisibility();
    const refreshView = vi.fn();

    renderHook(() => useViewRefresh({ id: "quota", viewRefreshIntervalMs: 1000, refreshView }));
    expect(refreshView).toHaveBeenCalledTimes(1); // initial mount refresh

    act(() => popover.emit(false)); // popover hidden
    act(() => vi.advanceTimersByTime(5000));
    expect(refreshView).toHaveBeenCalledTimes(1); // no ticks while hidden

    act(() => popover.emit(true)); // popover shown again
    expect(refreshView).toHaveBeenCalledTimes(2); // refreshes immediately on show
    act(() => vi.advanceTimersByTime(2000));
    expect(refreshView).toHaveBeenCalledTimes(4); // interval resumed
  });

  it("does not start the interval when mounted while the popover is hidden", async () => {
    vi.useFakeTimers();
    const popover = installPopoverVisibility(false);
    const refreshView = vi.fn();

    renderHook(() => useViewRefresh({ id: "quota", viewRefreshIntervalMs: 1000, refreshView }));
    await act(async () => {});
    act(() => vi.advanceTimersByTime(5000));

    expect(refreshView).not.toHaveBeenCalled();

    act(() => popover.emit(true));

    expect(refreshView).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(2000));
    expect(refreshView).toHaveBeenCalledTimes(3);
  });

  it("refreshes a widget without an interval each time the popover is shown", () => {
    const popover = installPopoverVisibility();
    const refreshView = vi.fn();

    renderHook(() => useViewRefresh({ id: "quota", refreshView }));
    expect(refreshView).toHaveBeenCalledTimes(1);

    act(() => popover.emit(false));
    expect(refreshView).toHaveBeenCalledTimes(1);

    act(() => popover.emit(true));
    expect(refreshView).toHaveBeenCalledTimes(2);
  });
});

describe("WidgetHost", () => {
  it("honors a refreshable widget's declared view refresh interval", () => {
    vi.useFakeTimers();
    const refreshView = vi.fn();
    const widget: RefreshableMenuSproutWidget = {
      id: "quota",
      title: "quota",
      viewRefreshIntervalMs: 1000,
      refreshView,
      render: () => null,
    };

    render(<WidgetHost widgets={[widget]} />);

    expect(refreshView).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(2500));

    expect(refreshView).toHaveBeenCalledTimes(3);
  });

  it("tags each widget card with its id so a capture can be cropped to it", () => {
    const widgets: RefreshableMenuSproutWidget[] = [
      { id: "quota", title: "quota", render: () => <span>42%</span> },
      { id: "clock", title: "clock", render: () => <span>09:41</span> },
    ];

    const { container } = render(<WidgetHost widgets={widgets} />);

    const cards = Array.from(container.querySelectorAll("article.widget[data-widget-id]"));
    expect(cards.map((card) => card.getAttribute("data-widget-id"))).toEqual(["quota", "clock"]);
    expect(cards[0].textContent).toBe("42%");
  });

  it("ignores runtime widget exports without refresh callbacks", () => {
    expect(
      widgetsFromModule({
        stale: {
          id: "stale",
          title: "Stale",
          viewRefreshIntervalMs: 1000,
          render: () => null,
        },
      }),
    ).toEqual([]);
  });
});
