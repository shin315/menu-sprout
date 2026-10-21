import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WidgetCaptureError, type WidgetCapturer } from "../src/main/widget-capture";
import { startWidgetCaptureServer, type WidgetCaptureServer } from "../src/main/widget-capture-server";

describe("widget capture server", () => {
  let server: WidgetCaptureServer | null = null;

  afterEach(async () => {
    await server?.close();
    server = null;
  });

  function auth(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  async function start(capture: WidgetCapturer["capture"] = vi.fn(async () => result())) {
    server = await startWidgetCaptureServer({ capturer: { capture } });
    return { server, capture };
  }

  function result() {
    return { path: "/cache/captures/widget-1.png", width: 1008, height: 640, widget: "codex-quota", widgets: ["codex-quota"] };
  }

  it("listens on loopback only and hands out a random per-launch token", async () => {
    const first = await startWidgetCaptureServer({ capturer: { capture: vi.fn() } });
    const second = await startWidgetCaptureServer({ capturer: { capture: vi.fn() } });
    try {
      expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(first.token).toMatch(/^[0-9a-f]{48}$/);
      expect(first.token).not.toBe(second.token);
    } finally {
      await first.close();
      await second.close();
    }
  });

  it("captures the named widget and returns the saved path as JSON", async () => {
    const { server, capture } = await start();

    const response = await fetch(`${server.url}/capture?widget=codex-quota`, { headers: auth(server.token) });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ ok: true, ...result() });
    expect(capture).toHaveBeenCalledWith({ widget: "codex-quota" });
  });

  it("requires a widget id and never captures the whole popover", async () => {
    const { server, capture } = await start();

    const missing = await fetch(`${server.url}/capture`, { headers: auth(server.token) });
    const empty = await fetch(`${server.url}/capture?widget=`, { headers: auth(server.token) });

    expect([missing.status, empty.status]).toEqual([400, 400]);
    expect(await missing.json()).toEqual({ ok: false, error: expect.stringContaining("Missing widget") });
    expect(capture).not.toHaveBeenCalled();
  });

  it("refuses requests without the right token and never captures", async () => {
    const { server, capture } = await start();

    const missing = await fetch(`${server.url}/capture`);
    const wrong = await fetch(`${server.url}/capture`, { headers: auth("nope") });
    const sameLength = await fetch(`${server.url}/capture`, { headers: auth("x".repeat(server.token.length)) });

    expect([missing.status, wrong.status, sameLength.status]).toEqual([401, 401, 401]);
    expect(capture).not.toHaveBeenCalled();
  });

  it("accepts only the exact 127.0.0.1:<port> Host header", async () => {
    const { server, capture } = await start();
    const port = new URL(server.url).port;

    // fetch() ignores a Host override, so speak raw HTTP.
    const statusFor = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const request = httpRequest(
          `${server.url}/capture?widget=codex-quota`,
          { headers: { ...auth(server.token), host } },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        );
        request.on("error", reject);
        request.end();
      });

    expect(await statusFor("evil.example.com")).toBe(403);
    expect(await statusFor(`localhost:${port}`)).toBe(403);
    expect(await statusFor(`[::1]:${port}`)).toBe(403);
    expect(capture).not.toHaveBeenCalled();
    expect(await statusFor(`127.0.0.1:${port}`)).toBe(200);
    expect(capture).toHaveBeenCalledOnce();
  });

  it("exposes nothing but /capture", async () => {
    const { server, capture } = await start();

    const other = await fetch(`${server.url}/anything`, { headers: auth(server.token) });
    const post = await fetch(`${server.url}/capture?widget=codex-quota`, { method: "POST", headers: auth(server.token) });
    const put = await fetch(`${server.url}/capture?widget=codex-quota`, { method: "PUT", headers: auth(server.token) });

    expect(other.status).toBe(404);
    expect([post.status, put.status]).toEqual([405, 405]);
    expect(capture).not.toHaveBeenCalled();
  });

  it("maps capture errors to their status and hides unexpected failure details", async () => {
    const capture = vi
      .fn<WidgetCapturer["capture"]>()
      .mockRejectedValueOnce(new WidgetCaptureError('Widget "x" is not rendered in the popover. Rendered widgets: none.', 404))
      .mockRejectedValueOnce(new Error("secret internal path /Users/someone/.menu-sprout"));
    const { server } = await start(capture);

    const missing = await fetch(`${server.url}/capture?widget=x`, { headers: auth(server.token) });
    const broken = await fetch(`${server.url}/capture?widget=codex-quota`, { headers: auth(server.token) });

    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ ok: false, error: expect.stringContaining("not rendered") });
    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual({ ok: false, error: "Widget capture failed." });
  });
});
