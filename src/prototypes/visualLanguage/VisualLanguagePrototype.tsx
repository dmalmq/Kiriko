import { useId, useState } from "react";
import { VisualLanguageScene } from "./VisualLanguageScene";
import { VisualLanguageToolbar } from "./VisualLanguageToolbar";
import {
  type VisualLanguagePrototypeState,
  useVisualLanguagePrototype,
} from "./useVisualLanguagePrototype";
import { VISUAL_LANGUAGE_FIXTURE } from "./visualLanguageFixtures";
import {
  COPY,
  type HandoffPhaseId,
  type LocalizedText,
  type PrototypeLocale,
  type SceneSourceKind,
} from "./visualLanguage";
import "./visualLanguage.css";

const SELECTABLE_OBJECTS = [
  ["escalator-b1-1f", "selectedEscalator"],
  ["elevator-b1-1f", "elevator"],
  ["stairs-b1-1f", "stairs"],
  ["ramp-b1", "ramp"],
  ["opening-b1-west", "opening"],
] as const satisfies readonly (readonly [string, keyof typeof COPY])[];

const FIDELITY_DISCLOSURE = {
  en: "Same semantic style. Different source geometry and provenance.",
  ja: "同じセマンティックスタイルで、ソース形状と来歴のみが異なります。",
} as const satisfies LocalizedText;

const SHELL_COPY = {
  scenes: { en: "Source viewports", ja: "ソースビューポート" },
  guidedTransition: { en: "Guided transition", ja: "案内中の移動" },
  destination: { en: "Destination", ja: "目的地" },
  selectableObjects: { en: "Selectable objects", ja: "選択できるオブジェクト" },
  selectObject: { en: "Select object", ja: "オブジェクトを選択" },
  selectFinding: { en: "Select finding", ja: "指摘を選択" },
  noSelection: { en: "none", ja: "なし" },
} as const satisfies Readonly<Record<string, LocalizedText>>;

type InspectorFieldId =
  | "sourceLayout"
  | "sourceKind"
  | "scenario"
  | "handoffPhase"
  | "activeFloor"
  | "playback"
  | "fallbackPhase"
  | "selectedId"
  | "diagnosticFilter"
  | "locale"
  | "reducedMotion";

const INSPECTOR_FIELDS = [
  ["sourceLayout", { en: "Source layout", ja: "ソースレイアウト" }],
  ["sourceKind", { en: "Source kind", ja: "ソース種別" }],
  ["scenario", { en: "Scenario", ja: "シナリオ" }],
  ["handoffPhase", { en: "Handoff phase", ja: "フロア移動フェーズ" }],
  ["activeFloor", { en: "Active floor", ja: "表示中のフロア" }],
  ["playback", { en: "Playback", ja: "再生状態" }],
  ["fallbackPhase", { en: "Fallback phase", ja: "フォールバックフェーズ" }],
  ["selectedId", { en: "Selected ID", ja: "選択 ID" }],
  ["diagnosticFilter", { en: "Diagnostic filter", ja: "診断フィルター" }],
  ["locale", { en: "Language", ja: "言語" }],
  ["reducedMotion", { en: "Reduced motion", ja: "視差効果を減らす" }],
] as const satisfies readonly (readonly [InspectorFieldId, LocalizedText])[];

function inspectorValue(
  field: InspectorFieldId,
  state: VisualLanguagePrototypeState,
  handoffPhase: HandoffPhaseId,
): string {
  switch (field) {
    case "sourceLayout":
      return state.sourceLayout;
    case "sourceKind":
      return state.sourceKind;
    case "scenario":
      return state.scenario;
    case "handoffPhase":
      return handoffPhase;
    case "activeFloor":
      return state.activeFloor;
    case "playback":
      return state.playback;
    case "fallbackPhase":
      return state.fallbackPhase;
    case "selectedId":
      return state.selectedId ?? SHELL_COPY.noSelection[state.locale];
    case "diagnosticFilter":
      return state.diagnosticFilter;
    case "locale":
      return state.locale;
    case "reducedMotion":
      return String(state.reducedMotion);
    default: {
      const neverField: never = field;
      return neverField;
    }
  }
}

function canonicalSelectionId(sourceKind: SceneSourceKind, id: string): string {
  const primitive = VISUAL_LANGUAGE_FIXTURE.sources[sourceKind].primitives.find(
    (candidate) => candidate.id === id,
  );
  return primitive?.canonicalId ?? id;
}

function sceneLayoutClass(sourceCount: number): string {
  return sourceCount === 2
    ? "vl-prototype__viewports vl-prototype__viewports--compare"
    : "vl-prototype__viewports vl-prototype__viewports--single";
}

export function VisualLanguagePrototype() {
  const { state, actions, currentPhase, liveMessage } = useVisualLanguagePrototype();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const inspectorId = useId();
  const locale: PrototypeLocale = state.locale;
  const visibleSources: readonly SceneSourceKind[] =
    state.sourceLayout === "compare"
      ? ["detailed", "generated"]
      : [state.sourceKind];
  const showGuidanceCard = state.scenario === "guidance" || state.scenario === "handoff";
  const visibleFindings = VISUAL_LANGUAGE_FIXTURE.diagnostics.filter(
    ({ severity }) =>
      severity === "defect" || severity === "review" || state.diagnosticFilter === "all",
  );

  return (
    <main className="vl-prototype" lang={locale}>
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {liveMessage}
      </div>

      <header className="vl-prototype__header">
        <p className="vl-prototype__eyebrow">{COPY.prototype[locale]}</p>
        <h1>{COPY.title[locale]}</h1>
      </header>

      <VisualLanguageToolbar state={state} actions={actions} />

      {state.fallbackNoticeVisible ? (
        <section className="vl-fallback-notice" role="status">
          <p>{COPY.fallbackNotice[locale]}</p>
          <button type="button" onClick={actions.retryDetailed}>
            {COPY.retryDetailed[locale]}
          </button>
        </section>
      ) : null}

      <section className="vl-prototype__scenes" aria-label={SHELL_COPY.scenes[locale]}>
        <div className={sceneLayoutClass(visibleSources.length)}>
          {visibleSources.map((sourceKind) => (
            <div className="vl-prototype__viewport" key={sourceKind}>
              <VisualLanguageScene
                fixture={VISUAL_LANGUAGE_FIXTURE}
                sourceKind={sourceKind}
                scenario={state.scenario}
                activeFloor={state.activeFloor}
                handoffPhase={currentPhase.id}
                locale={locale}
                selectedId={state.selectedId}
                diagnosticFilter={state.diagnosticFilter}
                sourceMaterialInspection={state.sourceMaterialInspection}
                reducedMotion={state.reducedMotion}
                onSelectObject={(id) => {
                  actions.selectObject(canonicalSelectionId(sourceKind, id));
                }}
              />
              {state.fallbackPhase === "veil" ? (
                <div
                  className="vl-fallback-veil"
                  data-source={sourceKind}
                  aria-hidden="true"
                />
              ) : null}
            </div>
          ))}

          {showGuidanceCard ? (
            <aside className="vl-guidance-card" aria-label={SHELL_COPY.guidedTransition[locale]}>
              <p className="vl-guidance-card__eyebrow">
                {SHELL_COPY.guidedTransition[locale]}
              </p>
              <h2>{COPY.nextAction[locale]}</h2>
              <dl className="vl-guidance-card__floors">
                <div>
                  <dt>{COPY.currentFloor[locale]}</dt>
                  <dd>{state.activeFloor}</dd>
                </div>
                <div>
                  <dt>{COPY.destinationFloor[locale]}</dt>
                  <dd>1F</dd>
                </div>
              </dl>
              <p className="vl-guidance-card__destination">
                <span>{SHELL_COPY.destination[locale]}</span>
                <strong>{COPY.destination[locale]}</strong>
              </p>
              <p className="vl-guidance-card__distance">{COPY.remainingDistance[locale]}</p>
            </aside>
          ) : null}
        </div>

        {state.sourceLayout === "compare" ? (
          <p className="vl-prototype__fidelity">{FIDELITY_DISCLOSURE[locale]}</p>
        ) : null}
      </section>

      {state.scenario === "selection" ? (
        <section
          className="vl-equivalent-controls"
          aria-labelledby="vl-selectable-objects-heading"
        >
          <h2 id="vl-selectable-objects-heading">{SHELL_COPY.selectableObjects[locale]}</h2>
          <ul className="vl-equivalent-controls__list">
            {SELECTABLE_OBJECTS.map(([id, copyKey]) => {
              const selected = state.selectedId === id;
              return (
                <li key={id}>
                  <button
                    type="button"
                    className={
                      selected
                        ? "vl-equivalent-controls__button vl-equivalent-controls__button--selected"
                        : "vl-equivalent-controls__button"
                    }
                    aria-pressed={selected}
                    aria-label={`${SHELL_COPY.selectObject[locale]}: ${COPY[copyKey][locale]}`}
                    onClick={() => {
                      actions.selectObject(id);
                    }}
                  >
                    {COPY[copyKey][locale]}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {state.scenario === "diagnostics" ? (
        <section
          className="vl-equivalent-controls vl-equivalent-controls--diagnostics"
          aria-labelledby="vl-diagnostic-findings-heading"
        >
          <h2 id="vl-diagnostic-findings-heading">{SHELL_COPY.diagnosticFindings[locale]}</h2>
          <ul className="vl-equivalent-controls__list">
            {visibleFindings.map((finding) => {
              const selected = state.selectedId === finding.id;
              return (
                <li key={finding.id}>
                  <button
                    type="button"
                    className={
                      selected
                        ? "vl-equivalent-controls__button vl-equivalent-controls__button--selected"
                        : "vl-equivalent-controls__button"
                    }
                    aria-pressed={selected}
                    aria-label={`${SHELL_COPY.selectFinding[locale]}: ${COPY[finding.severity][locale]} — ${finding.summary[locale]}`}
                    onClick={() => {
                      actions.selectObject(finding.id);
                    }}
                  >
                    <span className={`vl-finding-severity vl-finding-severity--${finding.severity}`}>
                      {COPY[finding.severity][locale]}
                    </span>
                    <span>{finding.summary[locale]}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <aside className="vl-inspector">
        <button
          type="button"
          className="vl-inspector__toggle"
          aria-expanded={inspectorOpen}
          aria-controls={inspectorId}
          onClick={() => {
            setInspectorOpen((open) => !open);
          }}
        >
          {inspectorOpen ? COPY.hideInspector[locale] : COPY.showInspector[locale]}
        </button>
        {inspectorOpen ? (
          <section id={inspectorId} aria-labelledby={`${inspectorId}-heading`}>
            <h2 id={`${inspectorId}-heading`}>{COPY.inspector[locale]}</h2>
            <dl className="vl-inspector__values">
              {INSPECTOR_FIELDS.map(([field, label]) => (
                <div className="vl-inspector__row" key={field}>
                  <dt>{label[locale]}</dt>
                  <dd className="vl-inspector__value">
                    {inspectorValue(field, state, currentPhase.id)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ) : null}
      </aside>
    </main>
  );
}
