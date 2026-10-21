import type { MenuSproutMenuBarItem } from "@menusprout/contracts";

const clock = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export const menuBar: MenuSproutMenuBarItem = {
  intervalMs: 5_000,
  run: () => ({
    text: clock.format(new Date()),
    icon: "menu-bar-icon.png",
    tooltip: "Clock - click to open Menu Sprout",
  }),
};
