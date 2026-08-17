import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { decodeBundle, initKirikoWasm, levelElevations, sceneProjection } from "./wasm";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures");

async function readGoldenBundle(): Promise<Uint8Array> {
  const bytes = await readFile(join(FIXTURES_DIR, "minimal.kvb"));
  return new Uint8Array(bytes);
}

/** The real bundle published before §8 existed (committed as `3e1add8208…`). */
async function readLegacyBundle(): Promise<Uint8Array> {
  const bytes = await readFile(join(FIXTURES_DIR, "legacy-minimal.kvb"));
  return new Uint8Array(bytes);
}

/** Flips one byte to produce each stable `kvb1` corruption case. */
function corrupt(bytes: Uint8Array, mutate: (b: Uint8Array) => void): Uint8Array {
  const copy = new Uint8Array(bytes);
  mutate(copy);
  return copy;
}

beforeAll(async () => {
  await initKirikoWasm();
});

describe("decodeBundle", () => {
  it("decodes the golden fixture into the full venue DTO", async () => {
    const bytes = await readGoldenBundle();
    const response = decodeBundle(bytes);

    expect(response.ok).toBe(true);
    const venue = response.venue!;
    expect(venue.datasetId).toBe("minimal");
    expect(venue.version).toBe(1);
    expect(venue.venueId).toBe("a1000001-0000-4000-8000-000000000001");
    expect(venue.levels.map((l) => l.ordinal)).toEqual([1, 0, -1]);
    expect(venue.features).toHaveLength(27);
    expect(venue.warnings).toHaveLength(5);
    expect(venue.stats).toEqual({ levels: 3, features: 27 });
    expect(response.error).toBeNull();
  });

  it("reports §5 graph presence on the decode result", async () => {
    const bytes = await readGoldenBundle();
    // The golden fixture is compiled without a network: no graph section.
    const decoded = decodeBundle(bytes);
    expect(decoded.hasGraph).toBe(false);
    expect(decoded.networkQa).toBeNull();
  });

  it("reports why each optional section is unavailable, not just that it is", async () => {
    const bytes = await readGoldenBundle();
    const response = decodeBundle(bytes);

    // The golden fixture carries no graph or facilities but does carry the
    // §8 spatial context section and the compiled §9 generated scene.
    // `absent` must be distinguishable from a section that is present but
    // unreadable, which is what `hasGraph`/`hasFacilities` alone cannot
    // express; graph attrs (§12) and the declared future sections (§10–§11)
    // are absent.
    expect(response.capabilities).toEqual({
      graph: { state: "absent" },
      graphAttrs: { state: "absent" },
      graphTraversal: { state: "absent" },
      facilities: { state: "absent" },
      spatialContext: { state: "available" },
      sceneSources: { state: "available" },
      canonicalGraph: { state: "absent" },
      networkQa: { state: "absent" },
    });
  });

  it("decodes complete source properties, including nulls and unknown keys", async () => {
    const bytes = await readGoldenBundle();
    const response = decodeBundle(bytes);
    const occupant = response.venue!.features.find(
      (f) => f.id === "a1000008-0000-4000-8000-0000000000c1",
    )!;

    expect(occupant.sourceProperties.category).toBe("shopping");
    expect(occupant.sourceProperties.anchor_id).toBe("a1000007-0000-4000-8000-0000000000a1");
    expect(occupant.sourceProperties.hours).toBe("Mo-Fr 10:00-20:00");
    expect(occupant.sourceProperties.phone).toBeNull();
    expect(occupant.sourceProperties.website).toBeNull();

    const venueFeature = response.venue!.features.find(
      (f) => f.id === "a1000001-0000-4000-8000-000000000001",
    )!;
    expect(venueFeature.sourceProperties.address_id).toBe("a1000002-0000-4000-8000-000000000002");
  });

  it("deep-equals representative nested fields across the recursive DTO mapping", async () => {
    const bytes = await readGoldenBundle();
    const response = decodeBundle(bytes);
    const venue = response.venue!;

    expect(venue.manifest.rest).toEqual({
      created: "2026-01-01T00:00:00Z",
      extensions: [],
      generated_by: "imdf-map-viewer-fixture",
      language: "ja-JP",
      version: "1.0.0",
    });

    // Amenity: localized name/alt_name, Point geometry, accessibility
    // array, and the unit_ids array preserved verbatim in sourceProperties
    // (an unmodeled IMDF field, passed through rather than dropped).
    const amenity = venue.features.find((f) => f.id === "e1000001-0000-4000-8000-0000000000a1")!;
    expect(amenity.labels).toEqual({ "ja-JP": "トイレ", en: "Restroom" });
    expect(amenity.altLabels).toEqual({ "ja-JP": "お手洗い", en: "WC" });
    expect(amenity.geometry).toEqual({ type: "Point", coordinates: [139.7674, 35.6811] });
    expect(amenity.category).toBe("toilet");
    expect(amenity.accessibility).toEqual(["wheelchair"]);
    expect(amenity.sourceProperties.unit_ids).toEqual(["c1000011-0000-4000-8000-00000000011f"]);

    // Restricted unit: restriction, display_point-derived center, and full
    // Polygon geometry round-trip.
    const restrictedUnit = venue.features.find((f) => f.id === "c1000003-0000-4000-8000-0000000000b3")!;
    expect(restrictedUnit.restriction).toBe("employeesonly");
    expect(restrictedUnit.center).toEqual([139.76765, 35.68055]);
    expect(restrictedUnit.geometry).toEqual({
      type: "Polygon",
      coordinates: [
        [
          [139.7672, 35.6802],
          [139.7678, 35.6802],
          [139.7678, 35.6806],
          [139.7672, 35.6806],
          [139.7672, 35.6802],
        ],
      ],
    });
  });

  it("represents boundsByLevel as [levelId, bounds][] tuples", async () => {
    const bytes = await readGoldenBundle();
    const response = decodeBundle(bytes);
    expect(Array.isArray(response.venue!.boundsByLevel)).toBe(true);
    for (const entry of response.venue!.boundsByLevel) {
      expect(entry).toHaveLength(2);
      const [levelId, bounds] = entry;
      expect(typeof levelId).toBe("string");
      expect(bounds).toHaveLength(4);
      for (const n of bounds) {
        expect(typeof n).toBe("number");
      }
    }
  });

  it("returns plain objects (not Maps) for labels and source properties", async () => {
    const bytes = await readGoldenBundle();
    const response = decodeBundle(bytes);
    const feature = response.venue!.features[0]!;
    expect(feature.sourceProperties).not.toBeInstanceOf(Map);
    expect(feature.labels).not.toBeInstanceOf(Map);
  });

  it.each([
    ["invalid_bundle", (b: Uint8Array) => (b[0] = (b[0] ?? 0) ^ 0xff)],
    [
      "unsupported_bundle_version",
      (b: Uint8Array) => {
        b[4] = 2;
        b[5] = 0;
      },
    ],
    ["bundle_integrity_failed", (b: Uint8Array) => (b[20] = (b[20] ?? 0) ^ 0xff)],
    [
      "bundle_too_large",
      (b: Uint8Array) => {
        const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
        view.setBigUint64(12, 512n * 1024n * 1024n + 1n, true);
      },
    ],
  ] as const)("returns the stable %s error code for crafted corruption", async (code, mutate) => {
    const bytes = corrupt(await readGoldenBundle(), mutate);
    const response = decodeBundle(bytes);
    expect(response.ok).toBe(false);
    expect(response.venue).toBeNull();
    expect(response.error?.code).toBe(code);
  });

  it("never throws for domain failures", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(() => decodeBundle(bytes)).not.toThrow();
  });
});

describe("initKirikoWasm", () => {
  it("is idempotent across repeated calls", async () => {
    await initKirikoWasm();
    await initKirikoWasm();
    const bytes = await readGoldenBundle();
    expect(decodeBundle(bytes).ok).toBe(true);
  });
});

describe("levelElevations", () => {
  it("answers legacyUnknown for every level of the real pre-§8 bundle", async () => {
    const bytes = await readLegacyBundle();
    const elevations = levelElevations(bytes);

    expect(elevations).toHaveLength(3);
    for (const elevation of elevations) {
      expect(elevation.state).toBe("legacyUnknown");
      expect(elevation.resolvedSceneZMm).toBeNull();
      expect(elevation.method).toBeNull();
    }
    // The three canonical levels, in ordinal-descending order.
    expect(elevations.map((e) => e.ordinal)).toEqual([1, 0, -1]);
  });

  it("answers resolved for the §8-backed golden bundle", async () => {
    const bytes = await readGoldenBundle();
    const elevations = levelElevations(bytes);

    expect(elevations).toHaveLength(3);
    expect(elevations.every((e) => e.state === "resolved")).toBe(true);
    const lowest = elevations.find((e) => e.ordinal === -1)!;
    expect(lowest.state).toBe("resolved");
    expect(lowest.resolvedSceneZMm).toBe(0);
    expect(lowest.method).toBe("nominal_spacing");
  });
});

describe("sceneProjection", () => {
  it("projects the Generated source of the §9 golden bundle", async () => {
    const bytes = await readGoldenBundle();
    const projection = sceneProjection(bytes);

    expect(projection.identity.kind).toBe("generated");
    expect(projection.capability).toEqual({ state: "ready" });
    expect(projection.frame).not.toBeNull();
    expect(projection.frame!.unit).toBe("millimetre");
    expect(projection.levels).toHaveLength(3);
    for (const level of projection.levels) {
      expect(level.boundsMm).not.toBeNull();
    }
    expect(projection.primitives.length).toBeGreaterThan(0);
    expect(projection.primitives.some((p) => p.role === "surface")).toBe(true);
    expect(projection.primitives.some((p) => p.role === "wall")).toBe(true);
    // Bilingual copy is renderable from the typed states, never prose.
    expect(typeof projection.identity.provenance).toBe("string");
  });

  it("reports absent for a legacy bundle without a scene", async () => {
    const bytes = await readLegacyBundle();
    const projection = sceneProjection(bytes);
    expect(projection.capability).toEqual({ state: "absent" });
    expect(projection.primitives).toEqual([]);
    expect(projection.levels).toEqual([]);
  });
});
