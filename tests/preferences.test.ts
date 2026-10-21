import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPreferencesService } from "../src/main/preferences";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

describe("preferences service", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("defaults to opening at login until the user opts out", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "menu-sprout-prefs-"));
    tempDirs.push(userDataDir);
    const appFacade = {
      setLoginItemSettings: vi.fn(),
    };
    const service = createPreferencesService({ userDataDir, app: appFacade });

    await expect(service.get()).resolves.toEqual({ openAtLogin: true });
    await expect(service.apply()).resolves.toEqual({ openAtLogin: true });

    expect(appFacade.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
  });

  it("can default to not opening at login for source dev mode", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "menu-sprout-prefs-"));
    tempDirs.push(userDataDir);
    const appFacade = {
      setLoginItemSettings: vi.fn(),
    };
    const service = createPreferencesService({ userDataDir, app: appFacade, defaultOpenAtLogin: false });

    await expect(service.get()).resolves.toEqual({ openAtLogin: false });
    await expect(service.apply()).resolves.toEqual({ openAtLogin: false });

    expect(appFacade.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false });
  });

  it("prevents source dev mode from enabling open at login", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "menu-sprout-prefs-"));
    tempDirs.push(userDataDir);
    const appFacade = {
      setLoginItemSettings: vi.fn(),
    };
    const service = createPreferencesService({
      userDataDir,
      app: appFacade,
      defaultOpenAtLogin: false,
      allowOpenAtLogin: false,
    });

    await expect(service.setOpenAtLogin(true)).resolves.toEqual({ openAtLogin: false });
    await expect(service.get()).resolves.toEqual({ openAtLogin: false });

    expect(appFacade.setLoginItemSettings).not.toHaveBeenCalled();
    await expect(readFile(join(userDataDir, "preferences.json"), "utf8")).resolves.toContain('"openAtLogin": false');
  });

  it("persists and applies an explicit open-at-login opt-out", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "menu-sprout-prefs-"));
    tempDirs.push(userDataDir);
    const appFacade = {
      setLoginItemSettings: vi.fn(),
    };
    const service = createPreferencesService({ userDataDir, app: appFacade });

    await expect(service.setOpenAtLogin(false)).resolves.toEqual({ openAtLogin: false });
    await expect(service.get()).resolves.toEqual({ openAtLogin: false });

    expect(appFacade.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: false });
    await expect(readFile(join(userDataDir, "preferences.json"), "utf8")).resolves.toContain('"openAtLogin": false');
  });

  it("has no agent preference until the user picks one", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "menu-sprout-prefs-"));
    tempDirs.push(userDataDir);
    const service = createPreferencesService({ userDataDir, app: { setLoginItemSettings: vi.fn() } });

    await expect(service.get()).resolves.not.toHaveProperty("agentName");
  });

  it("persists the chosen agent without disturbing the login preference", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "menu-sprout-prefs-"));
    tempDirs.push(userDataDir);
    const service = createPreferencesService({ userDataDir, app: { setLoginItemSettings: vi.fn() }, defaultOpenAtLogin: false });

    await expect(service.setAgent("codex")).resolves.toEqual({ openAtLogin: false, agentName: "codex" });
    await expect(service.get()).resolves.toEqual({ openAtLogin: false, agentName: "codex" });
    await expect(readFile(join(userDataDir, "preferences.json"), "utf8")).resolves.toContain('"agentName": "codex"');
  });

  it("persists a known theme without disturbing other preferences", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "menu-sprout-prefs-"));
    tempDirs.push(userDataDir);
    const service = createPreferencesService({ userDataDir, app: { setLoginItemSettings: vi.fn() }, defaultOpenAtLogin: false });

    await service.setAgent("codex");
    await expect(service.setTheme("paper-sketch")).resolves.toEqual({ openAtLogin: false, agentName: "codex", theme: "paper-sketch" });
    await expect(service.get()).resolves.toEqual({ openAtLogin: false, agentName: "codex", theme: "paper-sketch" });
  });

  it("drops an unknown theme id instead of persisting it", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "menu-sprout-prefs-"));
    tempDirs.push(userDataDir);
    const service = createPreferencesService({ userDataDir, app: { setLoginItemSettings: vi.fn() }, defaultOpenAtLogin: false });

    await service.setTheme("calm-pastel");
    await expect(service.setTheme("no-such-theme")).resolves.toEqual({ openAtLogin: false });
    await expect(service.get()).resolves.not.toHaveProperty("theme");
  });

  it("ignores a stale theme id already stored on disk", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "menu-sprout-prefs-"));
    tempDirs.push(userDataDir);
    await writeFile(join(userDataDir, "preferences.json"), JSON.stringify({ openAtLogin: false, theme: "renamed-theme" }));
    const service = createPreferencesService({ userDataDir, app: { setLoginItemSettings: vi.fn() } });

    await expect(service.get()).resolves.toEqual({ openAtLogin: false });
  });

  it("persists an appearance beside the theme without disturbing other preferences", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "menu-sprout-prefs-"));
    tempDirs.push(userDataDir);
    const service = createPreferencesService({ userDataDir, app: { setLoginItemSettings: vi.fn() }, defaultOpenAtLogin: false });

    await service.setTheme("paper-sketch");
    await expect(service.setAppearance("light")).resolves.toEqual({ openAtLogin: false, theme: "paper-sketch", appearance: "light" });
    await expect(service.setTheme("calm-pastel")).resolves.toEqual({ openAtLogin: false, theme: "calm-pastel", appearance: "light" });
    await expect(service.setAppearance("dark")).resolves.toEqual({ openAtLogin: false, theme: "calm-pastel", appearance: "dark" });
    await expect(readFile(join(userDataDir, "preferences.json"), "utf8")).resolves.toContain('"appearance": "dark"');
  });

  it("preserves concurrent theme and appearance updates", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "menu-sprout-prefs-"));
    tempDirs.push(userDataDir);
    const service = createPreferencesService({ userDataDir, app: { setLoginItemSettings: vi.fn() }, defaultOpenAtLogin: false });

    await Promise.all([service.setTheme("paper-sketch"), service.setAppearance("dark")]);

    await expect(service.get()).resolves.toEqual({ openAtLogin: false, theme: "paper-sketch", appearance: "dark" });
  });

  it("orders every preference mutation and reads the completed snapshot", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "menu-sprout-prefs-"));
    tempDirs.push(userDataDir);
    const appFacade = { setLoginItemSettings: vi.fn() };
    const service = createPreferencesService({ userDataDir, app: appFacade, defaultOpenAtLogin: false });

    const results = await Promise.all([
      service.setOpenAtLogin(true),
      service.setAgent("codex"),
      service.setTheme("paper-sketch"),
      service.setAppearance("dark"),
      service.setTheme("calm-pastel"),
      service.setAppearance("light"),
      service.get(),
      service.apply(),
    ]);
    const expected = { openAtLogin: true, agentName: "codex", theme: "calm-pastel", appearance: "light" };

    expect(results[2]).toEqual({ openAtLogin: true, agentName: "codex", theme: "paper-sketch" });
    expect(results[3]).toEqual({ openAtLogin: true, agentName: "codex", theme: "paper-sketch", appearance: "dark" });
    expect(results[6]).toEqual(expected);
    expect(results[7]).toEqual(expected);
    expect(JSON.parse(await readFile(join(userDataDir, "preferences.json"), "utf8"))).toEqual(expected);
    expect(appFacade.setLoginItemSettings).toHaveBeenCalledTimes(2);
    expect(appFacade.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: true });
  });

  it("continues queued updates after a persistence failure", async () => {
    const parentDir = await mkdtemp(join(tmpdir(), "menu-sprout-prefs-"));
    tempDirs.push(parentDir);
    const userDataDir = join(parentDir, "blocked");
    await writeFile(userDataDir, "not a directory");
    const service = createPreferencesService({ userDataDir, app: { setLoginItemSettings: vi.fn() }, defaultOpenAtLogin: false });

    await expect(service.setTheme("paper-sketch")).rejects.toThrow();
    await rm(userDataDir);

    await expect(service.setAppearance("light")).resolves.toEqual({ openAtLogin: false, appearance: "light" });
    await expect(service.get()).resolves.toEqual({ openAtLogin: false, appearance: "light" });
  });

  it("preserves the saved theme and appearance after a partial write fails", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "menu-sprout-prefs-"));
    tempDirs.push(userDataDir);
    const service = createPreferencesService({ userDataDir, app: { setLoginItemSettings: vi.fn() }, defaultOpenAtLogin: false });
    await service.setTheme("paper-sketch");
    const saved = await service.setAppearance("dark");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const failure = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    vi.mocked(writeFile).mockImplementationOnce(async (path, _data, options) => {
      await actual.writeFile(path, "{", options);
      throw failure;
    });

    await expect(service.setAppearance("light")).rejects.toBe(failure);

    expect(JSON.parse(await readFile(join(userDataDir, "preferences.json"), "utf8"))).toEqual(saved);
    await expect(service.get()).resolves.toEqual(saved);
    await expect(service.setAppearance("light")).resolves.toEqual({ ...saved, appearance: "light" });
  });

  it("leaves appearance unset (System) until the user picks one", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "menu-sprout-prefs-"));
    tempDirs.push(userDataDir);
    await writeFile(join(userDataDir, "preferences.json"), JSON.stringify({ openAtLogin: false, theme: "nature-wood" }));
    const service = createPreferencesService({ userDataDir, app: { setLoginItemSettings: vi.fn() } });

    await expect(service.get()).resolves.not.toHaveProperty("appearance");
  });

  it("drops an unknown appearance so it falls back to System", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "menu-sprout-prefs-"));
    tempDirs.push(userDataDir);
    const service = createPreferencesService({ userDataDir, app: { setLoginItemSettings: vi.fn() }, defaultOpenAtLogin: false });

    await service.setAppearance("dark");
    await expect(service.setAppearance("sepia")).resolves.toEqual({ openAtLogin: false });
    await expect(service.get()).resolves.not.toHaveProperty("appearance");
  });

  it("ignores an unknown appearance already stored on disk", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "menu-sprout-prefs-"));
    tempDirs.push(userDataDir);
    await writeFile(join(userDataDir, "preferences.json"), JSON.stringify({ openAtLogin: false, appearance: "midnight" }));
    const service = createPreferencesService({ userDataDir, app: { setLoginItemSettings: vi.fn() } });

    await expect(service.get()).resolves.toEqual({ openAtLogin: false });
  });

  it("persists the privacy telemetry switch only once the user flips it", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "menu-sprout-prefs-"));
    tempDirs.push(userDataDir);
    const appFacade = { setLoginItemSettings: vi.fn() };
    const service = createPreferencesService({ userDataDir, app: appFacade, defaultOpenAtLogin: false });

    await expect(service.get()).resolves.not.toHaveProperty("telemetryEnabled");

    await expect(service.setTelemetryEnabled(false)).resolves.toEqual({ openAtLogin: false, telemetryEnabled: false });
    const reloaded = createPreferencesService({ userDataDir, app: appFacade, defaultOpenAtLogin: false });
    await expect(reloaded.get()).resolves.toEqual({ openAtLogin: false, telemetryEnabled: false });
    await expect(reloaded.setTelemetryEnabled(true)).resolves.toEqual({ openAtLogin: false, telemetryEnabled: true });
    expect(JSON.parse(await readFile(join(userDataDir, "preferences.json"), "utf8"))).toMatchObject({ telemetryEnabled: true });
  });

  it("drops a malformed saved telemetry switch so the environment default applies", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "menu-sprout-prefs-"));
    tempDirs.push(userDataDir);
    await writeFile(join(userDataDir, "preferences.json"), JSON.stringify({ openAtLogin: false, telemetryEnabled: "no" }));
    const service = createPreferencesService({ userDataDir, app: { setLoginItemSettings: vi.fn() } });

    await expect(service.get()).resolves.toEqual({ openAtLogin: false });
  });

  it("persists model, effort, and turn limits without disturbing other preferences", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "menu-sprout-prefs-"));
    tempDirs.push(userDataDir);
    const service = createPreferencesService({ userDataDir, app: { setLoginItemSettings: vi.fn() }, defaultOpenAtLogin: false });

    await service.setAgent("codex");
    await service.setAgentModel("codex", { model: "gpt-5.5", effort: "high" });
    await service.setAgentModel("claude", { effort: "low" });
    await service.setTurnLimits({ maxToolCalls: 30 });

    const reread = createPreferencesService({ userDataDir, app: { setLoginItemSettings: vi.fn() }, defaultOpenAtLogin: false });
    await expect(reread.get()).resolves.toEqual({
      openAtLogin: false,
      agentName: "codex",
      agentModels: { codex: { model: "gpt-5.5", effort: "high" }, claude: { effort: "low" } },
      turnLimits: { maxToolCalls: 30 },
    });

    // Choosing CLI default for both clears that agent's entry.
    await service.setAgentModel("codex", {});
    await service.setTurnLimits({});
    await expect(service.get()).resolves.toEqual({ openAtLogin: false, agentName: "codex", agentModels: { claude: { effort: "low" } } });
  });

  it("keeps an unknown saved effort so it is reported rather than silently dropped", async () => {
    const userDataDir = await mkdtemp(join(tmpdir(), "menu-sprout-prefs-"));
    tempDirs.push(userDataDir);
    await writeFile(
      join(userDataDir, "preferences.json"),
      JSON.stringify({ openAtLogin: false, agentModels: { claude: { effort: "turbo" }, other: { model: "x" } } }),
    );
    const service = createPreferencesService({ userDataDir, app: { setLoginItemSettings: vi.fn() } });

    await expect(service.get()).resolves.toEqual({ openAtLogin: false, agentModels: { claude: { effort: "turbo" } } });
  });
});
