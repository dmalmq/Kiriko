import type { ReactElement } from "react";
import type { LocaleCode } from "../imdf/types";
import type { NetworkConnectionId, ParsedNetwork } from "../map/networkFeatures";
import { linkEndsOnFloor, verticalLinks } from "../map/scene/verticalLinks";
import { verticalLinkLabelText } from "../map/verticalLinkLabels";
import { FloatingPanel } from "./FloatingPanel";

export interface CrossFloorConnectionsPanelProps {
  network: ParsedNetwork | null;
  activeOrdinal: number;
  selected: NetworkConnectionId | null;
  locale: LocaleCode;
  onSelect: (connectionId: NetworkConnectionId | null) => void;
  onClose: () => void;
}

const ui = {
  title: { ja: "接続フロア", en: "Cross-floor connections" },
  close: { ja: "閉じる", en: "Close" },
  noNetwork: { ja: "ネットワーク未読み込み", en: "No network loaded" },
  noLinks: { ja: "グラフに階をまたぐ接続はありません", en: "The graph links no floors" },
  noLinksOnFloor: { ja: "このフロアに接続はありません", en: "No connections on this floor" },
  unnamed: { ja: "名称なしの接続", en: "Unnamed connection" },
} as const;

/** Localized transport names for the categories the graph may state. */
const TRANSPORT_LABELS: Record<string, Record<LocaleCode, string>> = {
  elevator: { ja: "エレベーター", en: "Elevator" },
  escalator: { ja: "エスカレーター", en: "Escalator" },
  stairs: { ja: "階段", en: "Stairs" },
  steps: { ja: "階段", en: "Stairs" },
  ramp: { ja: "スロープ", en: "Ramp" },
  movingwalkway: { ja: "動く歩道", en: "Moving walkway" },
};

/**
 * Transport a row names. A null kind renders as an unnamed connection — the
 * graph said nothing, so nothing is invented. A category with no known label
 * surfaces verbatim: the graph stated it, the reviewer should see it.
 */
function transportLabel(kind: string | null, locale: LocaleCode): string {
  if (kind === null) {
    return ui.unnamed[locale];
  }
  return TRANSPORT_LABELS[kind]?.[locale] ?? kind;
}

function sameConnection(
  a: NetworkConnectionId | null,
  b: NetworkConnectionId,
): boolean {
  return a !== null && a.pathId === b.pathId && a.reversePathId === b.reversePathId;
}

/**
 * QA list of the venue's cross-floor connections touching the active floor,
 * opened from the 接続フロア chip in network review. Each row names the
 * transport the graph states and the floor it reaches, using the same
 * `↑ F2` token vocabulary as the map's vertical-link markers. Clicking a row
 * selects the connection; clicking the selected row clears it. Absence reads
 * as absence: a missing network, a graph with no cross-floor links, and a
 * floor the graph simply does not link are three distinct messages.
 */
export function CrossFloorConnectionsPanel({
  network,
  activeOrdinal,
  selected,
  locale,
  onSelect,
  onClose,
}: CrossFloorConnectionsPanelProps): ReactElement {
  const links = verticalLinks(network);
  const rows = links.flatMap((link) => {
    const ends = linkEndsOnFloor(link, activeOrdinal);
    return ends === null ? [] : [{ link, near: ends.near, far: ends.far }];
  });

  let body: ReactElement;
  if (network === null) {
    body = <p className="cross-floor-link-empty">{ui.noNetwork[locale]}</p>;
  } else if (links.length === 0) {
    body = <p className="cross-floor-link-empty">{ui.noLinks[locale]}</p>;
  } else if (rows.length === 0) {
    body = <p className="cross-floor-link-empty">{ui.noLinksOnFloor[locale]}</p>;
  } else {
    body = (
      <ul className="cross-floor-links">
        {rows.map(({ link, near, far }) => {
          const arrow: "up" | "down" = far.ordinal > near.ordinal ? "up" : "down";
          const isSelected = sameConnection(selected, link.connectionId);
          return (
            <li key={`${link.connectionId.pathId}:${link.connectionId.reversePathId}`}>
              <button
                type="button"
                className={
                  isSelected
                    ? "cross-floor-link cross-floor-link--selected"
                    : "cross-floor-link"
                }
                aria-pressed={isSelected}
                onClick={() => onSelect(isSelected ? null : link.connectionId)}
              >
                <span className="cross-floor-link__kind">
                  {transportLabel(link.kind, locale)}
                </span>
                <span className="cross-floor-link__target">
                  {verticalLinkLabelText(arrow, far.floor)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <FloatingPanel
      title={ui.title[locale]}
      closeLabel={ui.close[locale]}
      onClose={onClose}
      className="floating-panel--left floating-panel--connections"
    >
      {body}
    </FloatingPanel>
  );
}
