import { describe, expect, it } from "vitest";

import { createTelemetryClient, initDefaultTelemetry, resolveTelemetryChoice, resolveTelemetryConfig } from "../src/main/telemetry";

type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { type: string; payload: Record<string, unknown> } | undefined;
};

function createFetchSpy(options: { throws?: Error; delayMs?: number } = {}) {
  const requests: RecordedRequest[] = [];
  let release = () => {};
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    if (options.throws) throw options.throws;
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init.headers as Record<string, string>) || {})) {
      headers[key] = value;
    }
    requests.push({
      url: String(url),
      method: init.method || "GET",
      headers,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (options.delayMs !== undefined) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, options.delayMs);
        timer.unref?.();
        release = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, requests, release: () => release() };
}

describe("telemetry config resolution", () => {
  it("can be disabled by environment", () => {
    const config = resolveTelemetryConfig({
      env: { MENU_SPROUT_TELEMETRY: "0" },
      buildHost: "https://build.example",
      buildWebsiteID: "build-id",
    });

    expect(config.enabled).toBe(false);
  });

  it("honours off and false opt-out values", () => {
    for (const value of ["off", "false", "FALSE", " Off "]) {
      const config = resolveTelemetryConfig({
        env: { MENU_SPROUT_TELEMETRY: value },
        buildHost: "https://build.example",
        buildWebsiteID: "build-id",
      });
      expect(config.enabled).toBe(false);
    }
  });

  it("uses runtime env values before build-time defaults", () => {
    const config = resolveTelemetryConfig({
      env: {
        MENU_SPROUT_UMAMI_HOST: " https://env.example ",
        MENU_SPROUT_UMAMI_WEBSITE_ID: " env-id ",
      },
      buildHost: "https://build.example",
      buildWebsiteID: "build-id",
    });

    expect(config).toEqual({
      enabled: true,
      host: "https://env.example",
      websiteID: "env-id",
    });
  });

  it("disables when neither env nor build host is set instead of falling back to an upstream host", () => {
    const config = resolveTelemetryConfig({
      env: {},
      buildHost: "",
      buildWebsiteID: "build-id",
    });

    expect(config).toEqual({
      enabled: false,
      host: "",
      websiteID: "",
    });
  });

  it("disables when no website id is configured", () => {
    const config = resolveTelemetryConfig({
      env: {},
      buildHost: "https://build.example",
      buildWebsiteID: "",
    });

    expect(config.enabled).toBe(false);
  });
});

describe("telemetry switch precedence", () => {
  it("is on by default when neither the Settings switch nor the environment says otherwise", () => {
    expect(resolveTelemetryChoice({ env: {} })).toEqual({ enabled: true, source: "default" });
  });

  it("lets MENU_SPROUT_TELEMETRY opt out while no Settings choice is saved", () => {
    expect(resolveTelemetryChoice({ env: { MENU_SPROUT_TELEMETRY: "off" } })).toEqual({ enabled: false, source: "environment" });
  });

  it("gives a saved Settings choice precedence over the environment variable", () => {
    expect(resolveTelemetryChoice({ env: { MENU_SPROUT_TELEMETRY: "0" }, preference: true })).toEqual({
      enabled: true,
      source: "preference",
    });
    expect(resolveTelemetryChoice({ env: {}, preference: false })).toEqual({ enabled: false, source: "preference" });
  });

  it("resolves a configured target as enabled when the saved switch overrides an environment opt-out", () => {
    const config = resolveTelemetryConfig({
      env: { MENU_SPROUT_TELEMETRY: "0" },
      buildHost: "https://build.example",
      buildWebsiteID: "build-id",
      preference: true,
    });

    expect(config).toEqual({ enabled: true, host: "https://build.example", websiteID: "build-id" });
  });

  it("still sends nothing when the switch is on but no Umami endpoint is configured", () => {
    const fetchSpy = createFetchSpy();
    const client = initDefaultTelemetry({ version: "1.2.3", env: {}, fetch: fetchSpy.fetch, preference: true });

    client.track("app_start");

    expect(fetchSpy.requests).toHaveLength(0);
    expect(client.status()).toEqual({ enabled: true, source: "preference", configured: false });
  });

  it("stops and resumes sending when the Settings switch changes at runtime", async () => {
    const fetchSpy = createFetchSpy();
    const client = initDefaultTelemetry({
      version: "1.2.3",
      env: { MENU_SPROUT_UMAMI_HOST: "https://a.example.com", MENU_SPROUT_UMAMI_WEBSITE_ID: "site" },
      fetch: fetchSpy.fetch,
      preference: false,
    });
    expect(client.status()).toEqual({ enabled: false, source: "preference", configured: true });

    client.track("app_start");
    client.pageview("/popover");
    await client.close();
    expect(fetchSpy.requests).toHaveLength(0);

    const resumed = initDefaultTelemetry({
      version: "1.2.3",
      env: { MENU_SPROUT_UMAMI_HOST: "https://a.example.com", MENU_SPROUT_UMAMI_WEBSITE_ID: "site", MENU_SPROUT_TELEMETRY: "0" },
      fetch: fetchSpy.fetch,
    });
    expect(resumed.status()).toEqual({ enabled: false, source: "environment", configured: true });
    resumed.track("app_start");
    expect(fetchSpy.requests).toHaveLength(0);

    expect(resumed.setPreference(true)).toEqual({ enabled: true, source: "preference", configured: true });
    resumed.track("popover_open");
    resumed.pageview("/popover");
    expect(fetchSpy.requests).toHaveLength(2);
    expect(fetchSpy.requests[0].body?.payload.name).toBe("popover_open");
    expect(fetchSpy.requests[1].body?.payload.url).toBe("/popover");

    expect(resumed.setPreference(false)).toEqual({ enabled: false, source: "preference", configured: true });
    resumed.track("agent_turn");
    resumed.pageview("/popover");
    expect(fetchSpy.requests).toHaveLength(2);
    await resumed.close();
  });
});

describe("telemetry client", () => {
  it("returns a no-op client when disabled", async () => {
    const { fetch, requests } = createFetchSpy();
    const client = createTelemetryClient({
      enabled: false,
      host: "https://a.example.com",
      websiteID: "site-1",
      app: "menu-sprout",
      version: "1.0.0",
      fetch,
    });

    client.track("app_start", {});
    await client.close(50);
    expect(requests.length).toBe(0);
  });

  it("sends anonymous Umami event payloads", async () => {
    const { fetch, requests } = createFetchSpy();
    const client = createTelemetryClient({
      enabled: true,
      host: "https://a.example.com/umami/",
      websiteID: "site-1",
      app: "menu-sprout",
      version: "1.2.3",
      platform: "darwin",
      arch: "arm64",
      fetch,
    });

    client.track("agent_turn", { agent: "claude", status: "success" });
    await client.close(500);

    expect(requests.length).toBe(1);
    expect(requests[0].url).toBe("https://a.example.com/umami/api/send");
    expect(requests[0].method).toBe("POST");
    expect(requests[0].headers["Content-Type"]).toBe("application/json");
    expect(requests[0].headers["User-Agent"]).toMatch(/^menu-sprout\/1\.2\.3 telemetry$/);
    const payload = requests[0].body?.payload as Record<string, unknown>;
    expect(payload.website).toBe("site-1");
    expect(payload.hostname).toBe("app");
    expect(payload.title).toBe("Menu Sprout");
    expect(payload.url).toBe("app://menu-sprout/agent_turn");
    expect(payload.name).toBe("agent_turn");
    const data = payload.data as Record<string, unknown>;
    expect(data.agent).toBe("claude");
    expect(data.status).toBe("success");
    expect(data.platform).toBe("darwin");
    expect(data.arch).toBe("arm64");
    expect(data.version).toBe("1.2.3");
    expect(typeof payload.timestamp).toBe("number");
  });

  it("sends pageviews with an empty event name", async () => {
    const { fetch, requests } = createFetchSpy();
    const client = createTelemetryClient({
      enabled: true,
      host: "https://a.example.com",
      websiteID: "site-1",
      app: "menu-sprout",
      version: "1.0.0",
      fetch,
    });

    client.pageview("/launch");
    await client.close(500);

    expect(requests.length).toBe(1);
    const payload = requests[0].body?.payload as Record<string, unknown>;
    expect(payload.name).toBe("");
    expect(payload.url).toBe("/launch");
  });

  it("is best effort and never throws fetch failures", async () => {
    const client = createTelemetryClient({
      enabled: true,
      host: "https://a.example.com",
      websiteID: "site-1",
      app: "menu-sprout",
      version: "1.0.0",
      fetch: createFetchSpy({ throws: new Error("network down") }).fetch,
    });

    expect(() => client.track("app_start", {})).not.toThrow();
    await expect(client.close(500)).resolves.toBeUndefined();
  });

  it("close waits only up to the requested timeout", async () => {
    const { fetch, requests, release } = createFetchSpy({ delayMs: 10_000 });
    const client = createTelemetryClient({
      enabled: true,
      host: "https://a.example.com",
      websiteID: "site-1",
      app: "menu-sprout",
      version: "1.0.0",
      fetch,
    });

    client.track("app_start", {});
    await client.close(20);
    expect(requests.length).toBe(1);
    release();
  });
});
