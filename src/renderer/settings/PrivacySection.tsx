import { Switch } from "../../ui";
import type { MenuSproutTelemetrySettings } from "../../shared/contracts";

// Summarize the authoritative disclosure in PRIVACY.md; changes to outbound
// data flows must keep this in-app disclosure accurate too.
const OUTBOUND_FLOWS: Array<{ title: string; detail: string }> = [
  {
    title: "usage telemetry",
    detail:
      "Only while the switch above is on and an Umami host and website id are configured at build time or launch: app start, popover opens, agent turn outcomes, and agent switches (a built-in agent name or \"custom\"), with the app version, platform, and architecture. Never a user or device id, prompts, file contents, or paths. Source checkouts and pnpm dev send nothing unless MENU_SPROUT_UMAMI_HOST and MENU_SPROUT_UMAMI_WEBSITE_ID are set at launch.",
  },
  {
    title: "your agent's model provider",
    detail:
      "Every message you send, and whatever the agent reads or runs while it works, goes to the provider behind the agent CLI you picked. Menu Sprout approves every tool call without asking: Claude Code runs with bypassPermissions, Codex with --dangerously-bypass-approvals-and-sandbox, Antigravity with --dangerously-skip-permissions, and custom ACP agents are auto-approved.",
  },
  {
    title: "widget screenshots",
    detail:
      "Before it reports a widget done, the agent is told to capture a PNG of that one rendered widget and look at it, so the image goes to the same model provider.",
  },
  {
    title: "extension server code",
    detail:
      "An extension's server.ts runs inside Menu Sprout with full Node access: it can read your files, run commands, and call any network service. Quota widgets built from the bundled recipes read another tool's saved sign-in (a credential file, a local app database, or the macOS Keychain) and send that token to the provider's usage API.",
  },
  {
    title: "update check",
    detail:
      "Packaged builds ask the GitHub releases API for the latest Menu Sprout release. After the first successful response, checks are spaced at least 4 hours apart, including after later failures. Until then, each status request can retry immediately after a failure, including when no release exists yet. Development builds make no request.",
  },
];

const LOCAL_NOTES: Array<{ title: string; detail: string }> = [
  {
    title: "shared database",
    detail: "All extensions share one local SQLite database, so any extension can read or change another extension's tables.",
  },
];

type PrivacySectionProps = {
  telemetry: MenuSproutTelemetrySettings;
  onTelemetryChange: (enabled: boolean) => void;
};

export function PrivacySection({ telemetry, onTelemetryChange }: PrivacySectionProps) {
  return (
    <section className="flex flex-col gap-3" aria-label="privacy">
      <span className="text-xxs uppercase tracking-caps text-ink-label">privacy</span>
      <div className="flex items-center justify-between gap-4">
        <span className="flex flex-col gap-0.5">
          <span className="text-sm text-ink">anonymous usage telemetry</span>
          <span className="text-xs text-ink-soft">{telemetryHint(telemetry)}</span>
        </span>
        <Switch
          checked={telemetry.enabled}
          onCheckedChange={onTelemetryChange}
          aria-label="anonymous usage telemetry"
        />
      </div>
      <FlowList label="what leaves this Mac" items={OUTBOUND_FLOWS} />
      <FlowList label="what stays on this Mac" items={LOCAL_NOTES} />
    </section>
  );
}

function telemetryHint(telemetry: MenuSproutTelemetrySettings): string {
  if (!telemetry.configured) {
    return "An Umami host and website id are not both configured, so nothing is sent either way. Your choice is still saved.";
  }
  if (telemetry.source === "environment") {
    return "Off because MENU_SPROUT_TELEMETRY is set in the launch environment. Flipping this saves your own choice, which takes precedence.";
  }
  return telemetry.enabled ? "On. Turn it off to stop sending." : "Off. Nothing is sent.";
}

function FlowList({ label, items }: { label: string; items: Array<{ title: string; detail: string }> }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-ink-strong">{label}</span>
      <ul aria-label={label} className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.title} className="flex flex-col gap-0.5 rounded-sm border border-line px-3 py-2">
            <span className="text-sm text-ink">{item.title}</span>
            <span className="text-xs text-ink-soft">{item.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
