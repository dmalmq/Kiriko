import type {
  AddProtocolAction,
  RasterDEMSourceSpecification,
} from "maplibre-gl";

export const FLOOR_ELEVATION_PROTOCOL = "kiriko-floor";
export const FLOOR_ELEVATION_SOURCE_ID = "kiriko-floor-elevation";

const TILE_SIZE = 256;
const TERRARIUM_OFFSET_M = 32_768;
const TERRARIUM_SCALE = 256;
const MAX_TERRARIUM_VALUE = 0xff_ff_ff;
const FLOOR_URL = /^kiriko-floor:\/\/(-?\d+)\//;

export type FloorTileEncoder = (
  rgb: readonly [number, number, number],
) => Promise<ArrayBuffer>;

function encodedTerrariumValue(millimetres: number): number | null {
  if (!Number.isSafeInteger(millimetres)) {
    return null;
  }
  const value = Math.round(
    (millimetres / 1000 + TERRARIUM_OFFSET_M) * TERRARIUM_SCALE,
  );
  return value >= 0 && value <= MAX_TERRARIUM_VALUE ? value : null;
}

export function terrariumRgbForMillimetres(
  millimetres: number,
): readonly [number, number, number] | null {
  const value = encodedTerrariumValue(millimetres);
  if (value === null) {
    return null;
  }
  return [
    Math.floor(value / 65_536),
    Math.floor((value % 65_536) / 256),
    value % 256,
  ];
}

export function floorElevationTileUrl(planeM: number): string | null {
  if (!Number.isFinite(planeM)) {
    return null;
  }
  const millimetres = Math.round(planeM * 1000);
  if (terrariumRgbForMillimetres(millimetres) === null) {
    return null;
  }
  return `${FLOOR_ELEVATION_PROTOCOL}://${millimetres}/{z}/{x}/{y}`;
}

export function floorElevationSource(): RasterDEMSourceSpecification {
  return {
    type: "raster-dem",
    tiles: [`${FLOOR_ELEVATION_PROTOCOL}://0/{z}/{x}/{y}`],
    tileSize: TILE_SIZE,
    minzoom: 0,
    maxzoom: 22,
    encoding: "terrarium",
  };
}

async function encodeSolidPng(
  rgb: readonly [number, number, number],
): Promise<ArrayBuffer> {
  const canvas = document.createElement("canvas");
  canvas.width = TILE_SIZE;
  canvas.height = TILE_SIZE;
  const context = canvas.getContext("2d", { alpha: false });
  if (context === null) {
    throw new Error("floor elevation: 2D canvas is unavailable");
  }
  context.fillStyle = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  context.fillRect(0, 0, TILE_SIZE, TILE_SIZE);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result === null) {
        reject(new Error("floor elevation: PNG encoding failed"));
        return;
      }
      resolve(result);
    }, "image/png");
  });
  return blob.arrayBuffer();
}

function abortedRequest(controller: AbortController): Error {
  const reason: unknown = controller.signal.reason;
  return reason instanceof Error
    ? reason
    : new DOMException("The floor elevation request was aborted", "AbortError");
}

export function createFloorElevationProtocol(
  encodePng: FloorTileEncoder = encodeSolidPng,
): AddProtocolAction {
  const tiles = new Map<number, Promise<ArrayBuffer>>();

  return async (requestParameters, abortController) => {
    if (abortController.signal.aborted) {
      throw abortedRequest(abortController);
    }

    const match = FLOOR_URL.exec(requestParameters.url);
    const millimetres = match === null ? Number.NaN : Number(match[1]);
    const rgb = terrariumRgbForMillimetres(millimetres);
    if (rgb === null) {
      throw new Error("invalid floor elevation tile URL");
    }

    let data = tiles.get(millimetres);
    if (data === undefined) {
      data = encodePng(rgb).catch((error: unknown) => {
        tiles.delete(millimetres);
        throw error;
      });
      tiles.set(millimetres, data);
    }
    return { data: await data };
  };
}
