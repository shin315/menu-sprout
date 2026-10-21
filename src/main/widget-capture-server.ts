import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { WidgetCaptureError, type WidgetCaptureEndpoint, type WidgetCapturer } from "./widget-capture";

/**
 * Loopback-only HTTP endpoint that lets the embedded agent (any CLI that can
 * run `curl`) ask the host for a PNG of one rendered widget. It exists so the
 * three built-in agents share one mechanism with no agent-specific code, and
 * it is not a widget IPC channel: widgets never see it and it exposes only the
 * capture of a single widget rendered by Menu Sprout's own popover.
 *
 * Every request needs the per-launch bearer token the host puts in the agent
 * prompt, and the Host header must be the loopback address (DNS-rebinding guard).
 */

export type WidgetCaptureServer = WidgetCaptureEndpoint & {
  close(): Promise<void>;
};

export type WidgetCaptureServerOptions = {
  capturer: WidgetCapturer;
  token?: string;
  port?: number;
};

export async function startWidgetCaptureServer(options: WidgetCaptureServerOptions): Promise<WidgetCaptureServer> {
  const host = "127.0.0.1";
  const token = options.token ?? randomBytes(24).toString("hex");
  const server = createServer((request, response) => {
    void handleRequest(request, response, { capturer: options.capturer, token, allowedHost: allowedHost(server, host) });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${host}:${port}`,
    token,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function allowedHost(server: Server, host: string): string | null {
  const address = server.address();
  if (!address || typeof address === "string") return null;
  return `${host}:${address.port}`;
}

type Context = { capturer: WidgetCapturer; token: string; allowedHost: string | null };

async function handleRequest(request: IncomingMessage, response: ServerResponse, context: Context): Promise<void> {
  try {
    if (context.allowedHost === null || request.headers.host !== context.allowedHost) {
      return send(response, 403, { ok: false, error: "Forbidden host." });
    }
    if (!isAuthorized(request, context.token)) {
      return send(response, 401, { ok: false, error: "Missing or invalid capture token." });
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== "/capture") {
      return send(response, 404, { ok: false, error: "Unknown route. Use GET /capture?widget=<widget-id>." });
    }
    if (request.method !== "GET") {
      return send(response, 405, { ok: false, error: "Use GET." });
    }

    const widget = url.searchParams.get("widget");
    if (!widget) {
      return send(response, 400, { ok: false, error: "Missing widget. Use GET /capture?widget=<widget-id> with the id declared in widget.tsx." });
    }

    const result = await context.capturer.capture({ widget });
    send(response, 200, { ok: true, ...result });
  } catch (error) {
    if (error instanceof WidgetCaptureError) {
      return send(response, error.status, { ok: false, error: error.message });
    }
    send(response, 500, { ok: false, error: "Widget capture failed." });
  }
}

function isAuthorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? "";
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const given = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(payload);
}
