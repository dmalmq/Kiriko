/**
 * Shared tile-package fixtures (#71, #72).
 *
 * Both the ingestion suite and the storage suite need genuine content: ingestion
 * validates decode support by decoding, so a stub GLB would be refused for the
 * wrong reason, and collection tests need real member hashes.
 */
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
