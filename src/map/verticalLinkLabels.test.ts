import { describe, expect, it, vi } from "vitest";
import {
  buildVerticalLinkLabelImageDataUrl,
  registerVerticalLinkLabelImages,
  verticalLinkLabelImageName,
  verticalLinkLabelPairs,
  verticalLinkLabelText,
} from "./verticalLinkLabels";

const feature = (
  properties: Record<string, unknown>,
): GeoJSON.Feature => ({
  type: "Feature",
  properties,
  geometry: { type: "Point", coordinates: [139.7, 35.6] },
});

describe("verticalLinkLabelImageName", () => {
  it("is deterministic per (direction, floor) pair", () => {
    expect(verticalLinkLabelImageName("up", "F3")).toBe("vertical-link-label-up-F3");
    expect(verticalLinkLabelImageName("down", "F1")).toBe("vertical-link-label-down-F1");
  });
});

describe("verticalLinkLabelText", () => {
  it("uses a neutral arrow plus the language-neutral floor token", () => {
    expect(verticalLinkLabelText("up", "F3")).toBe("↑ F3");
    expect(verticalLinkLabelText("down", "F1")).toBe("↓ F1");
  });
});

describe("buildVerticalLinkLabelImageDataUrl", () => {
  it("bakes the arrow and floor token into the SVG without style glyphs", () => {
    const up = decodeURIComponent(buildVerticalLinkLabelImageDataUrl("up", "F3"));
    expect(buildVerticalLinkLabelImageDataUrl("up", "F3")).toMatch(/^data:image\/svg\+xml/);
    expect(up).toContain("↑");
    expect(up).toContain("F3");
    const down = decodeURIComponent(buildVerticalLinkLabelImageDataUrl("down", "F1"));
    expect(down).toContain("↓");
    expect(down).toContain("F1");
  });
});

describe("verticalLinkLabelPairs", () => {
  it("collects unique pairs from vertical-link features only", () => {
    const features = [
      feature({ kind: "vertical-link", targetDirection: "up", targetFloor: "F3" }),
      feature({ kind: "vertical-link", targetDirection: "up", targetFloor: "F3" }),
      feature({ kind: "vertical-link", targetDirection: "down", targetFloor: "F1" }),
      feature({ kind: "path", targetDirection: "up", targetFloor: "F9" }),
    ];
    expect(verticalLinkLabelPairs(features)).toEqual([
      { direction: "up", targetFloor: "F3" },
      { direction: "down", targetFloor: "F1" },
    ]);
  });
});

describe("registerVerticalLinkLabelImages", () => {
  it("registers one map image per unique pair and skips existing ids", async () => {
    const added: string[] = [];
    const registry = {
      hasImage: vi.fn(() => false),
      loadImage: vi.fn(() =>
        Promise.resolve({ data: { width: 1, height: 1, data: new Uint8Array(4) } }),
      ),
      addImage: vi.fn((id: string, _image: unknown) => {
        added.push(id);
      }),
    };
    const features = [
      feature({ kind: "vertical-link", targetDirection: "up", targetFloor: "F3" }),
      feature({ kind: "vertical-link", targetDirection: "down", targetFloor: "F1" }),
    ];
    registerVerticalLinkLabelImages(registry, features);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registry.loadImage).toHaveBeenCalledTimes(2);
    expect(registry.loadImage).toHaveBeenCalledWith(
      expect.stringContaining("data:image/svg+xml"),
    );
    expect(added).toEqual(["vertical-link-label-up-F3", "vertical-link-label-down-F1"]);

    // Re-registration is a no-op once the images exist.
    registry.hasImage.mockReturnValue(true);
    registerVerticalLinkLabelImages(registry, features);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registry.loadImage).toHaveBeenCalledTimes(2);
    expect(registry.addImage).toHaveBeenCalledTimes(2);
  });

  it("registers nothing when there are no vertical-link features", async () => {
    const registry = {
      hasImage: vi.fn(() => false),
      loadImage: vi.fn(() =>
        Promise.resolve({ data: { width: 1, height: 1, data: new Uint8Array(4) } }),
      ),
      addImage: vi.fn(),
    };
    registerVerticalLinkLabelImages(registry, [feature({ kind: "junction" })]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(registry.loadImage).not.toHaveBeenCalled();
    expect(registry.addImage).not.toHaveBeenCalled();
  });
});
