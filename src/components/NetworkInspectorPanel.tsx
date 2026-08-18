import type { ReactElement } from "react";
import type { LocaleCode } from "../imdf/types";
import type { NetworkConnectionId, NetworkFeature, ParsedNetwork } from "../map/networkFeatures";
import {
  selectedConnectionId,
  selectedJunctionId,
  type NetworkSelection,
} from "../map/networkEditor";
import { FloatingPanel } from "./FloatingPanel";

export interface NetworkInspectorPanelProps {
  network: ParsedNetwork;
  selection: Exclude<NetworkSelection, null>;
  locale: LocaleCode;
  locked: boolean;
  onClose: () => void;
  onMove: (nodeId: number) => void;
  onDelete: () => void;
}

const ui = {
  connectionTitle: { ja: "接続", en: "Connection" },
  close: { ja: "閉じる", en: "Close" },
  nodeId: { ja: "ノードID", en: "Node ID" },
  floor: { ja: "フロア", en: "Floor" },
  coordinates: { ja: "座標", en: "Coordinates" },
  connections: { ja: "接続数", en: "Connections" },
  endpoints: { ja: "端点", en: "Endpoints" },
  length: { ja: "距離", en: "Length" },
  cost: { ja: "コスト", en: "Cost" },
  move: { ja: "点を移動", en: "Move point" },
  delete: { ja: "削除", en: "Delete" },
  unknown: { ja: "不明", en: "Unknown" },
  selectedCount: { ja: "{n}件選択", en: "{n} selected" },
} as const;

const EARTH_RADIUS_M = 6_371_000;

/** Great-circle distance in metres between two lon/lat points (display only). */
function haversineM(a: readonly number[], b: readonly number[]): number {
  const toRad = Math.PI / 180;
  const dLat = ((b[1] ?? 0) - (a[1] ?? 0)) * toRad;
  const dLon = ((b[0] ?? 0) - (a[0] ?? 0)) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a[1] ?? 0) * toRad) * Math.cos((b[1] ?? 0) * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

function polylineLengthM(geometry: GeoJSON.Geometry): number {
  const lines =
    geometry.type === "LineString"
      ? [geometry.coordinates]
      : geometry.type === "MultiLineString"
        ? geometry.coordinates
        : [];
  let total = 0;
  for (const line of lines) {
    for (let i = 1; i < line.length; i += 1) {
      total += haversineM(line[i - 1]!, line[i]!);
    }
  }
  return total;
}

function connectionPath(network: ParsedNetwork, id: NetworkConnectionId): NetworkFeature | null {
  const lo = Math.min(id.pathId, id.reversePathId);
  const hi = Math.max(id.pathId, id.reversePathId);
  return (
    network.paths.find((p) => {
      const a = p.properties.PATHID;
      const b = p.properties.RPATHID;
      return (
        typeof a === "number" &&
        typeof b === "number" &&
        Math.min(a, b) === lo &&
        Math.max(a, b) === hi
      );
    }) ?? null
  );
}

function floorLabel(properties: Record<string, unknown>, locale: LocaleCode): string {
  return typeof properties.FLOOR === "string" ? properties.FLOOR : ui.unknown[locale];
}

function JunctionBody({
  network,
  nodeId,
  locale,
  locked,
  onMove,
  onDelete,
}: {
  network: ParsedNetwork;
  nodeId: number;
  locale: LocaleCode;
  locked: boolean;
  onMove: (nodeId: number) => void;
  onDelete: () => void;
}): ReactElement {
  const junction = network.junctions.find((j) => j.properties.NODEID === nodeId);
  const coords = junction?.geometry.type === "Point" ? junction.geometry.coordinates : null;
  const pathCount =
    junction !== undefined && typeof junction.properties.PATH_COUNT === "number"
      ? junction.properties.PATH_COUNT
      : 0;
  return (
    <div className="inspector">
      <dl className="inspector__table">
        <div className="inspector__row">
          <dt>{ui.nodeId[locale]}</dt>
          <dd>{nodeId}</dd>
        </div>
        <div className="inspector__row">
          <dt>{ui.floor[locale]}</dt>
          <dd>{junction !== undefined ? floorLabel(junction.properties, locale) : ui.unknown[locale]}</dd>
        </div>
        {coords !== null ? (
          <div className="inspector__row">
            <dt>{ui.coordinates[locale]}</dt>
            <dd>
              {coords[0]?.toFixed(6)}, {coords[1]?.toFixed(6)}
            </dd>
          </div>
        ) : null}
        <div className="inspector__row">
          <dt>{ui.connections[locale]}</dt>
          <dd>{pathCount}</dd>
        </div>
      </dl>
      <div className="inspector__footer">
        <button type="button" className="btn-ghost" disabled={locked} onClick={() => onMove(nodeId)}>
          {ui.move[locale]}
        </button>
        <button type="button" className="btn-destructive" disabled={locked} onClick={onDelete}>
          {ui.delete[locale]}
        </button>
      </div>
    </div>
  );
}

function MultiSelectBody({
  locale,
  locked,
  onDelete,
}: {
  locale: LocaleCode;
  locked: boolean;
  onDelete: () => void;
}): ReactElement {
  return (
    <div className="inspector">
      <div className="inspector__footer">
        <button type="button" className="btn-destructive" disabled={locked} onClick={onDelete}>
          {ui.delete[locale]}
        </button>
      </div>
    </div>
  );
}

function ConnectionBody({
  network,
  connectionId,
  locale,
  locked,
  onDelete,
}: {
  network: ParsedNetwork;
  connectionId: NetworkConnectionId;
  locale: LocaleCode;
  locked: boolean;
  onDelete: () => void;
}): ReactElement {
  const path = connectionPath(network, connectionId);
  const from = path?.properties.FNODEID;
  const to = path?.properties.TNODEID;
  const cost = path?.properties.cost;
  const lengthM = path !== null ? polylineLengthM(path.geometry) : null;
  return (
    <div className="inspector">
      <dl className="inspector__table">
        <div className="inspector__row">
          <dt>{ui.endpoints[locale]}</dt>
          <dd>
            {typeof from === "number" ? from : ui.unknown[locale]} →{" "}
            {typeof to === "number" ? to : ui.unknown[locale]}
          </dd>
        </div>
        <div className="inspector__row">
          <dt>{ui.floor[locale]}</dt>
          <dd>{path !== null ? floorLabel(path.properties, locale) : ui.unknown[locale]}</dd>
        </div>
        {lengthM !== null ? (
          <div className="inspector__row">
            <dt>{ui.length[locale]}</dt>
            <dd>{lengthM.toFixed(1)} m</dd>
          </div>
        ) : null}
        {typeof cost === "number" ? (
          <div className="inspector__row">
            <dt>{ui.cost[locale]}</dt>
            <dd>{cost}</dd>
          </div>
        ) : null}
      </dl>
      <div className="inspector__footer">
        <button type="button" className="btn-destructive" disabled={locked} onClick={onDelete}>
          {ui.delete[locale]}
        </button>
      </div>
    </div>
  );
}

/**
 * Read-only inspector for the selected junction or connection, hosted in the
 * standard floating inspector panel. Junctions expose Move + Delete; connections
 * expose Delete. No source-property editing in this geometry-first release.
 */
export function NetworkInspectorPanel({
  network,
  selection,
  locale,
  locked,
  onClose,
  onMove,
  onDelete,
}: NetworkInspectorPanelProps): ReactElement {
  const junctionId = selectedJunctionId(selection);
  const connectionId = selectedConnectionId(selection);
  const count = selection.junctionIds.length + selection.connectionIds.length;
  const title =
    junctionId !== null
      ? locale === "ja"
        ? `点 ${junctionId}`
        : `Point ${junctionId}`
      : connectionId !== null
        ? ui.connectionTitle[locale]
        : ui.selectedCount[locale].replace("{n}", String(count));
  return (
    <FloatingPanel
      title={title}
      closeLabel={ui.close[locale]}
      onClose={onClose}
      className="floating-panel--inspector"
    >
      {junctionId !== null ? (
        <JunctionBody
          network={network}
          nodeId={junctionId}
          locale={locale}
          locked={locked}
          onMove={onMove}
          onDelete={onDelete}
        />
      ) : connectionId !== null ? (
        <ConnectionBody
          network={network}
          connectionId={connectionId}
          locale={locale}
          locked={locked}
          onDelete={onDelete}
        />
      ) : (
        <MultiSelectBody locale={locale} locked={locked} onDelete={onDelete} />
      )}
    </FloatingPanel>
  );
}
