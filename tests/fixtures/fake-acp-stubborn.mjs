import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

const controlDir = process.argv[2];
let connection;
let cwd;
let sessionId;
const wait = () => new Promise((resolve) => setTimeout(resolve, 20));

const agent = {
  async initialize() {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: false }, authMethods: [] };
  },
  async newSession(params) {
    cwd = params.cwd;
    sessionId = randomUUID();
    await writeFile(join(controlDir, "startup-started.tmp"), JSON.stringify({ pid: process.pid }));
    await rename(join(controlDir, "startup-started.tmp"), join(controlDir, "startup-started"));
    while (!existsSync(join(controlDir, "release-startup"))) await wait();
    return { sessionId };
  },
  async prompt() {
    const extensionDir = join(cwd, "stubborn-widget");
    await mkdir(extensionDir, { recursive: true });
    await connection.sessionUpdate({
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Editing the widget." } },
    });
    let edits = 0;
    while (!existsSync(join(controlDir, "release-turn"))) {
      await writeFile(join(extensionDir, "widget.tsx"), `export const edits = ${++edits};\n`);
      await writeFile(join(controlDir, "edits"), String(edits));
      await wait();
    }
    return { stopReason: "cancelled" };
  },
  async cancel() {
    await writeFile(join(controlDir, "cancel-requested"), "yes");
  },
};

connection = new AgentSideConnection(() => agent, ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
