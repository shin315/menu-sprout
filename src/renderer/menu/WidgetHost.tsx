import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { MenuSproutLayout, MenuSproutLayoutWidget, RefreshableMenuSproutWidget } from "../../shared/contracts";
import { helloWorldWidget } from "../../../extensions/hello-world/widget";
import {
  ensureWidgetStylesheet,
  importRuntimeModule,
  loadExtensionModules,
  type RuntimeModuleImporter,
} from "../extension-modules";
import { RenderErrorBoundary, RenderErrorCard } from "./RenderErrorBoundary";
import { useViewRefresh } from "./useViewRefresh";

export type RuntimeWidgetImporter = RuntimeModuleImporter;

const DEFAULT_RUNTIME_REFRESH_INTERVAL_MS = 1000;

// Each widget renders inside its own error boundary, so a widget that throws shows
// a compact error card in its slot while every other widget keeps rendering. The
// boundary resets when the widget object changes (its module was rebuilt).
function WidgetCard({ widget }: { widget: RefreshableMenuSproutWidget }) {
  return (
    <RenderErrorBoundary
      resetKey={widget}
      fallback={(error) => (
        <article className="widget" data-widget-id={widget.id}>
          <RenderErrorCard
            title={`${widget.title} failed to render`}
            error={error}
            fixSubject={`The "${widget.title}" widget (id "${widget.id}")`}
          />
        </article>
      )}
    >
      <WidgetCardBody widget={widget} />
    </RenderErrorBoundary>
  );
}

function WidgetCardBody({ widget }: { widget: RefreshableMenuSproutWidget }) {
  // Drives automatic refresh only: once each time the popover opens, plus the
  // optional interval while visible. There is no manual refresh control.
  useViewRefresh({
    id: widget.id,
    viewRefreshIntervalMs: widget.viewRefreshIntervalMs,
    refreshView: widget.refreshView ?? (() => undefined),
  });

  // No host-drawn title: the extension owns its entire area.
  // data-widget-id lets the host's visual self-check crop a capture to this widget.
  return (
    <article className="widget" data-widget-id={widget.id}>
      {widget.render()}
    </article>
  );
}

// The built-in layout: the historical stacked column, used whenever the
// workspace ships no `layout.tsx`. Keeps old extensions and the no-layout case
// rendering exactly as before.
function WidgetColumn({ widgets }: { widgets: RefreshableMenuSproutWidget[] }) {
  return (
    <div className="widget-host">
      {widgets.map((widget) => (
        <WidgetCard key={widget.id} widget={widget} />
      ))}
    </div>
  );
}

function WidgetCanvas({ layout, widgets }: { layout: MenuSproutLayout | null; widgets: RefreshableMenuSproutWidget[] }) {
  const byId = useMemo(() => new Map(widgets.map((widget) => [widget.id, widget] as const)), [widgets]);
  const renderWidget = useCallback(
    (id: string): ReactNode => {
      const widget = byId.get(id);
      return widget ? <WidgetCard widget={widget} /> : null;
    },
    [byId],
  );

  if (!layout) return <WidgetColumn widgets={widgets} />;

  // The layout decides the arrangement and its own width; [data-bm-canvas] marks
  // it so the host measures that intrinsic width plus chrome and resizes the
  // popover to fit without clipping the canvas.
  const meta: MenuSproutLayoutWidget[] = widgets.map(({ id, title }) => ({ id, title }));
  const Layout = layout;
  return (
    <div className="widget-canvas" data-bm-canvas>
      {/* A layout that throws while rendering falls back to the built-in column
          and recovers once the layout module changes (e.g. the agent fixes it). */}
      <RenderErrorBoundary resetKey={layout} fallback={() => <WidgetColumn widgets={widgets} />}>
        <Layout widgets={meta} renderWidget={renderWidget} />
      </RenderErrorBoundary>
    </div>
  );
}

type WidgetHostProps = {
  widgets?: RefreshableMenuSproutWidget[];
  runtimeImporter?: RuntimeWidgetImporter;
  runtimeRefreshIntervalMs?: number;
  // Test/override hook: a custom layout component (or null for the built-in
  // column), bypassing runtime discovery. Undefined means discover at runtime.
  layout?: MenuSproutLayout | null;
  layoutImporter?: RuntimeModuleImporter;
};

export function WidgetHost({ widgets, runtimeImporter, runtimeRefreshIntervalMs, layout, layoutImporter }: WidgetHostProps) {
  const runtimeWidgets = useRuntimeWidgets({
    enabled: widgets === undefined,
    importer: runtimeImporter,
    refreshIntervalMs: runtimeRefreshIntervalMs,
  });
  const visibleWidgets = widgets ?? (runtimeWidgets.length > 0 ? runtimeWidgets : [helloWorldWidget]);

  const runtimeLayout = useRuntimeLayout({
    enabled: widgets === undefined && layout === undefined,
    importer: layoutImporter,
    refreshIntervalMs: runtimeRefreshIntervalMs,
  });
  const activeLayout = layout === undefined ? runtimeLayout : layout;

  return <WidgetCanvas layout={activeLayout} widgets={visibleWidgets} />;
}

function useRuntimeWidgets({
  enabled,
  importer = importRuntimeModule,
  refreshIntervalMs = DEFAULT_RUNTIME_REFRESH_INTERVAL_MS,
}: {
  enabled: boolean;
  importer?: RuntimeWidgetImporter;
  refreshIntervalMs?: number;
}) {
  const [widgets, setWidgets] = useState<RefreshableMenuSproutWidget[]>([]);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;

    async function refresh() {
      const loadedWidgets = await loadRuntimeWidgets(importer);
      if (!cancelled) setWidgets(loadedWidgets);
    }

    void refresh();
    if (!refreshIntervalMs || refreshIntervalMs <= 0) {
      return () => {
        cancelled = true;
      };
    }

    const timer = window.setInterval(() => void refresh(), refreshIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, importer, refreshIntervalMs]);

  return widgets;
}

// Polls for the root layout module on the same cadence as widget discovery, so
// editing `layout.tsx` hot-reloads the arrangement. Returns null when there is
// no layout module (the canvas then renders the built-in column).
function useRuntimeLayout({
  enabled,
  importer = importRuntimeModule,
  refreshIntervalMs = DEFAULT_RUNTIME_REFRESH_INTERVAL_MS,
}: {
  enabled: boolean;
  importer?: RuntimeModuleImporter;
  refreshIntervalMs?: number;
}) {
  const [layout, setLayout] = useState<MenuSproutLayout | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;

    async function refresh() {
      const loaded = await loadRuntimeLayout(importer);
      // setState updater form because the stored value is itself a function.
      if (!cancelled) setLayout(() => loaded);
    }

    void refresh();
    if (!refreshIntervalMs || refreshIntervalMs <= 0) {
      return () => {
        cancelled = true;
      };
    }

    const timer = window.setInterval(() => void refresh(), refreshIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, importer, refreshIntervalMs]);

  return layout;
}

export async function loadRuntimeWidgets(importer: RuntimeWidgetImporter = importRuntimeModule) {
  const modules = await loadExtensionModules(importer);
  return modules.flatMap(widgetsFromModule);
}

export async function loadRuntimeLayout(
  importer: RuntimeModuleImporter = importRuntimeModule,
): Promise<MenuSproutLayout | null> {
  try {
    // Optional-chain `layout` too: an older host bridge without it must degrade
    // to the built-in column, not throw an unhandled rejection.
    const descriptor = await window.menuSprout?.layout?.get?.();
    if (!descriptor) return null;
    if (descriptor.cssUrl) ensureWidgetStylesheet(descriptor.cssUrl);
    const module = await importer(descriptor.moduleUrl);
    const layout = layoutFromModule(module);
    if (!layout) console.warn("[menu-sprout] layout.tsx has no default-export component; using the built-in column");
    return layout;
  } catch (error) {
    // A broken layout module must not blank the menu - fall back to the column,
    // but surface why so a failed custom layout is debuggable in dev.
    console.warn("[menu-sprout] failed to load layout.tsx; using the built-in column", error);
    return null;
  }
}

export function layoutFromModule(module: unknown): MenuSproutLayout | null {
  if (!module || typeof module !== "object") return null;
  const candidate = (module as { default?: unknown }).default;
  return typeof candidate === "function" ? (candidate as MenuSproutLayout) : null;
}

export function widgetsFromModule(module: unknown): RefreshableMenuSproutWidget[] {
  if (!module || typeof module !== "object") return [];
  const exports = Object.values(module as Record<string, unknown>);
  return exports.filter(isRefreshableMenuSproutWidget);
}

function isRefreshableMenuSproutWidget(value: unknown): value is RefreshableMenuSproutWidget {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RefreshableMenuSproutWidget>;
  const hasRefresh = typeof candidate.refreshView === "function";
  const hasInvalidRefresh = candidate.refreshView !== undefined && !hasRefresh;
  const hasInvalidInterval = candidate.viewRefreshIntervalMs !== undefined && !hasRefresh;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.render === "function" &&
    !hasInvalidRefresh &&
    !hasInvalidInterval
  );
}
