// Anonymous, best-effort usage telemetry sent to a self-hosted Umami instance.
//
// This mirrors the lavish-axi telemetry contract: a single POST to Umami's
// `/api/send` endpoint per event, no user/device identifier, no prompt or file
// contents, and every network error swallowed so telemetry can never affect the
// app. The Umami host and website id are injected at build time (see the `define`
// block in electron.vite.config.ts) and can be overridden at runtime via env
// vars. With no website id or no host configured (the default in source/dev/test)
// the client is a no-op, so the app never phones home unless a build or the user
// explicitly points it at an Umami instance.
//
// The saved privacy choice gates an otherwise configured client; see
// PRIVACY.md for the opt-out policy.

import type { MenuSproutTelemetrySettings, MenuSproutTelemetrySource } from "../shared/contracts";

const UMAMI_PATH = "/api/send";
const DEFAULT_HOSTNAME = "app";
const DEFAULT_TITLE = "Menu Sprout";
const DEFAULT_APP = "menu-sprout";
const DEFAULT_REQUEST_TIMEOUT_MS = 1_000;

export type TelemetryEnv = Record<string, string | undefined>;

export type ResolveTelemetryConfigInput = {
  env: TelemetryEnv;
  buildHost: string;
  buildWebsiteID: string;
  /** The saved Settings switch; absent until the user flips it. */
  preference?: boolean;
};

export type TelemetryChoice = {
  enabled: boolean;
  source: MenuSproutTelemetrySource;
};

export type ResolvedTelemetryConfig = {
  enabled: boolean;
  host: string;
  websiteID: string;
};

export type TelemetryClientConfig = {
  enabled: boolean;
  host: string;
  websiteID: string;
  app?: string;
  version: string;
  platform?: string;
  arch?: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
};

export type TelemetryFields = Record<string, unknown>;

export interface TelemetryClient {
  track(name: string, fields?: TelemetryFields): void;
  pageview(path: string, fields?: TelemetryFields): void;
  close(timeoutMs?: number): Promise<void>;
}

export function resolveTelemetryChoice(input: { env: TelemetryEnv; preference?: boolean }): TelemetryChoice {
  if (typeof input.preference === "boolean") return { enabled: input.preference, source: "preference" };
  const optOut = String(input.env.MENU_SPROUT_TELEMETRY || "")
    .trim()
    .toLowerCase();
  if (optOut === "0" || optOut === "false" || optOut === "off") return { enabled: false, source: "environment" };
  return { enabled: true, source: "default" };
}

export function resolveTelemetryConfig(input: ResolveTelemetryConfigInput): ResolvedTelemetryConfig {
  const target = resolveTelemetryTarget(input);
  if (!target || !resolveTelemetryChoice(input).enabled) {
    return { enabled: false, host: "", websiteID: "" };
  }
  return { enabled: true, ...target };
}

function resolveTelemetryTarget(input: ResolveTelemetryConfigInput): { host: string; websiteID: string } | null {
  const websiteID = String(input.env.MENU_SPROUT_UMAMI_WEBSITE_ID || "").trim() || input.buildWebsiteID.trim();
  if (!websiteID) return null;
  const host = String(input.env.MENU_SPROUT_UMAMI_HOST || "").trim() || input.buildHost.trim();
  if (!host) return null;
  return { host, websiteID };
}

// These two references are replaced at build time by electron-vite's `define`.
// In source/dev/test they read as undefined and the client stays a no-op.
export function getBuildTimeUmamiHost(): string {
  return process.env.MENU_SPROUT_BUILD_UMAMI_HOST || "";
}

export function getBuildTimeUmamiWebsiteID(): string {
  return process.env.MENU_SPROUT_BUILD_UMAMI_WEBSITE_ID || "";
}

export function createTelemetryClient(config: TelemetryClientConfig): TelemetryClient {
  if (!config.enabled || !config.websiteID) {
    return new NoopTelemetryClient();
  }
  const endpoint = normalizeEndpoint(config.host);
  if (!endpoint) {
    return new NoopTelemetryClient();
  }
  return new HttpTelemetryClient(endpoint, config);
}

/** The app-wide client: sends only while the user's choice allows it. */
export interface SwitchableTelemetryClient extends TelemetryClient {
  status(): MenuSproutTelemetrySettings;
  /** Applies a newly saved Settings choice; takes effect for the next event. */
  setPreference(enabled: boolean): MenuSproutTelemetrySettings;
}

let defaultClient: TelemetryClient | null = null;

export type InitTelemetryInput = {
  app?: string;
  version: string;
  platform?: string;
  arch?: string;
  env?: TelemetryEnv;
  fetch?: typeof fetch;
  /** The saved Settings switch; absent until the user flips it. */
  preference?: boolean;
};

export function initDefaultTelemetry(init: InitTelemetryInput): SwitchableTelemetryClient {
  const env = init.env || process.env;
  const target = resolveTelemetryTarget({
    env,
    buildHost: getBuildTimeUmamiHost(),
    buildWebsiteID: getBuildTimeUmamiWebsiteID(),
  });
  const inner = createTelemetryClient({
    enabled: target !== null,
    host: target?.host ?? "",
    websiteID: target?.websiteID ?? "",
    app: init.app,
    version: init.version,
    platform: init.platform,
    arch: init.arch,
    fetch: init.fetch,
  });
  const client = new GatedTelemetryClient(inner, env, init.preference);
  defaultClient = client;
  return client;
}

export function getDefaultTelemetry(): TelemetryClient {
  return defaultClient || new NoopTelemetryClient();
}

export function resetDefaultTelemetryForTests(): void {
  defaultClient = null;
}

class GatedTelemetryClient implements SwitchableTelemetryClient {
  private choice: TelemetryChoice;

  constructor(
    private readonly inner: TelemetryClient,
    private readonly env: TelemetryEnv,
    preference: boolean | undefined,
  ) {
    this.choice = resolveTelemetryChoice({ env, preference });
  }

  track(name: string, fields?: TelemetryFields): void {
    if (this.choice.enabled) this.inner.track(name, fields);
  }

  pageview(path: string, fields?: TelemetryFields): void {
    if (this.choice.enabled) this.inner.pageview(path, fields);
  }

  close(timeoutMs?: number): Promise<void> {
    return this.inner.close(timeoutMs);
  }

  status(): MenuSproutTelemetrySettings {
    return { ...this.choice, configured: this.inner instanceof HttpTelemetryClient };
  }

  setPreference(enabled: boolean): MenuSproutTelemetrySettings {
    this.choice = resolveTelemetryChoice({ env: this.env, preference: enabled });
    return this.status();
  }
}

class NoopTelemetryClient implements TelemetryClient {
  track(): void {}

  pageview(): void {}

  async close(): Promise<void> {}
}

class HttpTelemetryClient implements TelemetryClient {
  private readonly websiteID: string;
  private readonly app: string;
  private readonly version: string;
  private readonly platform: string;
  private readonly arch: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly inFlight = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly endpoint: string,
    config: TelemetryClientConfig,
  ) {
    this.websiteID = config.websiteID;
    this.app = config.app || DEFAULT_APP;
    this.version = config.version;
    this.platform = config.platform || "";
    this.arch = config.arch || "";
    this.fetchImpl = config.fetch || fetch;
    this.timeoutMs = config.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    this.userAgent = `${this.app}/${config.version} telemetry`;
  }

  track(name: string, fields: TelemetryFields = {}): void {
    if (this.closed) return;
    const trimmed = String(name || "").trim();
    if (!trimmed) return;
    this.send(trimmed, eventURL(this.app, trimmed), fields);
  }

  pageview(path: string, fields: TelemetryFields = {}): void {
    if (this.closed) return;
    this.send("", normalizePagePath(path), fields);
  }

  async close(timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS): Promise<void> {
    this.closed = true;
    if (this.inFlight.size === 0 || timeoutMs <= 0) return;
    const drained = Promise.allSettled(Array.from(this.inFlight)).then(() => undefined);
    await Promise.race([
      drained,
      new Promise<void>((resolve) => {
        setTimeout(resolve, timeoutMs);
      }),
    ]);
  }

  private send(name: string, url: string, fields: TelemetryFields): void {
    const data: TelemetryFields = { ...fields };
    if (this.platform && data.platform === undefined) data.platform = this.platform;
    if (this.arch && data.arch === undefined) data.arch = this.arch;
    if (data.version === undefined) data.version = this.version;

    const payload = {
      type: "event",
      payload: {
        website: this.websiteID,
        hostname: DEFAULT_HOSTNAME,
        title: DEFAULT_TITLE,
        url,
        name,
        data,
        timestamp: Math.floor(Date.now() / 1000),
      },
    };

    let body: string;
    try {
      body = JSON.stringify(payload);
    } catch {
      return;
    }

    const request = this.fire(body);
    this.inFlight.add(request);
    void request.finally(() => this.inFlight.delete(request));
  }

  private async fire(body: string): Promise<void> {
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": this.userAgent,
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      try {
        await response.body?.cancel?.();
      } catch {
        // Best effort only.
      }
    } catch {
      // Telemetry must never affect app behavior.
    }
  }
}

function normalizeEndpoint(host: string): string | null {
  let url: URL;
  try {
    url = new URL(String(host || "").trim());
  } catch {
    return null;
  }
  if (!url.protocol || !url.host) return null;
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.endsWith(UMAMI_PATH) ? pathname : pathname + UMAMI_PATH;
  return url.toString();
}

function eventURL(app: string, name: string): string {
  if (!name) return `app://${app}`;
  return `app://${app}/${name.replace(/\./g, "/")}`;
}

function normalizePagePath(path: string): string {
  const trimmed = String(path || "").trim();
  if (!trimmed) return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
