/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { helloWorldWidget } from "../extensions/hello-world/widget";

const writeText = vi.fn(async () => undefined);
const examplePrompts = [
  "add a widget showing the SJC gold price",
  "add a widget tracking Vietcombank VND exchange rates",
  "add a widget showing today's lunar calendar",
  "add a widget showing current CPU usage %",
];

beforeEach(() => {
  writeText.mockClear();
  Object.assign(navigator, { clipboard: { writeText } });
});

afterEach(() => {
  cleanup();
});

describe("hello-world widget", () => {
  it("renders the starter greeting and all examples from the repo-level extension", () => {
    render(<>{helloWorldWidget.render()}</>);
    expect(screen.getByText("hello sprout")).toBeTruthy();
    expect(screen.getByText("tell the sprout what you would like to grow")).toBeTruthy();
    expect(screen.getByText("examples")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(examplePrompts.length);
    for (const prompt of examplePrompts) {
      expect(screen.getByRole("button", { name: new RegExp(prompt, "i") }).tagName).toBe("BUTTON");
    }
  });

  it.each(examplePrompts)("copies %s to the clipboard when clicked", async (prompt) => {
    render(<>{helloWorldWidget.render()}</>);
    fireEvent.click(screen.getByRole("button", { name: new RegExp(prompt, "i") }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(prompt));
  });

  it("shows transient copied feedback after a click", async () => {
    render(<>{helloWorldWidget.render()}</>);
    const prompt = "add a widget showing current CPU usage %";
    fireEvent.click(screen.getByRole("button", { name: new RegExp(prompt, "i") }));

    await waitFor(() => expect(screen.getByText(/copied/i)).toBeTruthy());
  });
});
