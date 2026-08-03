import { useId } from "react";
import type {
  VisualLanguagePrototypeActions,
  VisualLanguagePrototypeState,
} from "./useVisualLanguagePrototype";
import { COPY, type PrototypeLocale, type ScenarioId } from "./visualLanguage";

const SCENARIOS = [
  ["guidance", "guidance"],
  ["selection", "selection"],
  ["handoff", "handoff"],
  ["overview", "overview"],
  ["diagnostics", "diagnostics"],
  ["fallback", "fallback"],
] as const satisfies readonly (readonly [ScenarioId, keyof typeof COPY])[];

const SOURCES = [
  ["compare", "compare"],
  ["detailed", "detailed"],
  ["generated", "generated"],
  ["twoDimensional", "twoDimensional"],
] as const;

const LOCALES = [
  ["en", { en: "English", ja: "英語" }],
  ["ja", { en: "Japanese", ja: "日本語" }],
] as const satisfies readonly (readonly [
  PrototypeLocale,
  Readonly<Record<PrototypeLocale, string>>,
])[];

const TOOLBAR_COPY = {
  controls: { en: "Prototype controls", ja: "プロトタイプ操作" },
  playback: { en: "Floor handoff playback", ja: "フロア移動の再生" },
  findingFilter: { en: "Finding filter", ja: "指摘フィルター" },
  fallbackActions: { en: "Fallback actions", ja: "フォールバック操作" },
} as const satisfies Readonly<
  Record<string, Readonly<Record<PrototypeLocale, string>>>
>;

export interface VisualLanguageToolbarProps {
  readonly state: VisualLanguagePrototypeState;
  readonly actions: VisualLanguagePrototypeActions;
}

export function VisualLanguageToolbar({ state, actions }: VisualLanguageToolbarProps) {
  const reducedMotionId = useId();
  const sourceMaterialId = useId();
  const locale = state.locale;
  const showHandoffControls = state.scenario === "handoff";
  const showDiagnosticControls = state.scenario === "diagnostics";
  const showFallbackControls = state.scenario === "fallback";
  const fallbackAction =
    state.sourceKind === "generated"
      ? actions.retryDetailed
      : actions.simulateDetailedFailure;
  const fallbackLabel =
    state.sourceKind === "generated" ? COPY.retryDetailed : COPY.simulateFailure;

  const selectSource = (id: (typeof SOURCES)[number][0]): void => {
    if (id === "compare") {
      actions.setSourceLayout("compare");
      return;
    }
    actions.setSourceKind(id);
  };

  return (
    <section className="vl-toolbar" aria-label={TOOLBAR_COPY.controls[locale]}>
      <fieldset className="vl-toolbar__group">
        <legend>{COPY.scenario[locale]}</legend>
        <div className="vl-toolbar__buttons">
          {SCENARIOS.map(([id, copyKey]) => (
            <button
              key={id}
              type="button"
              className="vl-toolbar__button"
              aria-pressed={state.scenario === id}
              onClick={() => {
                actions.setScenario(id);
              }}
            >
              {COPY[copyKey][locale]}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="vl-toolbar__group">
        <legend>{COPY.sceneSource[locale]}</legend>
        <div className="vl-toolbar__buttons">
          {SOURCES.map(([id, copyKey]) => {
            const selected =
              id === "compare"
                ? state.sourceLayout === "compare"
                : state.sourceLayout === "single" && state.sourceKind === id;
            return (
              <button
                key={id}
                type="button"
                className="vl-toolbar__button"
                aria-pressed={selected}
                onClick={() => {
                  selectSource(id);
                }}
              >
                {COPY[copyKey][locale]}
              </button>
            );
          })}
        </div>
      </fieldset>

      {showHandoffControls ? (
        <fieldset className="vl-toolbar__group vl-toolbar__group--contextual">
          <legend>{TOOLBAR_COPY.playback[locale]}</legend>
          <div className="vl-toolbar__buttons">
            <button
              type="button"
              className="vl-toolbar__button"
              aria-pressed={state.playback === "playing"}
              onClick={
                state.playback === "playing" ? actions.pauseHandoff : actions.playHandoff
              }
            >
              {state.playback === "playing"
                ? COPY.pause[locale]
                : COPY.playHandoff[locale]}
            </button>
            <button
              type="button"
              className="vl-toolbar__button"
              onClick={actions.restartHandoff}
            >
              {COPY.restart[locale]}
            </button>
          </div>
        </fieldset>
      ) : null}

      {showDiagnosticControls ? (
        <fieldset className="vl-toolbar__group vl-toolbar__group--contextual">
          <legend>{TOOLBAR_COPY.findingFilter[locale]}</legend>
          <div className="vl-toolbar__buttons">
            <button
              type="button"
              className="vl-toolbar__button"
              aria-pressed={state.diagnosticFilter === "default"}
              onClick={() => {
                actions.setDiagnosticFilter("default");
              }}
            >
              {COPY.openFindings[locale]}
            </button>
            <button
              type="button"
              className="vl-toolbar__button"
              aria-pressed={state.diagnosticFilter === "all"}
              onClick={() => {
                actions.setDiagnosticFilter("all");
              }}
            >
              {COPY.allFindings[locale]}
            </button>
          </div>
          <label className="vl-toolbar__check" htmlFor={sourceMaterialId}>
            <input
              id={sourceMaterialId}
              type="checkbox"
              checked={state.sourceMaterialInspection}
              onChange={(event) => {
                actions.setSourceMaterialInspection(event.target.checked);
              }}
            />
            <span>{COPY.sourceMaterial[locale]}</span>
          </label>
        </fieldset>
      ) : null}

      {showFallbackControls ? (
        <fieldset className="vl-toolbar__group vl-toolbar__group--contextual">
          <legend>{TOOLBAR_COPY.fallbackActions[locale]}</legend>
          <button
            type="button"
            className="vl-toolbar__button"
            onClick={fallbackAction}
          >
            {fallbackLabel[locale]}
          </button>
        </fieldset>
      ) : null}

      <fieldset className="vl-toolbar__group">
        <legend>{COPY.language[locale]}</legend>
        <div className="vl-toolbar__buttons">
          {LOCALES.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className="vl-toolbar__button"
              aria-pressed={locale === id}
              onClick={() => {
                actions.setLocale(id);
              }}
            >
              {label[locale]}
            </button>
          ))}
        </div>
      </fieldset>

      <label className="vl-toolbar__check" htmlFor={reducedMotionId}>
        <input
          id={reducedMotionId}
          type="checkbox"
          checked={state.reducedMotion}
          onChange={(event) => {
            actions.setReducedMotion(event.target.checked);
          }}
        />
        <span>{COPY.reducedMotion[locale]}</span>
      </label>
    </section>
  );
}
