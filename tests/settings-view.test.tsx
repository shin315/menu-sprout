// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/renderer/App";
import { SettingsView } from "../src/renderer/settings/SettingsView";
import type {
  MenuSproutApi,
  MenuSproutCustomAgentInput,
  MenuSproutSettings,
  MenuSproutSettingsSection,
  PopoverVisibilityState,
} from "../src/shared/contracts";
import { APPEARANCES, THEMES } from "../src/shared/themes";
import { agentModelSettings } from "../src/shared/agent-options";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function installMenuSproutApi(settings?: Partial<MenuSproutSettings>): MenuSproutApi {
  const base: MenuSproutSettings = {
    theme: "default",
    appearance: "system",
    openAtLogin: false,
    agentName: "claude",
    agents: [{ name: "claude", label: "Claude Code", available: true }],
    telemetry: { enabled: true, source: "default", configured: true },
    agentModels: [],
    turnLimits: {},
    ...settings,
  };
  let current = base;
  const api: MenuSproutApi = {
    recipes: { list: vi.fn(async () => []) },
    git: { save: vi.fn(async () => ({ ok: true })), rollback: vi.fn(async () => ({ ok: true })), status: vi.fn(async () => null) },
    agent: { send: vi.fn(async () => ({ assistantText: "" })), onStatus: vi.fn(() => () => undefined), getActiveTurn: vi.fn(async () => null), cancel: vi.fn(async () => ({ ok: true })), newConversation: vi.fn(async () => ({ ok: true })) },
    capabilities: { list: vi.fn(async () => []), invoke: vi.fn(async () => undefined) as MenuSproutApi["capabilities"]["invoke"] },
    db: {
      query: vi.fn(async () => []),
      get: vi.fn(async () => undefined),
      run: vi.fn(async () => ({ changes: 0, lastInsertRowid: 0 })),
      exec: vi.fn(async () => undefined),
    },
    widgets: { list: vi.fn(async () => []) },
    background: { onUpdate: vi.fn(() => () => undefined) },
    layout: { get: vi.fn(async () => null) },
    popover: {
      setContentHeight: vi.fn(async () => ({ ok: true })),
      setContentSize: vi.fn(async () => ({ ok: true })),
      getVisibility: vi.fn(async () => ({ visible: true })),
      onVisibility: vi.fn(() => () => undefined),
    },
    settings: {
      get: vi.fn(async () => current),
      setOpenAtLogin: vi.fn(async (openAtLogin: boolean) => {
        current = { ...current, openAtLogin };
        return current;
      }),
      setTheme: vi.fn(async (theme: string) => {
        current = { ...current, theme };
        return current;
      }),
      setAppearance: vi.fn(async (appearance: MenuSproutSettings["appearance"]) => {
        current = { ...current, appearance };
        return current;
      }),
      setTelemetryEnabled: vi.fn(async (enabled: boolean) => {
        current = { ...current, telemetry: { ...current.telemetry, enabled, source: "preference" } };
        return current;
      }),
      setAgent: vi.fn(async (agentName: string) => {
        current = { ...current, agentName };
        return current;
      }),
      addAgent: vi.fn(async (input: MenuSproutCustomAgentInput) => {
        current = {
          ...current,
          agents: [
            ...current.agents,
            { name: input.name, label: input.label ?? input.name, available: true, custom: true, command: input.command },
          ],
        };
        return current;
      }),
      updateAgent: vi.fn(async (name: string, input: { label?: string; command: string }) => {
        current = {
          ...current,
          agents: current.agents.map((agent) =>
            agent.name === name ? { ...agent, label: input.label ?? agent.label, command: input.command } : agent,
          ),
        };
        return current;
      }),
      removeAgent: vi.fn(async (name: string) => {
        current = { ...current, agents: current.agents.filter((agent) => agent.name !== name) };
        return current;
      }),
      setAgentModel: vi.fn(async (agentName: string, input: { model?: string; effort?: string }) => {
        current = {
          ...current,
          agentModels: current.agentModels.map((agent) => {
            if (agent.name !== agentName) return agent;
            const { model: _model, effort: _effort, problem: _problem, ...rest } = agent;
            return { ...rest, ...(input.model ? { model: input.model } : {}), ...(input.effort ? { effort: input.effort } : {}) };
          }),
        };
        return current;
      }),
      setTurnLimits: vi.fn(async (limits: { maxTurnMinutes?: number | null; maxToolCalls?: number | null }) => {
        if (limits.maxToolCalls !== null && limits.maxToolCalls !== undefined && !Number.isInteger(limits.maxToolCalls)) {
          throw new Error(
            "Error invoking remote method 'menu-sprout:settings:set-turn-limits': Error: Max tool calls must be a whole number from 1 to 1000, or off.",
          );
        }
        current = {
          ...current,
          turnLimits: {
            ...(limits.maxTurnMinutes ? { maxTurnMinutes: limits.maxTurnMinutes } : {}),
            ...(limits.maxToolCalls ? { maxToolCalls: limits.maxToolCalls } : {}),
          },
        };
        return current;
      }),
    },
    app: {
      quit: vi.fn(async () => ({ ok: true })),
      getUpdateStatus: vi.fn(async () => ({ currentVersion: "0.0.0", latestVersion: null, updateAvailable: false, releaseUrl: null })),
      openReleasePage: vi.fn(async () => ({ ok: true })),
    },
  };
  window.menuSprout = api;
  return api;
}

afterEach(() => {
  cleanup();
  delete window.menuSprout;
  document.documentElement.removeAttribute("data-theme");
});

describe("settings view", () => {
  it("isolates a throwing extension settings section from the other sections and built-in settings", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    installMenuSproutApi();
    const sections: MenuSproutSettingsSection[] = [
      {
        extensionId: "calendar",
        title: "CALENDAR",
        render: () => {
          throw new Error("calendar.accounts is undefined");
        },
      },
      { extensionId: "weather", title: "WEATHER", render: () => <span>city: Hanoi</span> },
    ];

    render(<SettingsView sections={sections} />);

    expect(await screen.findByRole("combobox", { name: "theme" })).toBeTruthy();
    expect(screen.getByText("city: Hanoi")).toBeTruthy();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("CALENDAR settings failed to render");
    expect(alert.textContent).toContain("calendar.accounts is undefined");
    vi.restoreAllMocks();
  });

  it("loads saved preferences when Strict Mode replays the mount effect", async () => {
    installMenuSproutApi({ theme: "paper-sketch", appearance: "dark" });
    render(<StrictMode><SettingsView /></StrictMode>);

    await waitFor(() => expect((screen.getByRole("combobox", { name: "theme" }) as HTMLSelectElement).value).toBe("paper-sketch"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("paper-sketch");
    expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
  });

  it("changes the theme preference and applies it to the document", async () => {
    const api = installMenuSproutApi({ theme: "paper-sketch" });
    render(<SettingsView />);

    const select = (await screen.findByRole("combobox", { name: "theme" })) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("paper-sketch"));
    expect(Array.from(select.options, (option) => option.value)).toEqual(THEMES.map((theme) => theme.id));

    fireEvent.change(select, { target: { value: "vibrant-glass" } });
    expect(api.settings.setTheme).toHaveBeenCalledWith("vibrant-glass");
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("vibrant-glass"));
  });

  it("shows the saved appearance and switches between light, dark, and system", async () => {
    const api = installMenuSproutApi({ appearance: "dark" });
    render(<SettingsView />);

    const group = await screen.findByRole("radiogroup", { name: "appearance" });
    const options = Array.from(group.querySelectorAll<HTMLButtonElement>("[role=radio]"));
    expect(options.map((option) => option.textContent)).toEqual(APPEARANCES.map((appearance) => appearance.label));
    await waitFor(() => expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true"));

    fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(api.settings.setAppearance).toHaveBeenCalledWith("light");
    await waitFor(() => expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("false");

    fireEvent.click(screen.getByRole("radio", { name: "System" }));
    expect(api.settings.setAppearance).toHaveBeenLastCalledWith("system");
    await waitFor(() => expect(screen.getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe("true"));
  });

  it("reverts the appearance control when saving fails", async () => {
    const api = installMenuSproutApi({ appearance: "system" });
    vi.mocked(api.settings.setAppearance).mockRejectedValueOnce(new Error("disk full"));
    render(<SettingsView />);

    await waitFor(() => expect(screen.getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    await waitFor(() => expect(api.settings.setAppearance).toHaveBeenCalledWith("dark"));
    await waitFor(() => expect(screen.getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe("true"));
  });

  it.each(["success", "failure"] as const)("ignores stale %s responses for both appearance controls", async (outcome) => {
    const api = installMenuSproutApi();
    const initial = await api.settings.get();
    const olderTheme = deferred<MenuSproutSettings>();
    const latestTheme = deferred<MenuSproutSettings>();
    const olderAppearance = deferred<MenuSproutSettings>();
    const latestAppearance = deferred<MenuSproutSettings>();
    vi.mocked(api.settings.setTheme).mockReturnValueOnce(olderTheme.promise).mockReturnValueOnce(latestTheme.promise);
    vi.mocked(api.settings.setAppearance).mockReturnValueOnce(olderAppearance.promise).mockReturnValueOnce(latestAppearance.promise);
    render(<SettingsView />);

    const select = screen.getByRole("combobox", { name: "theme" }) as HTMLSelectElement;
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("default"));
    fireEvent.change(select, { target: { value: "paper-sketch" } });
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    fireEvent.change(select, { target: { value: "calm-pastel" } });
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));

    await act(async () => {
      latestTheme.resolve({ ...initial, theme: "calm-pastel" });
      latestAppearance.resolve({ ...initial, appearance: "light" });
    });
    await act(async () => {
      if (outcome === "success") {
        olderTheme.resolve({ ...initial, theme: "paper-sketch" });
        olderAppearance.resolve({ ...initial, appearance: "dark" });
      } else {
        olderTheme.reject(new Error("disk full"));
        olderAppearance.reject(new Error("disk full"));
      }
    });

    expect(select.value).toBe("calm-pastel");
    expect(document.documentElement.getAttribute("data-theme")).toBe("calm-pastel");
    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");
  });

  it.each(["older-first", "latest-first"] as const)("reconciles both failed requests from persisted settings in %s order", async (order) => {
    const api = installMenuSproutApi();
    const initial = await api.settings.get();
    const olderTheme = deferred<MenuSproutSettings>();
    const latestTheme = deferred<MenuSproutSettings>();
    const olderAppearance = deferred<MenuSproutSettings>();
    const latestAppearance = deferred<MenuSproutSettings>();
    vi.mocked(api.settings.setTheme).mockReturnValueOnce(olderTheme.promise).mockReturnValueOnce(latestTheme.promise);
    vi.mocked(api.settings.setAppearance).mockReturnValueOnce(olderAppearance.promise).mockReturnValueOnce(latestAppearance.promise);
    render(<SettingsView />);

    const select = screen.getByRole("combobox", { name: "theme" }) as HTMLSelectElement;
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("default"));
    fireEvent.change(select, { target: { value: "paper-sketch" } });
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    fireEvent.change(select, { target: { value: "calm-pastel" } });
    fireEvent.click(screen.getByRole("radio", { name: "Light" }));

    const first = order === "older-first" ? [olderTheme, olderAppearance] : [latestTheme, latestAppearance];
    const last = order === "older-first" ? [latestTheme, latestAppearance] : [olderTheme, olderAppearance];
    await act(async () => {
      for (const save of first) save.reject(new Error("disk full"));
    });
    await act(async () => {
      for (const save of last) save.reject(new Error("disk full"));
    });

    expect(select.value).toBe(initial.theme);
    expect(document.documentElement.getAttribute("data-theme")).toBe(initial.theme);
    expect(screen.getByRole("radio", { name: "System" }).getAttribute("aria-checked")).toBe("true");
  });

  it("ignores delayed recovery reads after newer selections succeed", async () => {
    const api = installMenuSproutApi();
    const initial = await api.settings.get();
    render(<SettingsView />);
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("default"));
    const themeRecovery = deferred<MenuSproutSettings>();
    const appearanceRecovery = deferred<MenuSproutSettings>();
    vi.mocked(api.settings.get).mockReturnValueOnce(themeRecovery.promise).mockReturnValueOnce(appearanceRecovery.promise);
    vi.mocked(api.settings.setTheme).mockRejectedValueOnce(new Error("disk full"));
    vi.mocked(api.settings.setAppearance).mockRejectedValueOnce(new Error("disk full"));

    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "theme" }), { target: { value: "paper-sketch" } });
      fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    });
    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "theme" }), { target: { value: "calm-pastel" } });
      fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    });
    await act(async () => {
      themeRecovery.resolve(initial);
      appearanceRecovery.resolve(initial);
    });

    expect((screen.getByRole("combobox", { name: "theme" }) as HTMLSelectElement).value).toBe("calm-pastel");
    expect(document.documentElement.getAttribute("data-theme")).toBe("calm-pastel");
    expect(screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked")).toBe("true");
  });

  it("reconciles failed selections made before the initial settings load", async () => {
    const api = installMenuSproutApi({ theme: "paper-sketch", appearance: "dark" });
    const saved = await api.settings.get();
    const load = deferred<MenuSproutSettings>();
    vi.mocked(api.settings.get).mockReturnValueOnce(load.promise);
    vi.mocked(api.settings.setTheme).mockRejectedValueOnce(new Error("disk full"));
    vi.mocked(api.settings.setAppearance).mockRejectedValueOnce(new Error("disk full"));
    render(<SettingsView />);

    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "theme" }), { target: { value: "calm-pastel" } });
      fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    });
    await act(async () => {
      load.resolve(saved);
    });

    expect((screen.getByRole("combobox", { name: "theme" }) as HTMLSelectElement).value).toBe(saved.theme);
    expect(document.documentElement.getAttribute("data-theme")).toBe(saved.theme);
    expect(screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
  });

  it.each(["theme", "appearance", "both"] as const)("guards the initial snapshot independently after changing %s", async (control) => {
    const api = installMenuSproutApi({ theme: "paper-sketch", appearance: "dark" });
    const initial = await api.settings.get();
    const load = deferred<MenuSproutSettings>();
    vi.mocked(api.settings.get).mockReturnValueOnce(load.promise);
    render(<SettingsView />);

    const select = screen.getByRole("combobox", { name: "theme" }) as HTMLSelectElement;
    if (control !== "appearance") fireEvent.change(select, { target: { value: "calm-pastel" } });
    if (control !== "theme") fireEvent.click(screen.getByRole("radio", { name: "Light" }));
    await act(async () => {
      load.resolve(initial);
    });

    const expectedTheme = control === "appearance" ? "paper-sketch" : "calm-pastel";
    const expectedAppearance = control === "theme" ? "Dark" : "Light";
    expect(select.value).toBe(expectedTheme);
    expect(document.documentElement.getAttribute("data-theme")).toBe(expectedTheme);
    expect(screen.getByRole("radio", { name: expectedAppearance }).getAttribute("aria-checked")).toBe("true");
  });

  it("reconciles the document theme when saving fails after closing Settings", async () => {
    const api = installMenuSproutApi();
    const initial = await api.settings.get();
    const save = deferred<MenuSproutSettings>();
    vi.mocked(api.settings.setTheme).mockReturnValueOnce(save.promise);
    render(<App />);
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("default"));
    fireEvent.click(screen.getByRole("button", { name: "open settings" }));
    await screen.findByRole("combobox", { name: "theme" });
    fireEvent.change(screen.getByRole("combobox", { name: "theme" }), { target: { value: "paper-sketch" } });
    expect(document.documentElement.getAttribute("data-theme")).toBe("paper-sketch");
    fireEvent.click(screen.getByRole("button", { name: "close settings" }));

    await act(async () => {
      save.reject(new Error("disk full"));
    });

    expect(document.documentElement.getAttribute("data-theme")).toBe(initial.theme);
    expect(screen.queryByRole("combobox", { name: "theme" })).toBeNull();
  });

  it.each(["success", "failure"] as const)("ignores old theme %s after reopening Settings and choosing again", async (outcome) => {
    const api = installMenuSproutApi();
    const initial = await api.settings.get();
    const older = deferred<MenuSproutSettings>();
    vi.mocked(api.settings.setTheme).mockReturnValueOnce(older.promise);
    render(<App />);
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("default"));
    fireEvent.click(screen.getByRole("button", { name: "open settings" }));
    fireEvent.change(await screen.findByRole("combobox", { name: "theme" }), { target: { value: "paper-sketch" } });
    fireEvent.click(screen.getByRole("button", { name: "close settings" }));
    fireEvent.click(screen.getByRole("button", { name: "open settings" }));
    await act(async () => {
      fireEvent.change(screen.getByRole("combobox", { name: "theme" }), { target: { value: "calm-pastel" } });
    });
    const readsBeforeOldResponse = vi.mocked(api.settings.get).mock.calls.length;
    await act(async () => {
      if (outcome === "success") older.resolve({ ...initial, theme: "paper-sketch" });
      else older.reject(new Error("disk full"));
    });

    expect((screen.getByRole("combobox", { name: "theme" }) as HTMLSelectElement).value).toBe("calm-pastel");
    expect(document.documentElement.getAttribute("data-theme")).toBe("calm-pastel");
    expect(vi.mocked(api.settings.get).mock.calls.length).toBe(readsBeforeOldResponse);
  });

  it("opens settings from the header gear, toggles open-at-login, and returns to the menu", async () => {
    const api = installMenuSproutApi();
    render(<App />);

    // Menu view: composer present, no settings controls.
    expect(screen.getByPlaceholderText("talk to the sprout")).toBeTruthy();
    expect(screen.queryByText("launch at system start")).toBeNull();

    // Open settings.
    fireEvent.click(screen.getByRole("button", { name: "open settings" }));
    expect(await screen.findByText("launch at system start")).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "launch at system start" });
    expect(toggle).toBeTruthy();
    // Settings is an overlay: the agent composer stays mounted underneath (so its
    // state survives), but the covered default view is made inert.
    expect(screen.getByPlaceholderText("talk to the sprout")).toBeTruthy();
    expect(document.querySelector(".app-view")?.hasAttribute("inert")).toBe(true);

    // Toggle the setting.
    fireEvent.click(toggle);
    await waitFor(() => expect(api.settings.setOpenAtLogin).toHaveBeenCalledWith(true));

    // Return to the menu.
    fireEvent.click(screen.getByRole("button", { name: "close settings" }));
    expect(await screen.findByPlaceholderText("talk to the sprout")).toBeTruthy();
    expect(screen.queryByText("launch at system start")).toBeNull();
  });

  it("saves the privacy telemetry switch and reflects the saved choice", async () => {
    const api = installMenuSproutApi();
    render(<SettingsView sections={[]} />);

    const toggle = await screen.findByRole("switch", { name: "anonymous usage telemetry" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(toggle);
    await waitFor(() => expect(api.settings.setTelemetryEnabled).toHaveBeenCalledWith(false));
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByText("Off. Nothing is sent.")).toBeTruthy();
  });

  it("explains an environment opt-out and an unconfigured build truthfully", async () => {
    installMenuSproutApi({ telemetry: { enabled: false, source: "environment", configured: true } });
    render(<SettingsView sections={[]} />);

    expect(await screen.findByText(/Off because MENU_SPROUT_TELEMETRY is set/)).toBeTruthy();
    expect(screen.getByRole("switch", { name: "anonymous usage telemetry" }).getAttribute("aria-checked")).toBe("false");
    cleanup();

    installMenuSproutApi({ telemetry: { enabled: true, source: "default", configured: false } });
    render(<SettingsView sections={[]} />);
    expect(await screen.findByText(/An Umami host and website id are not both configured, so nothing is sent/)).toBeTruthy();
  });

  it("lists every data flow that leaves the Mac", async () => {
    installMenuSproutApi();
    render(<SettingsView sections={[]} />);

    const outbound = await screen.findByRole("list", { name: "what leaves this Mac" });
    const titles = Array.from(outbound.querySelectorAll("li > span:first-child"), (node) => node.textContent);
    expect(titles).toEqual([
      "usage telemetry",
      "your agent's model provider",
      "widget screenshots",
      "extension server code",
      "update check",
    ]);
    expect(outbound.textContent).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(outbound.textContent).toContain("macOS Keychain");
    expect(screen.getByRole("list", { name: "what stays on this Mac" }).textContent).toContain("one local SQLite database");
  });

  it("discloses launch-time telemetry configuration and update retries in Settings", async () => {
    installMenuSproutApi();
    render(<SettingsView sections={[]} />);

    const outbound = await screen.findByRole("list", { name: "what leaves this Mac" });
    const flows = Array.from(outbound.querySelectorAll("li"));
    const telemetry = flows.find((flow) => flow.firstElementChild?.textContent === "usage telemetry");
    expect(telemetry?.textContent).toContain("configured at build time or launch");
    expect(telemetry?.textContent).toContain(
      "Source checkouts and pnpm dev send nothing unless MENU_SPROUT_UMAMI_HOST and MENU_SPROUT_UMAMI_WEBSITE_ID are set at launch.",
    );

    const updates = flows.find((flow) => flow.firstElementChild?.textContent === "update check");
    expect(updates?.textContent).toContain("After the first successful response, checks are spaced at least 4 hours apart");
    expect(updates?.textContent).toContain("Until then, each status request can retry immediately after a failure");
    expect(updates?.textContent).toContain("Development builds make no request");
  });

  it("shows unavailable agents disabled with an install hint", async () => {
    installMenuSproutApi({
      agentName: "claude",
      agents: [
        { name: "claude", label: "Claude Code", available: true },
        { name: "codex", label: "Codex", available: false, installHint: "Install the Codex CLI." },
      ],
    });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "open settings" }));

    const codex = await screen.findByRole("radio", { name: /Codex/ });
    expect((codex as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Install the Codex CLI.")).toBeTruthy();
  });

  it("confirms before switching agents and calls setAgent on confirm", async () => {
    const api = installMenuSproutApi({
      agentName: "claude",
      agents: [
        { name: "claude", label: "Claude Code", available: true },
        { name: "codex", label: "Codex", available: true },
      ],
    });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "open settings" }));

    fireEvent.click(await screen.findByRole("radio", { name: /Codex/ }));

    // Confirmation must make the conversation-reset consequence clear.
    expect(await screen.findByText(/will reset the current conversation/i)).toBeTruthy();
    expect(api.settings.setAgent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /switch and reset/i }));
    await waitFor(() => expect(api.settings.setAgent).toHaveBeenCalledWith("codex"));
  });

  it("does not switch agents when the confirmation is cancelled", async () => {
    const api = installMenuSproutApi({
      agentName: "claude",
      agents: [
        { name: "claude", label: "Claude Code", available: true },
        { name: "codex", label: "Codex", available: true },
      ],
    });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "open settings" }));

    fireEvent.click(await screen.findByRole("radio", { name: /Codex/ }));
    fireEvent.click(await screen.findByRole("button", { name: /cancel/i }));

    await waitFor(() => expect(screen.queryByText(/will reset/i)).toBeNull());
    expect(api.settings.setAgent).not.toHaveBeenCalled();
  });

  it("disables agent switching with a visible reason when switching is blocked", async () => {
    const api = installMenuSproutApi({
      agentName: "claude",
      agentSwitchDisabledReason: "Save or Rollback the current agent changes before switching agents.",
      agents: [
        { name: "claude", label: "Claude Code", available: true },
        { name: "codex", label: "Codex", available: true },
      ],
    });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "open settings" }));

    const codex = await screen.findByRole("radio", { name: /Codex/ });

    expect((codex as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Save or Rollback the current agent changes before switching agents.")).toBeTruthy();
    fireEvent.click(codex);
    expect(screen.queryByText(/will reset the current conversation/i)).toBeNull();
    expect(api.settings.setAgent).not.toHaveBeenCalled();
  });

  it("renders a discovered extension settings section below app preferences", async () => {
    installMenuSproutApi();
    window.menuSprout!.widgets.list = vi.fn(async () => [
      { id: "calendar.widget", extensionId: "calendar", moduleUrl: "/@fs/calendar/widget.tsx" },
    ]);

    render(
      <SettingsView
        runtimeImporter={async () => ({
          calendarSettings: {
            extensionId: "calendar",
            title: "CALENDAR",
            render: () => <span>which calendar</span>,
          },
        })}
      />,
    );

    // App preference still renders first.
    expect(await screen.findByText("launch at system start")).toBeTruthy();
    // The extension's section title (host-drawn frame) and body both appear.
    expect(await screen.findByText("CALENDAR")).toBeTruthy();
    expect(screen.getByText("which calendar")).toBeTruthy();
  });

  async function openSettings() {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "open settings" }));
    await screen.findByText("launch at system start");
  }

  it("adds a custom ACP agent through the dialog", async () => {
    const api = installMenuSproutApi({ agents: [{ name: "claude", label: "Claude Code", available: true }] });
    await openSettings();

    fireEvent.click(screen.getByRole("button", { name: /add agent/i }));
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "gemini" } });
    fireEvent.change(screen.getByLabelText(/^command$/i), { target: { value: "gemini acp" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(api.settings.addAgent).toHaveBeenCalledWith({ name: "gemini", label: undefined, command: "gemini acp" }),
    );
    expect(await screen.findByRole("radio", { name: /Gemini/i })).toBeTruthy();
  });

  it("shows edit/remove controls only for custom agents", async () => {
    installMenuSproutApi({
      agents: [
        { name: "claude", label: "Claude Code", available: true },
        { name: "gemini", label: "Gemini", available: true, custom: true, command: "gemini acp" },
      ],
    });
    await openSettings();

    expect(screen.queryByRole("button", { name: /remove Claude Code/i })).toBeNull();
    expect(await screen.findByRole("button", { name: /remove Gemini/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /edit Gemini/i })).toBeTruthy();
  });

  it("removes a custom agent", async () => {
    const api = installMenuSproutApi({
      agents: [
        { name: "claude", label: "Claude Code", available: true },
        { name: "gemini", label: "Gemini", available: true, custom: true, command: "gemini acp" },
      ],
    });
    await openSettings();

    fireEvent.click(await screen.findByRole("button", { name: /remove Gemini/i }));
    await waitFor(() => expect(api.settings.removeAgent).toHaveBeenCalledWith("gemini"));
    await waitFor(() => expect(screen.queryByRole("radio", { name: /Gemini/i })).toBeNull());
  });

  it("surfaces the error when adding an invalid agent and keeps the dialog open", async () => {
    const api = installMenuSproutApi({ agents: [{ name: "claude", label: "Claude Code", available: true }] });
    api.settings.addAgent = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'menu-sprout:settings:add-agent': Error: \"claude\" is a built-in agent name. Choose a different name.",
      );
    });
    await openSettings();

    fireEvent.click(screen.getByRole("button", { name: /add agent/i }));
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: "claude" } });
    fireEvent.change(screen.getByLabelText(/^command$/i), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    expect(await screen.findByText('"claude" is a built-in agent name. Choose a different name.')).toBeTruthy();
    expect(screen.getByRole("button", { name: /^save$/i })).toBeTruthy();
  });

  it("rediscovers extension settings sections when the popover reopens", async () => {
    const api = installMenuSproutApi();
    const visibilityListeners: Array<(state: PopoverVisibilityState) => void> = [];
    api.popover.onVisibility = vi.fn((listener) => {
      visibilityListeners.push(listener);
      return () => undefined;
    });
    window.menuSprout!.widgets.list = vi.fn(async () => [
      { id: "calendar.widget", extensionId: "calendar", moduleUrl: "/@fs/calendar/widget.tsx" },
    ]);
    let sectionLabel = "before reopen";
    const runtimeImporter = vi.fn(async () => ({
      calendarSettings: {
        extensionId: "calendar",
        title: "CALENDAR",
        render: () => <span>{sectionLabel}</span>,
      },
    }));

    render(<SettingsView runtimeImporter={runtimeImporter} />);
    expect(await screen.findByText("before reopen")).toBeTruthy();

    sectionLabel = "after reopen";
    visibilityListeners.forEach((listener) => listener({ visible: false }));
    visibilityListeners.forEach((listener) => listener({ visible: true }));

    expect(await screen.findByText("after reopen")).toBeTruthy();
    expect(runtimeImporter).toHaveBeenCalledTimes(2);
  });

  it("shows each built-in agent's model and effort, with CLI default when nothing is saved", async () => {
    installMenuSproutApi({ agentModels: agentModelSettings({ codex: { model: "gpt-5.5", effort: "high" } }) });
    render(<SettingsView sections={[]} />);

    const claudeModel = (await screen.findByLabelText("Claude Code model")) as HTMLInputElement;
    expect(claudeModel.value).toBe("");
    expect(claudeModel.placeholder).toBe("model: CLI default");
    expect((screen.getByRole("combobox", { name: "Claude Code effort" }) as HTMLSelectElement).value).toBe("");
    expect((screen.getByLabelText("Codex model") as HTMLInputElement).value).toBe("gpt-5.5");
    expect((screen.getByRole("combobox", { name: "Codex effort" }) as HTMLSelectElement).value).toBe("high");
    const claudeEfforts = [...(screen.getByRole("combobox", { name: "Claude Code effort" }) as HTMLSelectElement).options].map((o) => o.value);
    expect(claudeEfforts).toEqual(["", "low", "medium", "high", "xhigh", "max"]);
    expect(screen.getByLabelText("Antigravity model")).toBeTruthy();
  });

  it("saves a chosen effort and a typed model for one agent", async () => {
    const api = installMenuSproutApi({ agentModels: agentModelSettings(undefined) });
    render(<SettingsView sections={[]} />);

    fireEvent.change(await screen.findByRole("combobox", { name: "Antigravity effort" }), { target: { value: "low" } });
    await waitFor(() => expect(api.settings.setAgentModel).toHaveBeenCalledWith("antigravity", { model: "", effort: "low" }));

    const model = screen.getByLabelText("Claude Code model");
    fireEvent.change(model, { target: { value: "sonnet" } });
    fireEvent.blur(model);
    await waitFor(() => expect(api.settings.setAgentModel).toHaveBeenCalledWith("claude", { model: "sonnet", effort: "" }));
    await waitFor(() => expect((screen.getByLabelText("Claude Code model") as HTMLInputElement).value).toBe("sonnet"));
  });

  it("flags a saved effort this version cannot pass instead of showing CLI default", async () => {
    installMenuSproutApi({ agentModels: agentModelSettings({ claude: { effort: "turbo" } }) });
    render(<SettingsView sections={[]} />);

    const effort = (await screen.findByRole("combobox", { name: "Claude Code effort" })) as HTMLSelectElement;
    expect(effort.value).toBe("turbo");
    expect(effort.selectedOptions[0].textContent).toBe("turbo (not offered)");
    expect(screen.getByText(/Claude Code effort "turbo" is not one Menu Sprout can pass/)).toBeTruthy();
  });

  it("runs a row's saves one at a time, each with the latest model and effort, so a slow save never wins", async () => {
    const api = installMenuSproutApi({ agentModels: agentModelSettings(undefined) });
    const saveAgentModel = api.settings.setAgentModel;
    const gates: Array<ReturnType<typeof deferred<void>>> = [];
    api.settings.setAgentModel = vi.fn(async (agentName: string, input: { model?: string; effort?: string }) => {
      const gate = deferred<void>();
      gates.push(gate);
      await gate.promise;
      return saveAgentModel(agentName, input);
    });
    render(<SettingsView sections={[]} />);

    const model = (await screen.findByLabelText("Claude Code model")) as HTMLInputElement;
    const effort = screen.getByRole("combobox", { name: "Claude Code effort" }) as HTMLSelectElement;
    fireEvent.change(model, { target: { value: "opus" } });
    fireEvent.blur(model);
    await waitFor(() => expect(gates).toHaveLength(1));
    expect(api.settings.setAgentModel).toHaveBeenLastCalledWith("claude", { model: "opus", effort: "" });
    fireEvent.change(effort, { target: { value: "high" } });
    fireEvent.change(model, { target: { value: "sonnet" } });
    fireEvent.blur(model);
    await act(async () => undefined);
    expect(api.settings.setAgentModel).toHaveBeenCalledTimes(1);

    await act(async () => gates[0]!.resolve());
    await waitFor(() => expect(api.settings.setAgentModel).toHaveBeenCalledTimes(2));
    expect(api.settings.setAgentModel).toHaveBeenLastCalledWith("claude", { model: "sonnet", effort: "high" });
    expect(model.value).toBe("sonnet");
    expect(effort.value).toBe("high");

    fireEvent.change(effort, { target: { value: "low" } });
    await act(async () => gates[1]!.resolve());
    await waitFor(() => expect(gates).toHaveLength(3));
    expect(api.settings.setAgentModel).toHaveBeenLastCalledWith("claude", { model: "sonnet", effort: "low" });
    expect(effort.value).toBe("low");

    await act(async () => gates[2]!.resolve());
    await waitFor(() => expect(gates).toHaveLength(4));
    expect(api.settings.setAgentModel).toHaveBeenLastCalledWith("claude", { model: "sonnet", effort: "low" });
    await act(async () => gates[3]!.resolve());
    expect(model.value).toBe("sonnet");
    expect(effort.value).toBe("low");
  });

  it("shows the saved values again after a rejected model, so a following effort change saves", async () => {
    const api = installMenuSproutApi({ agentModels: agentModelSettings({ codex: { model: "gpt-5" } }) });
    const saveAgentModel = api.settings.setAgentModel;
    api.settings.setAgentModel = vi.fn(async (agentName: string, input: { model?: string; effort?: string }) => {
      if (input.model?.includes(" ")) {
        throw new Error(
          "Error invoking remote method 'menu-sprout:settings:set-agent-model': Error: Codex model \"two words\" is not a valid model id.",
        );
      }
      return saveAgentModel(agentName, input);
    });
    render(<SettingsView sections={[]} />);

    const model = (await screen.findByLabelText("Codex model")) as HTMLInputElement;
    const effort = screen.getByRole("combobox", { name: "Codex effort" }) as HTMLSelectElement;
    fireEvent.change(model, { target: { value: "two words" } });
    fireEvent.blur(model);
    expect(await screen.findByText('Codex model "two words" is not a valid model id.')).toBeTruthy();
    expect(model.value).toBe("gpt-5");

    fireEvent.change(effort, { target: { value: "high" } });
    await waitFor(() => expect(api.settings.setAgentModel).toHaveBeenLastCalledWith("codex", { model: "gpt-5", effort: "high" }));
    await waitFor(() => expect(screen.queryByText(/is not a valid model id/)).toBeNull());
    expect(effort.value).toBe("high");
    expect(model.value).toBe("gpt-5");
  });

  it("shows main's reason when a model or effort is refused", async () => {
    const api = installMenuSproutApi({ agentModels: agentModelSettings(undefined) });
    api.settings.setAgentModel = vi.fn(async () => {
      throw new Error(
        "Error invoking remote method 'menu-sprout:settings:set-agent-model': Error: Codex model \"two words\" is not a valid model id.",
      );
    });
    render(<SettingsView sections={[]} />);

    const model = await screen.findByLabelText("Codex model");
    fireEvent.change(model, { target: { value: "two words" } });
    fireEvent.keyDown(model, { key: "Enter" });
    expect(await screen.findByText('Codex model "two words" is not a valid model id.')).toBeTruthy();
  });

  it("saves turn limits, off when empty, and shows a refusal for a value out of range", async () => {
    const api = installMenuSproutApi({ agentModels: agentModelSettings(undefined), turnLimits: { maxTurnMinutes: 10 } });
    render(<SettingsView sections={[]} />);

    const minutes = (await screen.findByRole("textbox", { name: "max turn time" })) as HTMLInputElement;
    expect(minutes.value).toBe("10");
    const toolCalls = screen.getByRole("textbox", { name: "max tool calls" }) as HTMLInputElement;
    expect(toolCalls.value).toBe("");
    expect(toolCalls.placeholder).toBe("off");

    fireEvent.change(toolCalls, { target: { value: "25" } });
    fireEvent.blur(toolCalls);
    await waitFor(() => expect(api.settings.setTurnLimits).toHaveBeenCalledWith({ maxTurnMinutes: 10, maxToolCalls: 25 }));

    fireEvent.change(minutes, { target: { value: "" } });
    fireEvent.blur(minutes);
    await waitFor(() => expect(api.settings.setTurnLimits).toHaveBeenLastCalledWith({ maxTurnMinutes: null, maxToolCalls: 25 }));

    fireEvent.change(toolCalls, { target: { value: "2.5" } });
    fireEvent.keyDown(toolCalls, { key: "Enter" });
    expect(await screen.findByText("Max tool calls must be a whole number from 1 to 1000, or off.")).toBeTruthy();
  });
});
