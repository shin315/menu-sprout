/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WidgetHost } from "../src/renderer/menu/WidgetHost";
import type { MenuSproutApi, RefreshableMenuSproutWidget } from "../src/shared/contracts";

function installMenuSproutApi(widgets: MenuSproutApi["widgets"]) {
  window.menuSprout = {
    recipes: { list: vi.fn(async () => []) },
    git: {
      save: vi.fn(async () => ({ ok: true })),
      rollback: vi.fn(async () => ({ ok: true })),
      status: vi.fn(async () => null),
    },
    agent: {
      send: vi.fn(async () => ({ assistantText: "done" })),
      onStatus: vi.fn(() => () => undefined),
      getActiveTurn: vi.fn(async () => null),
      cancel: vi.fn(async () => ({ ok: true })),
      newConversation: vi.fn(async () => ({ ok: true })),
    },
    capabilities: {
      list: vi.fn(async () => []),
      invoke: vi.fn(async () => undefined) as MenuSproutApi["capabilities"]["invoke"],
    },
    db: {
      query: vi.fn(async () => []),
      get: vi.fn(async () => undefined),
      run: vi.fn(async () => ({ changes: 0, lastInsertRowid: 0 })),
      exec: vi.fn(async () => undefined),
    },
    widgets,
    background: { onUpdate: vi.fn(() => () => undefined) },
    layout: { get: vi.fn(async () => null) },
    popover: {
      setContentHeight: vi.fn(async () => ({ ok: true })),
      setContentSize: vi.fn(async () => ({ ok: true })),
      getVisibility: vi.fn(async () => ({ visible: true })),
      onVisibility: vi.fn(() => () => undefined),
    },
    settings: {
      get: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setOpenAtLogin: vi.fn(async (openAtLogin: boolean) => ({ openAtLogin, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setTheme: vi.fn(async (theme: string) => ({ openAtLogin: false, agentName: "claude", agents: [], theme, appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setAppearance: vi.fn(async (appearance: "light" | "dark" | "system") => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setTelemetryEnabled: vi.fn(async (enabled: boolean) => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled, source: "preference" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setAgent: vi.fn(async (agentName: string) => ({ openAtLogin: false, agentName, agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      addAgent: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      updateAgent: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      removeAgent: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setAgentModel: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
      setTurnLimits: vi.fn(async () => ({ openAtLogin: false, agentName: "claude", agents: [], theme: "default", appearance: "system" as const, telemetry: { enabled: true, source: "default" as const, configured: false }, agentModels: [], turnLimits: {} })),
    },
    app: {
      quit: vi.fn(async () => ({ ok: true })),
      getUpdateStatus: vi.fn(async () => ({ currentVersion: "0.0.0", latestVersion: null, updateAvailable: false, releaseUrl: null })),
      openReleasePage: vi.fn(async () => ({ ok: true })),
    },
  };
}

afterEach(() => {
  cleanup();
  delete window.menuSprout;
});

describe("WidgetHost", () => {
  it("loads runtime widgets and hides the hello-world fallback", async () => {
    const cpuWidget: RefreshableMenuSproutWidget = {
      id: "cpu-temp",
      title: "CPU TEMP",
      render: () => <span>42c</span>,
    };
    installMenuSproutApi({
      list: vi.fn(async () => [
        { id: "cpu-temp.widget", extensionId: "cpu-temp", moduleUrl: "/@fs/cpu-temp/widget.tsx" },
      ]),
    });

    render(<WidgetHost runtimeImporter={async () => ({ cpuWidget })} runtimeRefreshIntervalMs={0} />);

    expect(await screen.findByText("42c")).toBeTruthy();
    expect(screen.queryByText("hello sprout")).toBeNull();
  });

  it("shows hello-world when no runtime widgets are discovered", async () => {
    installMenuSproutApi({ list: vi.fn(async () => []) });

    render(<WidgetHost runtimeImporter={async () => ({})} runtimeRefreshIntervalMs={0} />);

    expect(await screen.findByText("hello sprout")).toBeTruthy();
  });
});
