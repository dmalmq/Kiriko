import { describe, expect, it, vi } from "vitest";
import {
  createFloorElevationProtocol,
  floorElevationSource,
  floorElevationTileUrl,
  terrariumRgbForMillimetres,
} from "./floorElevation";

describe("floor elevation DEM", () => {
  it("keys finite representable planes by signed millimetres", () => {
    expect(floorElevationTileUrl(8)).toBe("kiriko-floor://8000/{z}/{x}/{y}");
    expect(floorElevationTileUrl(-6.02)).toBe("kiriko-floor://-6020/{z}/{x}/{y}");
    expect(floorElevationTileUrl(Number.NaN)).toBeNull();
    expect(floorElevationTileUrl(40_000)).toBeNull();
  });

  it("encodes Terrarium zero and whole metres exactly", () => {
    expect(terrariumRgbForMillimetres(0)).toEqual([128, 0, 0]);
    expect(terrariumRgbForMillimetres(8_000)).toEqual([128, 8, 0]);
  });

  it("caches one PNG per plane across tile coordinates", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71]).buffer;
    const encode = vi.fn(async () => bytes);
    const load = createFloorElevationProtocol(encode);
    const abort = new AbortController();

    const first = await load(
      { url: "kiriko-floor://8000/18/232800/103246" },
      abort,
    );
    const second = await load(
      { url: "kiriko-floor://8000/19/465600/206492" },
      abort,
    );

    expect(first.data).toBe(bytes);
    expect(second.data).toBe(bytes);
    expect(encode).toHaveBeenCalledOnce();
    expect(encode).toHaveBeenCalledWith([128, 8, 0]);
  });

  it("rejects malformed and unrepresentable protocol keys", async () => {
    const encode = vi.fn(async () => new ArrayBuffer(1));
    const load = createFloorElevationProtocol(encode);
    const abort = new AbortController();

    await expect(load({ url: "kiriko-floor://not-a-plane/0/0/0" }, abort)).rejects.toThrow(
      "invalid floor elevation",
    );
    await expect(load({ url: "kiriko-floor://40000000/0/0/0" }, abort)).rejects.toThrow(
      "invalid floor elevation",
    );
    expect(encode).not.toHaveBeenCalled();
  });

  it("does not start encoding an already-aborted request", async () => {
    const encode = vi.fn(async () => new ArrayBuffer(1));
    const load = createFloorElevationProtocol(encode);
    const abort = new AbortController();
    abort.abort(new Error("cancelled"));

    await expect(load({ url: "kiriko-floor://8000/0/0/0" }, abort)).rejects.toThrow(
      "cancelled",
    );
    expect(encode).not.toHaveBeenCalled();
  });

  it("declares a Terrarium raster-dem source without activating terrain", () => {
    expect(floorElevationSource()).toEqual({
      type: "raster-dem",
      tiles: ["kiriko-floor://0/{z}/{x}/{y}"],
      tileSize: 256,
      minzoom: 0,
      maxzoom: 22,
      encoding: "terrarium",
    });
  });
});
