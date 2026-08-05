/**
 * Subset of IMDF 1.0 consumed by the viewer, plus the normalized
 * viewer model produced by `normalizeVenue`.
 */

export type LocaleCode = "ja" | "en";

export type FeatureType =
  | "address"
  | "amenity"
  | "anchor"
  | "building"
  | "detail"
  | "fixture"
  | "footprint"
  | "geofence"
  | "kiosk"
  | "level"
  | "occupant"
  | "opening"
  | "relationship"
  | "section"
  | "unit"
  | "venue";

export type BoundsTuple = [west: number, south: number, east: number, north: number];

export type ViewerWarningCode =
  | "missing_locale"
  | "unresolved_reference"
  | "missing_level_geometry"
  | "missing_display_point"
  | "unknown_archive_entry"
  | "route_build"
  | "facility_build"
  | "floor_override";

export interface ImdfManifest {
  version: "1.0.0";
  language: string;
  [key: string]: unknown;
}

export interface ParsedImdfArchive {
  manifest: ImdfManifest;
  collections: Partial<Record<FeatureType, GeoJSON.FeatureCollection>>;
}

export interface ViewerLevel {
  id: string;
  ordinal: number;
  label: Record<string, string>;
  shortName: Record<string, string>;
}

export interface ViewerFeature {
  id: string;
  featureType: FeatureType;
  levelId: string | null;
  geometry: GeoJSON.Geometry | null;
  center: [number, number] | null;
  labels: Record<string, string>;
  altLabels: Record<string, string>;
  category: string | null;
  accessibility: string[];
  restriction: string | null;
  /** Complete original `properties` object, not only unknown keys. */
  sourceProperties: Record<string, unknown>;
}

export interface SearchEntry {
  featureId: string;
  featureType: FeatureType;
  levelId: string | null;
  category: string | null;
  labels: Record<string, string>;
  altLabels: Record<string, string>;
  normalizedLabels: string[];
  normalizedAltLabels: string[];
  normalizedCategory: string;
}

export interface SearchResult {
  featureId: string;
  featureType: FeatureType;
  levelId: string | null;
  label: string;
  score: number;
}

export interface ViewerWarning {
  code: ViewerWarningCode;
  message: string;
  featureId?: string;
  archiveEntry?: string;
}

export interface LoadedVenue {
  manifest: ImdfManifest;
  venue: ViewerFeature;
  levels: ViewerLevel[];
  featuresById: Map<string, ViewerFeature>;
  renderFeaturesByLevel: Map<string, GeoJSON.FeatureCollection>;
  searchEntries: SearchEntry[];
  boundsByLevel: Map<string, BoundsTuple>;
  warnings: ViewerWarning[];
}
