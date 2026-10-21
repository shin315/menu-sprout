import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedMenuBarIcon } from "../src/main/menu-bar-items";

type FakeImage = {
  empty: boolean;
  size: { width: number; height: number };
  setTemplateImage: ReturnType<typeof vi.fn>;
  isEmpty: () => boolean;
  getSize: () => { width: number; height: number };
  resize: ReturnType<typeof vi.fn>;
};

function fakeImage(height = 16, empty = false): FakeImage {
  const image: FakeImage = {
    empty,
    size: { width: height, height },
    setTemplateImage: vi.fn(),
    isEmpty: () => image.empty,
    getSize: () => image.size,
    resize: vi.fn(({ height: nextHeight }: { height: number }) => fakeImage(nextHeight)),
  };
  return image;
}

type FakeTray = {
  image: unknown;
  on: ReturnType<typeof vi.fn>;
  setImage: ReturnType<typeof vi.fn>;
  setTitle: ReturnType<typeof vi.fn>;
  setToolTip: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

const trays: FakeTray[] = [];
const createFromPath = vi.fn((_path: string) => fakeImage());
const createFromDataURL = vi.fn((_url: string) => fakeImage());
const createEmpty = vi.fn(() => fakeImage(0, true));
const Tray = vi.fn(function MockTray(image: unknown) {
  const tray: FakeTray = {
    image,
    on: vi.fn(),
    setImage: vi.fn(),
    setTitle: vi.fn(),
    setToolTip: vi.fn(),
    destroy: vi.fn(),
  };
  trays.push(tray);
  return tray;
});

vi.mock("electron", () => ({
  nativeImage: { createFromPath, createFromDataURL, createEmpty },
  Tray,
}));

const fileIcon = (overrides: Partial<Extract<ResolvedMenuBarIcon, { kind: "file" }>> = {}): ResolvedMenuBarIcon => ({
  kind: "file",
  path: "/ext/demo/icon.png",
  mtimeMs: 1,
  size: 3,
  ...overrides,
});

describe("createMenuBarItemView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    trays.length = 0;
  });

  it("creates a text-only item with monospaced digits and a tooltip", async () => {
    const { createMenuBarItemView } = await import("../src/main/tray");
    const view = createMenuBarItemView({ extensionId: "demo", onClick: vi.fn() });

    expect(view.update({ text: "42%", tooltip: "cpu" }, null)).toBe(true);

    expect(Tray).toHaveBeenCalledTimes(1);
    expect(createEmpty).toHaveBeenCalled();
    expect(trays[0]?.setTitle).toHaveBeenCalledWith("42%", { fontType: "monospacedDigit" });
    expect(trays[0]?.setToolTip).toHaveBeenCalledWith("cpu");
  });

  it("reuses the same Tray for later updates and falls back to the text as tooltip", async () => {
    const { createMenuBarItemView } = await import("../src/main/tray");
    const view = createMenuBarItemView({ extensionId: "demo", onClick: vi.fn() });

    view.update({ text: "1" }, null);
    view.update({ text: "2" }, null);

    expect(Tray).toHaveBeenCalledTimes(1);
    expect(trays[0]?.setTitle).toHaveBeenLastCalledWith("2", { fontType: "monospacedDigit" });
    expect(trays[0]?.setToolTip).toHaveBeenLastCalledWith("2");
  });

  it("loads a PNG file icon as a template image", async () => {
    const { createMenuBarItemView } = await import("../src/main/tray");
    const view = createMenuBarItemView({ extensionId: "demo", onClick: vi.fn() });

    view.update({ text: "x", icon: "icon.png" }, fileIcon());

    expect(createFromPath).toHaveBeenCalledWith("/ext/demo/icon.png");
    const image = createFromPath.mock.results[0]?.value as FakeImage;
    expect(image.setTemplateImage).toHaveBeenCalledWith(true);
    expect(trays[0]?.image).toBe(image);
  });

  it("does not reload an unchanged icon on later updates", async () => {
    const { createMenuBarItemView } = await import("../src/main/tray");
    const view = createMenuBarItemView({ extensionId: "demo", onClick: vi.fn() });

    view.update({ text: "1", icon: "icon.png" }, fileIcon());
    view.update({ text: "2", icon: "icon.png" }, fileIcon());

    expect(createFromPath).toHaveBeenCalledTimes(1);
  });

  it("reloads an icon file that was redrawn in place under the same path", async () => {
    const { createMenuBarItemView } = await import("../src/main/tray");
    const view = createMenuBarItemView({ extensionId: "demo", onClick: vi.fn() });

    view.update({ text: "1", icon: "icon.png" }, fileIcon());
    view.update({ text: "1", icon: "icon.png" }, fileIcon({ mtimeMs: 2, size: 5 }));

    expect(createFromPath).toHaveBeenCalledTimes(2);
    expect(trays[0]?.setImage).toHaveBeenCalledWith(createFromPath.mock.results[1]?.value);
  });

  it("scales an oversized icon down to menu-bar height", async () => {
    createFromPath.mockReturnValueOnce(fakeImage(64));
    const { createMenuBarItemView } = await import("../src/main/tray");
    const view = createMenuBarItemView({ extensionId: "demo", onClick: vi.fn() });

    view.update({ icon: "icon.png" }, fileIcon());

    const original = createFromPath.mock.results[0]?.value as FakeImage;
    expect(original.resize).toHaveBeenCalledWith({ height: 16 });
  });

  it("accepts a PNG data URL icon", async () => {
    const { createMenuBarItemView } = await import("../src/main/tray");
    const view = createMenuBarItemView({ extensionId: "demo", onClick: vi.fn() });

    view.update({ icon: "data:image/png;base64,AAAA" }, { kind: "data", dataUrl: "data:image/png;base64,AAAA" });

    expect(createFromDataURL).toHaveBeenCalledWith("data:image/png;base64,AAAA");
    expect(Tray).toHaveBeenCalledTimes(1);
  });

  it("keeps the text when the icon was refused", async () => {
    const { createMenuBarItemView } = await import("../src/main/tray");
    const view = createMenuBarItemView({ extensionId: "demo", onClick: vi.fn() });

    view.update({ text: "x", icon: "../../etc/passwd.png" }, null);

    expect(createFromPath).not.toHaveBeenCalled();
    expect(trays[0]?.setTitle).toHaveBeenCalledWith("x", { fontType: "monospacedDigit" });
  });

  it("does not create an invisible item when the icon cannot load and there is no text", async () => {
    const { createMenuBarItemView } = await import("../src/main/tray");
    const view = createMenuBarItemView({ extensionId: "demo", onClick: vi.fn() });

    expect(view.update({ icon: "missing.png" }, null)).toBe(false);

    expect(Tray).not.toHaveBeenCalled();
  });

  it("forwards tray clicks with the item's bounds", async () => {
    const { createMenuBarItemView } = await import("../src/main/tray");
    const onClick = vi.fn();
    const view = createMenuBarItemView({ extensionId: "demo", onClick });

    view.update({ text: "x" }, null);
    const handler = trays[0]?.on.mock.calls.find(([event]) => event === "click")?.[1] as (...args: unknown[]) => void;
    handler({}, { x: 5, y: 0, width: 30, height: 24 });

    expect(onClick).toHaveBeenCalledWith({ x: 5, y: 0, width: 30, height: 24 });
  });

  it("destroys the Tray and can create a fresh one afterwards", async () => {
    const { createMenuBarItemView } = await import("../src/main/tray");
    const view = createMenuBarItemView({ extensionId: "demo", onClick: vi.fn() });

    view.update({ text: "x" }, null);
    view.destroy();
    expect(trays[0]?.destroy).toHaveBeenCalledTimes(1);

    view.destroy(); // idempotent
    expect(trays[0]?.destroy).toHaveBeenCalledTimes(1);

    view.update({ text: "y" }, null);
    expect(Tray).toHaveBeenCalledTimes(2);
  });
});
