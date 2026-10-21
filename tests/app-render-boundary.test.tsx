// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/renderer/App";

// Stands in for a menu surface that throws outside any widget boundary (e.g. in
// discovery or layout plumbing) until the user reloads.
const surface = vi.hoisted(() => ({ broken: true }));
vi.mock("../src/renderer/menu/MenuSurface", () => ({
  MenuSurface: () => {
    if (surface.broken) throw new Error("layout plumbing exploded at /Users/someone/.menu-sprout/extensions/layout.tsx:3");
    return <section className="menu-surface">menu-ok</section>;
  },
}));

afterEach(() => {
  cleanup();
  surface.broken = true;
  vi.restoreAllMocks();
});

describe("App root render boundary", () => {
  it("keeps the header and agent chat mounted when the menu surface throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(<App />);

    const card = screen.getByRole("alert");
    expect(card.textContent).toContain("The menu failed to render");
    expect(card.textContent).toContain("layout.tsx:3");
    expect(card.textContent).not.toContain("/Users/someone");
    expect(screen.getByLabelText("reload layout")).toBeTruthy();
    expect(screen.getByLabelText("open settings")).toBeTruthy();
    expect(screen.getByLabelText("quit menu_sprout")).toBeTruthy();
    expect(screen.getByPlaceholderText("talk to the sprout")).toBeTruthy();
  });

  it("recovers the menu surface on Reload once the cause is fixed", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<App />);
    expect(screen.queryByRole("alert")).not.toBeNull();

    surface.broken = false;
    fireEvent.click(screen.getByLabelText("reload layout"));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("menu-ok")).toBeTruthy();
  });
});
