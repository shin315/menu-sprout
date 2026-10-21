import { execFileSync } from "node:child_process";

function processTreeGroups(rootPid: number | undefined): number[] {
  if (rootPid === undefined) return [];
  let table: string;
  try {
    table = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid="], { encoding: "utf8" });
  } catch {
    return [rootPid];
  }
  const children = new Map<number, number[]>();
  const groupOf = new Map<number, number>();
  for (const line of table.split("\n")) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined || !pgid) continue;
    groupOf.set(pid, pgid);
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const groups = new Set<number>([rootPid]);
  const pending = [rootPid];
  while (pending.length > 0) {
    for (const pid of children.get(pending.pop()!) ?? []) {
      const group = groupOf.get(pid);
      if (group !== undefined) groups.add(group);
      pending.push(pid);
    }
  }
  const ownGroup = groupOf.get(process.pid);
  if (ownGroup !== undefined) groups.delete(ownGroup);
  return [...groups];
}

function killGroup(group: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-group, signal);
  } catch {}
}

export async function terminateProcessTree(rootPid: number | undefined, graceMs: number): Promise<void> {
  const groups = new Set(processTreeGroups(rootPid));
  const signalTree = (signal: NodeJS.Signals) => {
    for (const group of groups) killGroup(group, signal);
  };
  signalTree("SIGTERM");
  const forceKillTimer = setTimeout(() => {
    for (const group of processTreeGroups(rootPid)) groups.add(group);
    signalTree("SIGKILL");
  }, graceMs);
  try {
    while ([...groups].some(groupIsAlive)) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    clearTimeout(forceKillTimer);
  }
}

function groupIsAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
