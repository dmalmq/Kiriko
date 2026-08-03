import { useEffect, useMemo, useReducer } from "react";
import {
  COPY,
  HANDOFF_PHASES,
  type FloorId,
  type HandoffPhaseId,
  type PrototypeLocale,
  type ScenarioId,
  type SceneSourceKind,
  type SourceLayout,
} from "./visualLanguage";

export type DiagnosticFilter = "default" | "all";
export type FallbackPhase = "idle" | "veil" | "generated";
export type PlaybackState = "ready" | "playing" | "paused" | "complete";

export interface VisualLanguagePrototypeState {
  readonly locale: PrototypeLocale;
  readonly sourceLayout: SourceLayout;
  readonly sourceKind: SceneSourceKind;
  readonly scenario: ScenarioId;
  readonly reducedMotion: boolean;
  readonly activeFloor: FloorId;
  readonly handoffIndex: number;
  readonly playback: PlaybackState;
  readonly fallbackPhase: FallbackPhase;
  readonly fallbackNoticeVisible: boolean;
  readonly selectedId: string | null;
  readonly diagnosticFilter: DiagnosticFilter;
  readonly sourceMaterialInspection: boolean;
}

export interface VisualLanguagePrototypeActions {
  readonly setLocale: (locale: PrototypeLocale) => void;
  readonly setSourceLayout: (layout: SourceLayout) => void;
  readonly setSourceKind: (kind: SceneSourceKind) => void;
  readonly setScenario: (scenario: ScenarioId) => void;
  readonly setReducedMotion: (value: boolean) => void;
  readonly playHandoff: () => void;
  readonly pauseHandoff: () => void;
  readonly restartHandoff: () => void;
  readonly simulateDetailedFailure: () => void;
  readonly retryDetailed: () => void;
  readonly selectObject: (id: string | null) => void;
  readonly setDiagnosticFilter: (filter: DiagnosticFilter) => void;
  readonly setSourceMaterialInspection: (value: boolean) => void;
}

type Action =
  | { readonly type: "set-locale"; readonly locale: PrototypeLocale }
  | { readonly type: "set-layout"; readonly layout: SourceLayout }
  | { readonly type: "set-source"; readonly source: SceneSourceKind }
  | { readonly type: "set-scenario"; readonly scenario: ScenarioId }
  | { readonly type: "set-reduced-motion"; readonly value: boolean }
  | { readonly type: "play-handoff" }
  | { readonly type: "pause-handoff" }
  | { readonly type: "restart-handoff" }
  | { readonly type: "advance-handoff" }
  | { readonly type: "simulate-failure" }
  | { readonly type: "complete-fallback" }
  | { readonly type: "retry-detailed" }
  | { readonly type: "select-object"; readonly id: string | null }
  | { readonly type: "set-diagnostic-filter"; readonly filter: DiagnosticFilter }
  | { readonly type: "set-source-material"; readonly value: boolean };

const initialState: VisualLanguagePrototypeState = {
  locale: "en",
  sourceLayout: "compare",
  sourceKind: "detailed",
  scenario: "guidance",
  reducedMotion: false,
  activeFloor: "B1",
  handoffIndex: 0,
  playback: "ready",
  fallbackPhase: "idle",
  fallbackNoticeVisible: false,
  selectedId: null,
  diagnosticFilter: "default",
  sourceMaterialInspection: false,
};

const HANDOFF_LIVE_MESSAGES = {
  "walk-b1": {
    en: "Following the route on B1.",
    ja: "B1 のルートを進んでいます。",
  },
  "announce-escalator": {
    en: "Take the escalator to 1F.",
    ja: "エスカレーターで 1F へ進みます。",
  },
  "pull-back": {
    en: "Pulling back to show the floor handoff.",
    ja: "フロア移動を示すために視点を引いています。",
  },
  "show-destination-floor": {
    en: "Showing destination floor 1F.",
    ja: "移動先フロアの 1F を表示しています。",
  },
  "switch-floor": {
    en: "Switching the active floor to 1F.",
    ja: "表示中のフロアを 1F に切り替えています。",
  },
  "settle-1f": {
    en: "Floor handoff complete on 1F.",
    ja: "1F へのフロア移動が完了しました。",
  },
} as const satisfies Record<HandoffPhaseId, Record<PrototypeLocale, string>>;

function reducer(
  state: VisualLanguagePrototypeState,
  action: Action,
): VisualLanguagePrototypeState {
  switch (action.type) {
    case "set-locale":
      return { ...state, locale: action.locale };
    case "set-layout":
      return {
        ...state,
        sourceLayout: action.layout,
        sourceKind:
          action.layout === "compare" && state.sourceKind === "twoDimensional"
            ? "detailed"
            : state.sourceKind,
      };
    case "set-source":
      return {
        ...state,
        sourceLayout: "single",
        sourceKind: action.source,
        fallbackPhase: "idle",
        fallbackNoticeVisible: false,
      };
    case "set-scenario":
      return {
        ...state,
        scenario: action.scenario,
        sourceLayout: action.scenario === "fallback" ? "single" : state.sourceLayout,
        sourceKind: action.scenario === "fallback" ? "detailed" : state.sourceKind,
        activeFloor: "B1",
        handoffIndex: 0,
        playback: "ready",
        fallbackPhase: "idle",
        fallbackNoticeVisible: false,
        selectedId: action.scenario === "selection" ? "escalator-b1-1f" : null,
        diagnosticFilter: "default",
        sourceMaterialInspection: false,
      };
    case "set-reduced-motion":
      return state.fallbackPhase === "veil" && action.value
        ? {
            ...state,
            reducedMotion: true,
            sourceKind: "generated",
            fallbackPhase: "generated",
            fallbackNoticeVisible: true,
          }
        : { ...state, reducedMotion: action.value };
    case "play-handoff":
      return {
        ...state,
        scenario: "handoff",
        playback: state.playback === "complete" ? "complete" : "playing",
      };
    case "pause-handoff":
      return { ...state, playback: "paused" };
    case "restart-handoff":
      return {
        ...state,
        scenario: "handoff",
        activeFloor: "B1",
        handoffIndex: 0,
        playback: "ready",
      };
    case "advance-handoff": {
      const lastIndex = HANDOFF_PHASES.length - 1;
      const nextIndex = Math.min(state.handoffIndex + 1, lastIndex);
      return {
        ...state,
        handoffIndex: nextIndex,
        activeFloor: HANDOFF_PHASES[nextIndex]!.floor,
        playback: nextIndex === lastIndex ? "complete" : "playing",
      };
    }
    case "simulate-failure":
      return state.reducedMotion
        ? {
            ...state,
            sourceKind: "generated",
            fallbackPhase: "generated",
            fallbackNoticeVisible: true,
          }
        : { ...state, fallbackPhase: "veil", fallbackNoticeVisible: true };
    case "complete-fallback":
      return {
        ...state,
        sourceKind: "generated",
        fallbackPhase: "generated",
        fallbackNoticeVisible: true,
      };
    case "retry-detailed":
      return {
        ...state,
        sourceKind: "detailed",
        fallbackPhase: "idle",
        fallbackNoticeVisible: false,
      };
    case "select-object":
      return { ...state, selectedId: action.id };
    case "set-diagnostic-filter":
      return { ...state, diagnosticFilter: action.filter };
    case "set-source-material":
      return {
        ...state,
        sourceMaterialInspection:
          state.scenario === "diagnostics" ? action.value : false,
      };
    default: {
      const neverAction: never = action;
      return neverAction;
    }
  }
}

export function useVisualLanguagePrototype() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const currentPhase = HANDOFF_PHASES[state.handoffIndex]!;

  useEffect(() => {
    if (state.playback !== "playing") {
      return;
    }

    const timer = window.setTimeout(() => {
      dispatch({ type: "advance-handoff" });
    }, currentPhase.durationMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [currentPhase.durationMs, state.handoffIndex, state.playback]);

  useEffect(() => {
    if (state.fallbackPhase !== "veil") {
      return;
    }

    const timer = window.setTimeout(() => {
      dispatch({ type: "complete-fallback" });
    }, 160);

    return () => {
      window.clearTimeout(timer);
    };
  }, [state.fallbackPhase]);

  const actions = useMemo<VisualLanguagePrototypeActions>(
    () => ({
      setLocale: (locale) => {
        dispatch({ type: "set-locale", locale });
      },
      setSourceLayout: (layout) => {
        dispatch({ type: "set-layout", layout });
      },
      setSourceKind: (source) => {
        dispatch({ type: "set-source", source });
      },
      setScenario: (scenario) => {
        dispatch({ type: "set-scenario", scenario });
      },
      setReducedMotion: (value) => {
        dispatch({ type: "set-reduced-motion", value });
      },
      playHandoff: () => {
        if (state.playback === "complete") {
          dispatch({ type: "restart-handoff" });
        }
        dispatch({ type: "play-handoff" });
      },
      pauseHandoff: () => {
        dispatch({ type: "pause-handoff" });
      },
      restartHandoff: () => {
        dispatch({ type: "restart-handoff" });
      },
      simulateDetailedFailure: () => {
        dispatch({ type: "simulate-failure" });
      },
      retryDetailed: () => {
        dispatch({ type: "retry-detailed" });
      },
      selectObject: (id) => {
        dispatch({ type: "select-object", id });
      },
      setDiagnosticFilter: (filter) => {
        dispatch({ type: "set-diagnostic-filter", filter });
      },
      setSourceMaterialInspection: (value) => {
        dispatch({ type: "set-source-material", value });
      },
    }),
    [state.playback],
  );

  const liveMessage = `${HANDOFF_LIVE_MESSAGES[currentPhase.id][state.locale]} ${COPY.activeFloor[state.locale]}: ${state.activeFloor}.${
    state.fallbackNoticeVisible ? ` ${COPY.fallbackNotice[state.locale]}` : ""
  }`;

  return { state, actions, currentPhase, liveMessage } as const;
}
