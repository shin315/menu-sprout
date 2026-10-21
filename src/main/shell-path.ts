import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DEFAULT_AGENTS } from "./agent-catalog";

type MergeShellPathOptions = {
  currentPath?: string;
  homeDir?: string;
  shellPath?: string;
};

type ShellProbeResult = { status: number | null; stdout: string | null; error?: Error };

export type ShellProbeSpawn = (
  command: string,
  args: string[],
  options: { encoding: "utf8"; timeout: number; stdio: ["ignore", "pipe", "ignore"] },
) => ShellProbeResult;

export type ShellProbeSpawnAsync = (command: string, args: string[], options: { timeout: number }) => Promise<ShellProbeResult>;

export type LoginShellProbeOptions = {
  platform?: NodeJS.Platform;
  spawn?: ShellProbeSpawn;
};

export type InteractiveShellProbeOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawnAsync?: ShellProbeSpawnAsync;
  timeoutMs?: number;
  /** Whether a shell binary exists; lets tests simulate a missing `$SHELL`. */
  shellExists?: (shell: string) => boolean;
};

export type GuiShellPathOptions = LoginShellProbeOptions &
  InteractiveShellProbeOptions & {
    homeDir?: string;
    /** CLIs that must be on PATH before the slower interactive probe is skipped. */
    requiredCommands?: readonly string[];
    isExecutable?: (filePath: string) => boolean;
  };

const COMMON_GUI_PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];

const DEFAULT_SHELL = "/bin/zsh";
/**
 * Shells whose `-i -l -c` behavior and scalar `$PATH` we rely on. fish is
 * excluded because its `$PATH` is a list and expands space-separated.
 */
const SUPPORTED_PROBE_SHELLS = new Set(["zsh", "bash", "sh", "ksh", "ksh93", "dash"]);
/**
 * Shell startup files can print to stdout (banners, prompt tools), so the value
 * is delimited and extracted instead of treating stdout as the PATH.
 */
const PROBE_MARKER = "__MENU_SPROUT_PATH_PROBE__";
// `${PATH}` must be braced: a bare `$PATH` followed by the marker parses as one
// unset variable name and silently yields an empty value.
const PROBE_COMMAND = `printf '%s\\n' "${PROBE_MARKER}\${PATH}${PROBE_MARKER}"`;
const LOGIN_PROBE_TIMEOUT_MS = 2000;
/**
 * An rc file that initializes several version managers can take a few seconds
 * on a cold start. Bounded because the first agent run waits for this probe.
 */
const INTERACTIVE_PROBE_TIMEOUT_MS = 5000;

export function mergeShellPath(options: MergeShellPathOptions = {}): string {
  const homeDir = options.homeDir ?? homedir();
  const segments = [
    ...(options.currentPath ?? "").split(":"),
    ...COMMON_GUI_PATHS,
    `${homeDir}/.local/bin`,
    ...(options.shellPath ?? "").split(":"),
  ];

  return [...new Set(segments.map((segment) => segment.trim()).filter(Boolean))].join(":");
}

export function resolveProbeShell(
  shell: string | undefined,
  shellExists: (shell: string) => boolean = existsSync,
): string {
  const candidate = (shell ?? "").trim();
  if (!candidate.startsWith("/") || !SUPPORTED_PROBE_SHELLS.has(basename(candidate))) return DEFAULT_SHELL;
  return shellExists(candidate) ? candidate : DEFAULT_SHELL;
}

function extractProbePath(stdout: string | null): string | undefined {
  if (!stdout) return undefined;
  const start = stdout.indexOf(PROBE_MARKER);
  if (start < 0) return undefined;
  const valueStart = start + PROBE_MARKER.length;
  const end = stdout.indexOf(PROBE_MARKER, valueStart);
  if (end < 0) return undefined;
  const value = stdout.slice(valueStart, end).trim();
  // Anything that is not recognizably a PATH is rejected rather than merged.
  if (/[\r\n]/.test(value) || !value.split(":").some((segment) => segment.startsWith("/"))) return undefined;
  return value;
}

function probeResultPath(result: ShellProbeResult): string | undefined {
  // A timeout or a missing shell leaves `status` null and sets `error`.
  if (result.error || result.status !== 0) return undefined;
  return extractProbePath(result.stdout);
}

/** PATH of a non-interactive login shell, which does not source `~/.zshrc`. */
export function readLoginShellPath(options: LoginShellProbeOptions = {}): string | undefined {
  if ((options.platform ?? process.platform) === "win32") return undefined;
  const spawnProbe = options.spawn ?? (spawnSync as unknown as ShellProbeSpawn);
  try {
    return probeResultPath(
      spawnProbe(DEFAULT_SHELL, ["-lc", PROBE_COMMAND], {
        encoding: "utf8",
        timeout: LOGIN_PROBE_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return undefined;
  }
}

const spawnShellProbe: ShellProbeSpawnAsync = (command, args, { timeout }) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "ignore"],
      detached: true,
      timeout,
      killSignal: "SIGKILL",
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", (error) => resolve({ status: null, stdout: null, error }));
    child.on("close", (status) => resolve({ status, stdout }));
  });

/**
 * PATH of an interactive login shell. Only this sources `~/.zshrc` (or
 * `~/.bashrc`), where nvm, asdf, volta, mise, and fnm usually put their shims.
 * Never rejects; any failure or timeout resolves `undefined`.
 */
export async function readInteractiveShellPath(options: InteractiveShellProbeOptions = {}): Promise<string | undefined> {
  if ((options.platform ?? process.platform) === "win32") return undefined;
  const shell = resolveProbeShell((options.env ?? process.env).SHELL, options.shellExists);
  const timeout = options.timeoutMs ?? INTERACTIVE_PROBE_TIMEOUT_MS;
  const spawnProbe = options.spawnAsync ?? spawnShellProbe;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Rc files can leave background children holding stdout open, so the bound
  // does not rely on the shell's `close` event.
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, timeout, undefined);
  });
  try {
    return await Promise.race([
      Promise.resolve()
        .then(() => spawnProbe(shell, ["-ilc", PROBE_COMMAND], { timeout }))
        .then(probeResultPath),
      timedOut,
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function isExecutableFile(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function pathHasCommand(path: string, command: string, isExecutable: (filePath: string) => boolean): boolean {
  return path.split(":").some((dir) => dir.startsWith("/") && isExecutable(join(dir, command)));
}

/**
 * Expands `process.env.PATH` for a GUI (Dock or login item) launch. The cheap
 * login shell probe is applied synchronously. The interactive probe is slower
 * and executes the user's rc files, so it only runs when an agent CLI is still
 * missing, and in the background: the returned promise resolves once its PATH
 * has been merged in. It never rejects; agent runs await it before resolving
 * an agent command.
 */
export function expandProcessPathForGuiLaunch(options: GuiShellPathOptions = {}): Promise<void> {
  const isExecutable = options.isExecutable ?? isExecutableFile;
  const requiredCommands = options.requiredCommands ?? DEFAULT_AGENTS.map((agent) => agent.command);
  const merge = (shellPath: string | undefined) =>
    mergeShellPath({ currentPath: process.env.PATH, homeDir: options.homeDir, shellPath });

  process.env.PATH = merge(readLoginShellPath(options));
  const loginPath = process.env.PATH;
  if (requiredCommands.every((command) => pathHasCommand(loginPath, command, isExecutable))) return Promise.resolve();

  return readInteractiveShellPath(options).then((interactivePath) => {
    if (interactivePath) process.env.PATH = merge(interactivePath);
  });
}
