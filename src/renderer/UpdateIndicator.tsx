import { useEffect, useState } from "react";
import { CircleArrowUp, ExternalLink } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
  DialogTrigger,
  Tooltip,
} from "../ui";
import type { UpdateStatus } from "../shared/contracts";

const UPDATE_STATUS_REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

// Sits in the popover header next to Settings. The host runs the actual release
// check in the main process; this reads the cached status on mount and, when a
// newer version exists, opens a small dialog that links to the GitHub release
// page where the new build is downloaded. Menu Sprout has no package-manager
// channel (no Homebrew cask), so the dialog never hands out an install command.
// Renders nothing (and never surfaces an error) when there is no update.
export function UpdateIndicator() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function refreshStatus() {
      try {
        const next = await window.menuSprout?.app.getUpdateStatus();
        if (!cancelled && next) setStatus(next);
      } catch {
        // Best-effort: a failed check should never disrupt the shell.
      }
    }

    void refreshStatus();
    const refreshTimer = setInterval(() => void refreshStatus(), UPDATE_STATUS_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(refreshTimer);
    };
  }, []);

  if (!status?.updateAvailable) return null;

  return (
    <Dialog>
      <Tooltip content={`Update available: v${status.latestVersion}`}>
        <DialogTrigger asChild>
          <Button variant="ghost" size="sm" className="w-7 px-0 text-signal-live" aria-label="update available">
            <CircleArrowUp className="size-4" />
          </Button>
        </DialogTrigger>
      </Tooltip>
      <DialogContent className="max-w-sm">
        <DialogTitle>Update available</DialogTitle>
        <DialogDescription>
          You{"’"}re on v{status.currentVersion}. v{status.latestVersion} is available.
        </DialogDescription>
        <DialogBody className="flex flex-col gap-2">
          <p className="text-sm text-ink-muted">Download the new build from the release page.</p>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => void window.menuSprout?.app.openReleasePage()}>
            <ExternalLink className="size-3.5" />
            Release notes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
