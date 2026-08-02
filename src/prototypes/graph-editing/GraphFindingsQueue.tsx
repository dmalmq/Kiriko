import { useEffect, useRef, useState, type ReactElement } from "react";
import type { GraphEditorPrototypeState, GraphFinding } from "./graphEditingModel";
import type { GraphEditorPrototypeActions } from "./useGraphEditingPrototype";

interface LocalizedText {
  ja: string;
  en: string;
}

export interface GraphFindingsQueueProps {
  state: GraphEditorPrototypeState;
  actions: GraphEditorPrototypeActions;
}

type FindingFilter = "open" | "all";

const findingCopy: Record<
  GraphFinding["id"],
  {
    title: LocalizedText;
    evidence: LocalizedText;
    floors: string;
  }
> = {
  "endpoint-off-stair": {
    title: { ja: "階段から外れた端点", en: "Endpoint off stair" },
    evidence: { ja: "ソース + 階段形状 · 信頼度 96%", en: "Source + stair footprint · 96% confidence" },
    floors: "B1 ↔ 1F",
  },
  "floor-drift": {
    title: { ja: "フロア割り当てのずれ", en: "Floor assignment drift" },
    evidence: { ja: "ソース標高 · 信頼度 84%", en: "Source altitude · 84% confidence" },
    floors: "B1 / 1F",
  },
  "unassociated-lift": {
    title: { ja: "未関連付けのエレベーター", en: "Unassociated lift" },
    evidence: { ja: "広域関連付けルール · 未評価", en: "Broad association rule · Not evaluated" },
    floors: "B1 ↔ 1F",
  },
};

const severityCopy = {
  defect: { ja: "欠陥", en: "Defect" },
  review: { ja: "レビュー", en: "Review" },
  advisory: { ja: "助言", en: "Advisory" },
} satisfies Record<GraphFinding["severity"], LocalizedText>;

const stateCopy = {
  open: { ja: "未解決", en: "Open" },
  resolved: { ja: "解決済み", en: "Resolved" },
  accepted: { ja: "例外を承認", en: "Exception accepted" },
  "not-evaluated": { ja: "未評価", en: "Not evaluated" },
} satisfies Record<GraphFinding["state"], LocalizedText>;

const copy = {
  title: { ja: "検出事項", en: "Findings" },
  subtitle: { ja: "優先度順の修復キュー", en: "Repair queue by priority" },
  open: { ja: "未解決", en: "Open" },
  all: { ja: "すべて", en: "All" },
  measured: { ja: "測定値", en: "Measured" },
  affectedFloors: { ja: "対象フロア", en: "Affected floors" },
  version: { ja: "バージョン状態", en: "Version status" },
  currentVersion: { ja: "公開版 v17", en: "Published v17" },
  stagedVersion: { ja: "ステージ済み変更", en: "Staged change" },
  noFindings: { ja: "このフィルターに検出事項はありません", en: "No findings in this filter" },
} satisfies Record<string, LocalizedText>;

function t(value: LocalizedText, locale: GraphEditorPrototypeState["locale"]): string {
  return value[locale];
}

function measurement(finding: GraphFinding, locale: GraphEditorPrototypeState["locale"]): string {
  if (finding.measuredM === null) return t(stateCopy["not-evaluated"], locale);
  const measured = `${finding.measuredM.toFixed(2)} m`;
  return finding.toleranceM === null
    ? measured
    : `${measured} / ${locale === "ja" ? "基準" : "limit"} ${finding.toleranceM.toFixed(2)} m`;
}

export function GraphFindingsQueue({ state, actions }: GraphFindingsQueueProps): ReactElement {
  const [filter, setFilter] = useState<FindingFilter>("open");
  const didInitializeSelection = useRef(false);
  const { locale } = state;

  useEffect(() => {
    if (didInitializeSelection.current) return;
    didInitializeSelection.current = true;
    if (state.selectedFindingId === null) actions.selectFinding("endpoint-off-stair");
  }, [actions, state.selectedFindingId]);

  const visibleFindings = state.findings.filter(
    (finding) => filter === "all" || finding.state === "open" || finding.state === "not-evaluated",
  );
  const severities = ["defect", "review", "advisory"] as const;

  return (
    <section className="graph-findings" aria-labelledby="graph-findings-title">
      <header className="graph-findings__header">
        <div>
          <p className="graph-findings__eyebrow">{t(copy.subtitle, locale)}</p>
          <h2 id="graph-findings-title">{t(copy.title, locale)}</h2>
        </div>
        <span className="graph-findings__count" aria-label={`${visibleFindings.length}`}>
          {visibleFindings.length}
        </span>
      </header>

      <div className="graph-findings__filters" role="group" aria-label={t(copy.title, locale)}>
        {(["open", "all"] as const).map((value) => (
          <button
            key={value}
            type="button"
            className="graph-findings__filter"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
          >
            {t(copy[value], locale)}
          </button>
        ))}
      </div>

      <div className="graph-findings__groups">
        {severities.map((severity) => {
          const findings = visibleFindings.filter((finding) => finding.severity === severity);
          if (findings.length === 0) return null;
          return (
            <section key={severity} className="graph-findings__group" data-severity={severity}>
              <header className="graph-findings__group-header">
                <h3>{t(severityCopy[severity], locale)}</h3>
                <span>{findings.length}</span>
              </header>
              <ol className="graph-findings__list">
                {findings.map((finding) => {
                  const baseline = state.baseline.findings.find((item) => item.id === finding.id);
                  const staged = baseline === undefined
                    || baseline.state !== finding.state
                    || baseline.exceptionReason !== finding.exceptionReason
                    || baseline.measuredM !== finding.measuredM
                    || baseline.toleranceM !== finding.toleranceM;
                  const selected = state.selectedFindingId === finding.id;
                  return (
                    <li key={finding.id}>
                      <button
                        type="button"
                        className="graph-finding-row"
                        aria-pressed={selected}
                        data-state={finding.state}
                        onClick={() => actions.selectFinding(finding.id)}
                      >
                        <span className="graph-finding-row__heading">
                          <span className="graph-finding-row__title">{t(findingCopy[finding.id].title, locale)}</span>
                          <span className="graph-finding-row__state">{t(stateCopy[finding.state], locale)}</span>
                        </span>
                        <span className="graph-finding-row__evidence">{t(findingCopy[finding.id].evidence, locale)}</span>
                        <span className="graph-finding-row__metadata">
                          <span>
                            <span className="graph-finding-row__label">{t(copy.affectedFloors, locale)}</span>
                            <span className="graph-finding-row__machine">{findingCopy[finding.id].floors}</span>
                          </span>
                          <span>
                            <span className="graph-finding-row__label">{t(copy.measured, locale)}</span>
                            <span className="graph-finding-row__machine">{measurement(finding, locale)}</span>
                          </span>
                          <span>
                            <span className="graph-finding-row__label">{t(copy.version, locale)}</span>
                            <span>{t(staged ? copy.stagedVersion : copy.currentVersion, locale)}</span>
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>
          );
        })}
        {visibleFindings.length === 0 ? <p className="graph-findings__empty">{t(copy.noFindings, locale)}</p> : null}
      </div>
    </section>
  );
}
