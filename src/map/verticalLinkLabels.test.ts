import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildVerticalLinkLabelImage,
  paintVerticalLinkLabel,
  registerVerticalLinkLabelImages,
  verticalLinkLabelImageName,
  verticalLinkLabelPairs,
  verticalLinkLabelText,
} from "./verticalLinkLabels";

const feature = (properties: Record<string, unknown>): GeoJSON.Feature => ({
  type: "Feature",
  properties,
  geometry: { type: "Point", coordinates: [139.7, 35.6] },
});

afterEach(() => {
  vi.restoreAllMocks();
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

describe("paintVerticalLinkLabel", () => {
  it("draws the arrow and floor token with a white halo under magenta fill", () => {
    const calls: string[] = [];
    const ctx = {
      font: "",
      textAlign: "",
      textBaseline: "",
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      lineJoin: "",
      strokeText: (text: string) => {
        calls.push(`stroke:${text}`);
      },
      fillText: (text: string) => {
        calls.push(`fill:${text}`);
      },
      getImageData: () => ({ width: 48, height: 20, data: new Uint8ClampedArray(4) }),
    };

    paintVerticalLinkLabel(ctx, "up", "F3");
    paintVerticalLinkLabel(ctx, "down", "F1");

    expect(calls).toEqual([
      "stroke:↑ F3",
      "fill:↑ F3",
      "stroke:↓ F1",
      "fill:↓ F1",
    ]);
    expect(ctx.font).toContain("11px");
    expect(ctx.fillStyle).toBe("#d81b8c");
    expect(ctx.strokeStyle).toBe("#ffffff");
    expect(ctx.lineWidth).toBe(3);
    expect(ctx.textBaseline).toBe("middle");
  });
});

describe("buildVerticalLinkLabelImage", () => {
  it("rasterizes to addImage-ready RGBA image data via the 2d context", () => {
    const pixels = new Uint8ClampedArray(48 * 20 * 4);
    pixels.fill(255);
    const ctx = {
      font: "",
      textAlign: "",
      textBaseline: "",
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      lineJoin: "",
      strokeText: () => {},
      fillText: () => {},
      getImageData: vi.fn(() => ({ width: 48, height: 20, data: pixels })),
    };
    const fakeCanvas = {
      width: 0,
      height: 0,
      getContext: () => ctx,
    };
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(
      (tag: string, options?: ElementCreationOptions) => {
        if (tag.toLowerCase() === "canvas") {
          return fakeCanvas as unknown as HTMLElement;
        }
        return createElement(tag, options);
      },
    );

    const image = buildVerticalLinkLabelImage("up", "F3");

    expect(fakeCanvas.width).toBe(48);
    expect(fakeCanvas.height).toBe(20);
    expect(image).toEqual({ width: 48, height: 20, data: pixels });
    expect(ctx.getImageData).toHaveBeenCalledWith(0, 0, 48, 20);
  });

  it("returns null when no 2d rasterizer is available", () => {
    const realCanvas = document.createElement("canvas");
    vi.spyOn(realCanvas, "getContext").mockReturnValue(null);
    vi.spyOn(document, "createElement").mockImplementation(
      (tag: string, options?: ElementCreationOptions) =>
        tag.toLowerCase() === "canvas" ? realCanvas : document.createElement(tag, options),
    );
    expect(buildVerticalLinkLabelImage("up", "F3")).toBeNull();
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
  /** Stub the canvas 2d rasterizer so the real registration path runs end to end. */
  function stubCanvasRasterizer(): { calls: string[] } {
    const calls: string[] = [];
    const ctx = {
      font: "",
      textAlign: "",
      textBaseline: "",
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 0,
      lineJoin: "",
      strokeText: (text: string) => {
        calls.push(`stroke:${text}`);
      },
      fillText: (text: string) => {
        calls.push(`fill:${text}`);
      },
      getImageData: () => ({
        width: 48,
        height: 20,
        data: new Uint8ClampedArray(48 * 20 * 4),
      }),
    };
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(
      (tag: string, options?: ElementCreationOptions) =>
        tag.toLowerCase() === "canvas"
          ? ({ width: 0, height: 0, getContext: () => ctx } as unknown as HTMLElement)
          : createElement(tag, options),
    );
    return { calls };
  }

  it("registers one canvas-drawn image per unique pair, never via loadImage", () => {
    const { calls } = stubCanvasRasterizer();
    const added: string[] = [];
    const registry = {
      hasImage: vi.fn(() => false),
      addImage: vi.fn((id: string) => {
        added.push(id);
      }),
    };
    // The glyph-independent path must not route through map.loadImage at all.
    expect(registry).not.toHaveProperty("loadImage");

    const features = [
      feature({ kind: "vertical-link", targetDirection: "up", targetFloor: "F3" }),
      feature({ kind: "vertical-link", targetDirection: "down", targetFloor: "F1" }),
    ];
    registerVerticalLinkLabelImages(registry, features);

    expect(registry.addImage).toHaveBeenCalledTimes(2);
    expect(registry.addImage).toHaveBeenCalledWith("vertical-link-label-up-F3", {
      width: 48,
      height: 20,
      data: expect.any(Uint8ClampedArray),
    });
    expect(registry.addImage).toHaveBeenCalledWith("vertical-link-label-down-F1", {
      width: 48,
      height: 20,
      data: expect.any(Uint8ClampedArray),
    });
    expect(added).toEqual(["vertical-link-label-up-F3", "vertical-link-label-down-F1"]);
    expect(calls).toEqual([
      "stroke:↑ F3",
      "fill:↑ F3",
      "stroke:↓ F1",
      "fill:↓ F1",
    ]);

    // Re-registration is a no-op once the images exist.
    registry.hasImage.mockReturnValue(true);
    registerVerticalLinkLabelImages(registry, features);
    expect(registry.addImage).toHaveBeenCalledTimes(2);
  });

  it("registers nothing when there are no vertical-link features", () => {
    stubCanvasRasterizer();
    const registry = {
      hasImage: vi.fn(() => false),
      addImage: vi.fn(),
    };
    registerVerticalLinkLabelImages(registry, [feature({ kind: "junction" })]);
    expect(registry.addImage).not.toHaveBeenCalled();
  });
});
