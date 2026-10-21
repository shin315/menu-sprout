import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  expandProcessPathForGuiLaunch,
  readInteractiveShellPath,
  readLoginShellPath,
  resolveProbeShell,
  type ShellProbeSpawn,
  type ShellProbeSpawnAsync,
} from "../src/main/shell-path";

type ProbeResult = { status: number | null; stdout: string | null; error?: Error };
type ProbeCall = { command: string; args: string[]; timeout: number };

const MARKER = "__MENU_SPROUT_PATH_PROBE__";

function probeStdout(pathValue: string): string {
  return `${MARKER}${pathValue}${MARKER}\n`;
}

function ok(pathValue: string): ProbeResult {
  return { status: 0, stdout: probeStdout(pathValue) };
}

function recordingSpawn(respond: (command: string, args: string[]) => ProbeResult) {
  const calls: ProbeCall[] = [];
  const spawn: ShellProbeSpawn = (command, args, options) => {
    calls.push({ command, args, timeout: options.timeout });
    return respond(command, args);
  };
  return { calls, spawn };
}

function recordingSpawnAsync(respond: (command: string, args: string[]) => ProbeResult | Promise<ProbeResult>) {
  const calls: ProbeCall[] = [];
  const spawnAsync: ShellProbeSpawnAsync = async (command, args, options) => {
    calls.push({ command, args, timeout: options.timeout });
    return respond(command, args);
  };
  return { calls, spawnAsync };
}

function executables(...files: string[]) {
  const set = new Set(files);
  return (filePath: string) => set.has(filePath);
}

describe("resolveProbeShell", () => {
  const exists = () => true;

  it("prefers the user's own POSIX shell", () => {
    expect(resolveProbeShell("/bin/bash", exists)).toBe("/bin/bash");
    expect(resolveProbeShell("/opt/homebrew/bin/zsh", exists)).toBe("/opt/homebrew/bin/zsh");
  });

  it("falls back to /bin/zsh for unset, relative, unsupported, or missing shells", () => {
    expect(resolveProbeShell(undefined, exists)).toBe("/bin/zsh");
    expect(resolveProbeShell("zsh", exists)).toBe("/bin/zsh");
    expect(resolveProbeShell("/opt/homebrew/bin/fish", exists)).toBe("/bin/zsh");
    expect(resolveProbeShell("/nonexistent/bin/zsh", () => false)).toBe("/bin/zsh");
  });
});

describe("shell PATH probes", () => {
  it("probes an interactive login shell with the user's $SHELL and a bounded timeout", async () => {
    const { calls, spawnAsync } = recordingSpawnAsync(() => ok("/Users/me/.volta/bin:/usr/bin"));

    const result = await readInteractiveShellPath({
      platform: "darwin",
      env: { SHELL: "/bin/bash" },
      shellExists: () => true,
      spawnAsync,
    });

    expect(result).toBe("/Users/me/.volta/bin:/usr/bin");
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("/bin/bash");
    expect(calls[0].args[0]).toBe("-ilc");
    expect(calls[0].timeout).toBeGreaterThan(0);
    expect(calls[0].timeout).toBeLessThanOrEqual(10_000);
  });

  it("probes a non-interactive login zsh", () => {
    const { calls, spawn } = recordingSpawn(() => ok("/opt/homebrew/bin:/usr/bin"));
    expect(readLoginShellPath({ platform: "darwin", spawn })).toBe("/opt/homebrew/bin:/usr/bin");
    expect(calls.map((call) => [call.command, call.args[0]])).toEqual([["/bin/zsh", "-lc"]]);
  });

  it("extracts only the delimited PATH when rc files print noise around it", async () => {
    const { spawnAsync } = recordingSpawnAsync(() => ({
      status: 0,
      stdout: [
        "Last login: Mon Oct  5 09:00:00 on ttys001",
        "nvm: using node v22.0.0 (/usr/local/bin/node)",
        "%  ",
        probeStdout("/Users/me/.nvm/versions/node/v22.0.0/bin:/usr/bin").trimEnd(),
        "trailing prompt chatter /tmp/x:/tmp/y",
      ].join("\n"),
    }));

    await expect(readInteractiveShellPath({ platform: "darwin", env: {}, spawnAsync })).resolves.toBe(
      "/Users/me/.nvm/versions/node/v22.0.0/bin:/usr/bin",
    );
  });

  it("rejects junk instead of merging it", async () => {
    const junk = [null, "", "no marker here", probeStdout("not-a-path"), `${MARKER}/usr/bin`, probeStdout("/a\n/b")];
    for (const stdout of junk) {
      const { spawnAsync } = recordingSpawnAsync(() => ({ status: 0, stdout }));
      await expect(readInteractiveShellPath({ platform: "darwin", env: {}, spawnAsync })).resolves.toBeUndefined();
      const { spawn } = recordingSpawn(() => ({ status: 0, stdout }));
      expect(readLoginShellPath({ platform: "darwin", spawn })).toBeUndefined();
    }
  });

  it("resolves undefined when the probe reports a timeout", async () => {
    const timedOut = Object.assign(new Error("spawn /bin/zsh ETIMEDOUT"), { code: "ETIMEDOUT" });
    const { spawnAsync } = recordingSpawnAsync(() => ({ status: null, stdout: probeStdout("/partial"), error: timedOut }));
    await expect(readInteractiveShellPath({ platform: "darwin", env: {}, spawnAsync })).resolves.toBeUndefined();
  });

  it("resolves undefined at the timeout even when the shell never finishes", async () => {
    const { spawnAsync } = recordingSpawnAsync(() => new Promise<ProbeResult>(() => undefined));
    const startedAt = Date.now();

    await expect(readInteractiveShellPath({ platform: "darwin", env: {}, spawnAsync, timeoutMs: 30 })).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it("returns undefined when the shell is missing or cannot be spawned", async () => {
    const missing = Object.assign(new Error("spawn /bin/zsh ENOENT"), { code: "ENOENT" });
    const { spawnAsync } = recordingSpawnAsync(() => ({ status: null, stdout: null, error: missing }));
    await expect(readInteractiveShellPath({ platform: "darwin", env: {}, spawnAsync })).resolves.toBeUndefined();
    const { spawn } = recordingSpawn(() => ({ status: null, stdout: null, error: missing }));
    expect(readLoginShellPath({ platform: "darwin", spawn })).toBeUndefined();

    const throwing = () => {
      throw new Error("EACCES");
    };
    await expect(
      readInteractiveShellPath({ platform: "darwin", env: {}, spawnAsync: throwing as ShellProbeSpawnAsync }),
    ).resolves.toBeUndefined();
    expect(readLoginShellPath({ platform: "darwin", spawn: throwing as ShellProbeSpawn })).toBeUndefined();
  });

  it("returns undefined on a non-zero exit and on win32 without spawning", async () => {
    const failing = recordingSpawnAsync(() => ({ status: 1, stdout: probeStdout("/usr/bin") }));
    await expect(readInteractiveShellPath({ platform: "darwin", env: {}, spawnAsync: failing.spawnAsync })).resolves.toBeUndefined();

    const winAsync = recordingSpawnAsync(() => ok("/usr/bin"));
    const win = recordingSpawn(() => ok("/usr/bin"));
    await expect(readInteractiveShellPath({ platform: "win32", env: {}, spawnAsync: winAsync.spawnAsync })).resolves.toBeUndefined();
    expect(readLoginShellPath({ platform: "win32", spawn: win.spawn })).toBeUndefined();
    expect(winAsync.calls).toHaveLength(0);
    expect(win.calls).toHaveLength(0);
  });
});

describe("expandProcessPathForGuiLaunch", () => {
  const originalPath = process.env.PATH;
  const base = { platform: "darwin" as const, env: {}, homeDir: "/Users/me" };

  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it.each([
    ["nvm", "/Users/me/.nvm/versions/node/v22.11.0/bin"],
    ["asdf", "/Users/me/.asdf/shims"],
    ["volta", "/Users/me/.volta/bin"],
  ])("adds %s paths that only the interactive shell exposes", async (_manager, managerDir) => {
    process.env.PATH = "/usr/bin:/bin";
    const login = recordingSpawn(() => ok("/opt/homebrew/bin:/usr/bin:/bin"));
    const interactive = recordingSpawnAsync(() => ok(`${managerDir}:/usr/bin:/bin`));

    await expandProcessPathForGuiLaunch({
      ...base,
      spawn: login.spawn,
      spawnAsync: interactive.spawnAsync,
      requiredCommands: ["claude"],
      isExecutable: executables(`${managerDir}/claude`),
    });
    const merged = (process.env.PATH ?? "").split(":");

    expect(login.calls).toHaveLength(1);
    expect(interactive.calls).toHaveLength(1);
    expect(merged).toContain(managerDir);
    // The hard-coded fallbacks are kept.
    expect(merged).toEqual(expect.arrayContaining(["/opt/homebrew/bin", "/usr/local/bin", "/Users/me/.local/bin"]));
  });

  it("applies the login PATH at once and merges the interactive PATH only when its probe resolves", async () => {
    process.env.PATH = "/usr/bin:/bin";
    let finishInteractive!: (result: ProbeResult) => void;
    const login = recordingSpawn(() => ok("/Users/me/bin:/usr/bin"));
    const interactive = recordingSpawnAsync(
      () =>
        new Promise<ProbeResult>((resolve) => {
          finishInteractive = resolve;
        }),
    );

    const ready = expandProcessPathForGuiLaunch({
      ...base,
      spawn: login.spawn,
      spawnAsync: interactive.spawnAsync,
      requiredCommands: ["claude"],
      isExecutable: () => false,
    });

    expect(process.env.PATH?.split(":")).toContain("/Users/me/bin");
    expect(process.env.PATH?.split(":")).not.toContain("/Users/me/.asdf/shims");

    await vi.waitFor(() => expect(interactive.calls).toHaveLength(1));
    finishInteractive(ok("/Users/me/.asdf/shims"));
    await ready;

    expect(process.env.PATH?.split(":")).toEqual(expect.arrayContaining(["/Users/me/bin", "/Users/me/.asdf/shims"]));
  });

  it("skips the interactive shell when the login shell already finds every agent CLI", async () => {
    process.env.PATH = "/usr/bin:/bin";
    const login = recordingSpawn(() => ok("/Users/me/bin:/usr/bin"));
    const interactive = recordingSpawnAsync(() => ok("/Users/me/.asdf/shims"));

    await expandProcessPathForGuiLaunch({
      ...base,
      spawn: login.spawn,
      spawnAsync: interactive.spawnAsync,
      requiredCommands: ["claude", "codex"],
      isExecutable: executables("/Users/me/bin/claude", "/opt/homebrew/bin/codex"),
    });

    expect(interactive.calls).toHaveLength(0);
    expect(process.env.PATH?.split(":")).toContain("/Users/me/bin");
  });

  it("keeps the login and fallback PATH when the interactive shell times out", async () => {
    process.env.PATH = "/usr/bin:/bin";
    const login = recordingSpawn(() => ok("/Users/me/bin:/usr/bin"));
    const interactive = recordingSpawnAsync(() => new Promise<ProbeResult>(() => undefined));

    await expandProcessPathForGuiLaunch({
      ...base,
      spawn: login.spawn,
      spawnAsync: interactive.spawnAsync,
      timeoutMs: 30,
      requiredCommands: ["claude"],
      isExecutable: () => false,
    });

    expect(process.env.PATH?.split(":")).toEqual(
      expect.arrayContaining(["/usr/bin", "/bin", "/opt/homebrew/bin", "/Users/me/.local/bin", "/Users/me/bin"]),
    );
  });
});

// Guards the probe command itself against a real shell: a bare `$PATH` before
// the marker would parse as one unset variable and return an empty value.
describe.skipIf(process.platform === "win32" || !existsSync("/bin/zsh"))("real zsh probes", () => {
  it("reads a plausible PATH from login and interactive login zsh", async () => {
    for (const result of [
      readLoginShellPath(),
      await readInteractiveShellPath({ env: { ...process.env, SHELL: "/bin/zsh" } }),
    ]) {
      expect(result).toBeDefined();
      expect(result).not.toContain("\n");
      expect(result).toContain("/usr/bin");
    }
  }, 15_000);
});
