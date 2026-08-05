import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectBundle } from "@kiriko/node";
import initWasm, { decodeBundle, levelElevations } from "@kiriko/wasm";
import { beforeAll, describe, expect, it } from "vitest";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../tests/fixtures");

async function readFixture(name: string): Promise<Uint8Array> {
  const bytes = await readFile(join(FIXTURES_DIR, name));
  return new Uint8Array(bytes);
}

/** The elevation projection the wasm binding serializes (mirrors
 *  `LevelElevationDto` in `src/bundle/wasm.ts`). */
interface LevelElevationDto {
  levelId: string;
  ordinal: number;
  state: "resolved" | "legacyUnknown";
  resolvedSceneZMm: number | null;
  method: string | null;
}

/** Capability report shape both adapters serialize (from #37/#38). */
interface CapabilityReport {
  graph: unknown;
  facilities: unknown;
  spatialContext: unknown;
  sceneSources: unknown;
  canonicalGraph: unknown;
  networkQa: unknown;
}

async function nativeCapabilities(bytes: Uint8Array): Promise<CapabilityReport> {
  const response = await inspectBundle(Buffer.from(bytes));
  if (!response.ok) {
    throw new Error(`native inspect failed: ${response.errorJson}`);
  }
  const inspection = JSON.parse(response.inspectionJson ?? "null") as {
    capabilities: CapabilityReport;
  };
  return inspection.capabilities;
}

function wasmCapabilities(bytes: Uint8Array): CapabilityReport {
  const response = decodeBundle(bytes);
  if (!response.ok) {
    throw new Error(`wasm decode failed: ${response.error?.message}`);
  }
  if (!response.capabilities) {
    throw new Error("wasm decode carried no capability report");
  }
  return response.capabilities;
}

beforeAll(async () => {
  // Node has no fetch for the generated glue's default URL resolution; pass
  // the wasm bytes explicitly (the same approach `src/bundle/wasm.ts` uses).
  const require = createRequire(import.meta.url);
  // The generated main (`kiriko_wasm.js`) sits next to the `.wasm` asset.
  const wasmPath = join(dirname(require.resolve("@kiriko/wasm")), "kiriko_wasm_bg.wasm");
  const bytes = await readFile(wasmPath);
  await initWasm({ module_or_path: bytes });
});

describe("cross-adapter Stage 0 parity (frozen bytes)", () => {
  // One representative bundle per capability outcome, all committed fixtures:
  // the native addon and the browser module must agree on every one.
  const outcomes: Array<[string, string, Partial<Record<string, unknown>>]> = [
    [
      "stage0.kvb",
      "available",
      { spatialContext: { state: "available" }, graph: { state: "available" } },
    ],
    [
      "legacy-minimal.kvb",
      "absent",
      { spatialContext: { state: "absent" }, graph: { state: "absent" } },
    ],
    [
      "stage0-unsupported.kvb",
      "unsupportedVersion",
      { spatialContext: { state: "unsupportedVersion", declared: 2, supported: 1 } },
    ],
    [
      "stage0-invalid.kvb",
      "invalid",
      { spatialContext: { state: "invalid", reason: expect.any(String) as unknown as string } },
    ],
    [
      "stage0-disabled.kvb",
      "disabledByDependency",
      {
        spatialContext: { state: "unsupportedVersion", declared: 2, supported: 1 },
        sceneSources: { state: "disabledByDependency", requires: 8 },
      },
    ],
  ];

  for (const [fixture, outcome, expected] of outcomes) {
    it(`reports identical ${outcome} capabilities for ${fixture}`, async () => {
      const bytes = await readFixture(fixture);
      const native = await nativeCapabilities(bytes);
      const wasm = wasmCapabilities(bytes);

      // The outcome-relevant fields match the frozen expectation…
      expect(native, `native ${fixture}`).toEqual(expect.objectContaining(expected));
      expect(wasm, `wasm ${fixture}`).toEqual(expect.objectContaining(expected));
      // …and the two adapters agree on every field of the same bytes.
      expect(native).toEqual(wasm);
    });
  }

  it("exposes equivalent typed projections for the §8 bundle", async () => {
    const bytes = await readFixture("stage0.kvb");
    const native = await nativeCapabilities(bytes);
    const elevations = levelElevations(bytes) as LevelElevationDto[];

    expect(native.spatialContext).toEqual({ state: "available" });
    expect(elevations).toHaveLength(3);
    expect(elevations.every((e) => e.state === "resolved")).toBe(true);
    // The native projection's level set and the wasm projection's level set
    // describe the same three canonical levels.
    const inspection = JSON.parse(
      (await inspectBundle(Buffer.from(bytes))).inspectionJson ?? "null",
    ) as { levelIds: string[] };
    expect(elevations.map((e) => e.levelId).sort()).toEqual([...inspection.levelIds].sort());
  });
});
