/**
 * Client mirror of the server GDB import API contract
 * (`server/src/gdb/types.ts`). Kept in sync by hand, exactly as
 * `src/gallery/api.ts` mirrors the venue/version response shapes.
 */
export type GdbGeometryFamily = "point" | "line" | "polygon" | "mixed" | "none";

export type GdbTargetType =
  | "level" | "unit" | "opening" | "detail" | "fixture" | "kiosk" | "amenity" | "occupant";

export interface GdbLayerKey {
  databaseId: string;
  layerName: string;
}

export function gdbLayerKeyString(key: GdbLayerKey): string {
  return `${key.databaseId}\u0000${key.layerName}`;
}

export interface GdbFieldDescriptor {
  name: string;
  type: string;
}

export interface GdbLayerDescriptor {
  key: GdbLayerKey;
  databaseName: string;
  featureCount: number;
  geometryFamily: GdbGeometryFamily;
  fields: GdbFieldDescriptor[];
}

export interface GdbInspection {
  sourceName: string;
  databases: Array<{ id: string; name: string }>;
  layers: GdbLayerDescriptor[];
  warnings: string[];
}

export interface GdbBuildingPlan {
  id: string;
  name: string;
}

export type GdbLevelRule =
  | { kind: "source-reference"; field: string }
  | { kind: "property"; field: string }
  | { kind: "layer-name" }
  | { kind: "fixed"; label: string; ordinal: number };

export interface GdbLayerPlan {
  key: GdbLayerKey;
  included: boolean;
  targetType: GdbTargetType | null;
  buildingId: string | null;
  levelRule: GdbLevelRule | null;
  idField: string | null;
  ordinalField: string | null;
  shortNameField: string | null;
  nameField: string | null;
  categoryField: string | null;
}

export interface GdbMappingPlan {
  venueName: string;
  buildings: GdbBuildingPlan[];
  layers: GdbLayerPlan[];
  /**
   * Drop routing nodes and facilities outside the selected buildings'
   * geometry. Lives on the plan rather than the publish request so it is
   * persisted in `versions.gdb_plan_json` and survives re-edit, augment, and
   * generate-network with no migration.
   */
  clipToSelection?: boolean;
}

export interface GdbInspectResponse {
  blobHash: string;
  inspection: GdbInspection;
  suggestedPlan: GdbMappingPlan;
}

/**
 * Mirror of the server `NetworkInspectResponse` (`POST /api/gdb/inspect-network`):
 * summary of the extracted routing network plus the staged blob hash a publish
 * request may echo back as `networkBlobHash`.
 */
export interface NetworkInspectResponse {
  networkBlobHash: string;
  nodeCount: number;
  edgeCount: number;
  floors: string[];
}

/**
 * Mirror of the server `FacilitiesInspectResponse`
 * (`POST /api/gdb/inspect-facilities`): summary of the extracted facility
 * points plus the staged blob hash a publish request may echo back as
 * `facilitiesBlobHash`.
 */
export interface FacilitiesInspectResponse {
  facilitiesBlobHash: string;
  facilityCount: number;
  floors: string[];
}
