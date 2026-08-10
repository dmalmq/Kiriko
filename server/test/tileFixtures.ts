/**
 * Shared tile-package fixtures (#71, #72).
 *
 * Both the ingestion suite and the storage suite need genuine content: ingestion
 * validates decode support by decoding, so a stub GLB would be refused for the
 * wrong reason, and collection tests need real member hashes.
 */

/** One source element in a registration fixture: its Revit metadata and its triangles. */
export interface TileFeatureSpec {
  revitUniqueId: string;
  category: string;
  levelKey: string;
  levelName: string;
  levelElevationMeters: number;
  sourceDocument: string;
  sourceLinkName: string;
  /** Triangles in the GLB's own glTF Y-up coordinates. */
  triangles: [number, number, number][][];
}

/**
 * A GLB whose `EXT_structural_metadata` property table carries every field
 * registration reads, with one primitive per feature.
 *
 * `minZMeters`/`maxZMeters` are derived from each feature's own triangles
 * rather than declared, so a fixture cannot claim an extent its geometry does
 * not have — the same rule the Rust fixture builder follows.
 */
export function glbWithFeatures(features: TileFeatureSpec[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array): number => {
    const at = offset;
    chunks.push(bytes);
    offset += bytes.byteLength;
    return at;
  };

  const accessors: Record<string, unknown>[] = [];
  const bufferViews: Record<string, unknown>[] = [];
  const primitives: Record<string, unknown>[] = [];

  features.forEach((feature, index) => {
    const positions = feature.triangles.flat().flat();
    const vertexCount = positions.length / 3;
    if (vertexCount === 0) {
      throw new Error("a fixture feature needs geometry");
    }
    const positionsAt = push(new Uint8Array(Float32Array.from(positions).buffer));
    const idsAt = push(
      new Uint8Array(Uint32Array.from(Array.from({ length: vertexCount }, () => index)).buffer),
    );

    const positionView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: positionsAt, byteLength: vertexCount * 12 });
    const idView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: idsAt, byteLength: vertexCount * 4 });

    const positionAccessor = accessors.length;
    accessors.push({
      bufferView: positionView,
      componentType: 5126,
      count: vertexCount,
      type: "VEC3",
    });
    const idAccessor = accessors.length;
    accessors.push({
      bufferView: idView,
      componentType: 5125,
      count: vertexCount,
      type: "SCALAR",
      min: [index],
      max: [index],
    });

    primitives.push({
      mode: 4,
      attributes: { POSITION: positionAccessor, _FEATURE_ID_0: idAccessor },
      extensions: {
        EXT_mesh_features: {
          featureIds: [{ featureCount: features.length, attribute: 0, propertyTable: 0 }],
        },
      },
    });
  });

  const encoder = new TextEncoder();
  const properties: Record<string, unknown> = {};
  const stringFields: [string, string[]][] = [
    ["revitUniqueId", features.map((f) => f.revitUniqueId)],
    ["category", features.map((f) => f.category)],
    ["levelKey", features.map((f) => f.levelKey)],
    ["levelName", features.map((f) => f.levelName)],
    ["sourceDocument", features.map((f) => f.sourceDocument)],
    ["sourceLinkName", features.map((f) => f.sourceLinkName)],
  ];
  for (const [name, values] of stringFields) {
    const bytes = encoder.encode(values.join(""));
    const valuesAt = push(bytes);
    const offsets: number[] = [0];
    let end = 0;
    for (const value of values) {
      end += encoder.encode(value).byteLength;
      offsets.push(end);
    }
    const offsetsAt = push(new Uint8Array(Uint32Array.from(offsets).buffer));
    const valuesView = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset: valuesAt,
      byteLength: Math.max(bytes.byteLength, 1),
    });
    const offsetsView = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: offsetsAt, byteLength: offsets.length * 4 });
    properties[name] = { values: valuesView, stringOffsets: offsetsView };
  }

  const heights = features.map((feature) => feature.triangles.flat().map((vertex) => vertex[2]));
  const scalarFields: [string, number[]][] = [
    ["levelElevationMeters", features.map((f) => f.levelElevationMeters)],
    ["minZMeters", heights.map((values) => Math.min(...values))],
    ["maxZMeters", heights.map((values) => Math.max(...values))],
  ];
  for (const [name, values] of scalarFields) {
    const at = push(new Uint8Array(Float32Array.from(values).buffer));
    const view = bufferViews.length;
    bufferViews.push({ buffer: 0, byteOffset: at, byteLength: values.length * 4 });
    properties[name] = { values: view };
  }

  while (offset % 4 !== 0) {
    push(new Uint8Array(1));
  }
  const bin = new Uint8Array(offset);
  let cursor = 0;
  for (const chunk of chunks) {
    bin.set(chunk, cursor);
    cursor += chunk.byteLength;
  }

  const gltf = {
    asset: { version: "2.0" },
    extensionsUsed: ["EXT_mesh_features", "EXT_structural_metadata"],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives }],
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.byteLength }],
    extensions: {
      EXT_structural_metadata: {
        schema: {
          classes: {
            element: {
              properties: {
                revitUniqueId: { type: "STRING" },
                category: { type: "STRING" },
                levelKey: { type: "STRING" },
                levelName: { type: "STRING" },
                sourceDocument: { type: "STRING" },
                sourceLinkName: { type: "STRING" },
                levelElevationMeters: { type: "SCALAR", componentType: "FLOAT32" },
                minZMeters: { type: "SCALAR", componentType: "FLOAT32" },
                maxZMeters: { type: "SCALAR", componentType: "FLOAT32" },
              },
            },
          },
        },
        propertyTables: [{ class: "element", count: features.length, properties }],
      },
    },
  };

  return glbContainer(gltf, bin);
}

/** Wrap glTF JSON and a BIN chunk in a GLB container. */
function glbContainer(gltf: unknown, bin: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPadding = (4 - (json.byteLength % 4)) % 4;
  const binPadding = (4 - (bin.byteLength % 4)) % 4;
  const total = 12 + 8 + json.byteLength + jsonPadding + 8 + bin.byteLength + binPadding;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  out.set(new TextEncoder().encode("glTF"), at);
  at += 4;
  view.setUint32(at, 2, true);
  at += 4;
  view.setUint32(at, total, true);
  at += 4;
  view.setUint32(at, json.byteLength + jsonPadding, true);
  at += 4;
  out.set(new TextEncoder().encode("JSON"), at);
  at += 4;
  out.set(json, at);
  at += json.byteLength;
  out.fill(0x20, at, at + jsonPadding);
  at += jsonPadding;
  view.setUint32(at, bin.byteLength + binPadding, true);
  at += 4;
  out.set(new TextEncoder().encode("BIN\0"), at);
  at += 4;
  out.set(bin, at);
  return out;
}

/**
 * A minimal but real GLB: one triangle carrying a constant `_FEATURE_ID_0`.
 *
 * The feature id is not decoration. Kiriko's tiles source resolves picking
 * against per-primitive source-object identity, so content without it cannot be
 * a source however well it renders — and ingestion validates decode support by
 * decoding, so a stub GLB would be refused for the wrong reason.
 */
export function glbFixture(marker: number): Uint8Array {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, marker]);
  const featureIds = new Uint32Array([7, 7, 7]);
  const bin = new Uint8Array(positions.byteLength + featureIds.byteLength);
  bin.set(new Uint8Array(positions.buffer.slice(0)), 0);
  bin.set(new Uint8Array(featureIds.buffer.slice(0)), positions.byteLength);

  const gltf = {
    asset: { version: "2.0" },
    extensionsUsed: ["EXT_mesh_features"],
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0, _FEATURE_ID_0: 1 },
            mode: 4,
            extensions: {
              EXT_mesh_features: { featureIds: [{ attribute: 0 }] },
            },
          },
        ],
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [1, 1, marker],
      },
      {
        bufferView: 1,
        componentType: 5125,
        count: 3,
        type: "SCALAR",
        min: [7],
        max: [7],
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: featureIds.byteLength },
    ],
    buffers: [{ byteLength: bin.byteLength }],
  };

  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonPadding = (4 - (json.byteLength % 4)) % 4;
  const binPadding = (4 - (bin.byteLength % 4)) % 4;
  const total = 12 + 8 + json.byteLength + jsonPadding + 8 + bin.byteLength + binPadding;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  out.set(new TextEncoder().encode("glTF"), offset);
  offset += 4;
  view.setUint32(offset, 2, true);
  offset += 4;
  view.setUint32(offset, total, true);
  offset += 4;
  view.setUint32(offset, json.byteLength + jsonPadding, true);
  offset += 4;
  out.set(new TextEncoder().encode("JSON"), offset);
  offset += 4;
  out.set(json, offset);
  offset += json.byteLength;
  out.fill(0x20, offset, offset + jsonPadding);
  offset += jsonPadding;
  view.setUint32(offset, bin.byteLength + binPadding, true);
  offset += 4;
  out.set(new TextEncoder().encode("BIN\0"), offset);
  offset += 4;
  out.set(bin, offset);
  return out;
}

export function tilesetFixture(contentUri: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      asset: { version: "1.1" },
      geometricError: 0,
      root: {
        boundingVolume: { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10] },
        geometricError: 0,
        refine: "ADD",
        content: { uri: contentUri },
      },
    }),
  );
}
