import type { RefreshableMenuSproutWidget } from "../src/shared/contracts";
import { describe, expect, it } from "vitest";

const refreshableWidget: RefreshableMenuSproutWidget = {
  id: "quota",
  title: "Quota",
  viewRefreshIntervalMs: 1000,
  refreshView: async () => undefined,
  render: () => null,
};

void refreshableWidget;

// @ts-expect-error view refresh intervals require a refreshView callback.
const intervalWithoutRefresh: RefreshableMenuSproutWidget = {
  id: "quota",
  title: "Quota",
  viewRefreshIntervalMs: 1000,
  render: () => null,
};

void intervalWithoutRefresh;

describe("RefreshableMenuSproutWidget contract", () => {
  it("accepts widgets that pair view refresh intervals with refreshView callbacks", () => {
    expect(refreshableWidget.viewRefreshIntervalMs).toBe(1000);
  });
});
