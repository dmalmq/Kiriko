import { useEffect, useMemo, useReducer } from "react";
import {
  STORY_STEPS,
  stepFloor,
  type FloorId,
  type PlaybackState,
  type PrototypeLocale,
  type VariantId,
} from "./navigationStory";

export interface NavigationStoryState {
  variant: VariantId;
  stepIndex: number;
  playback: PlaybackState;
  overviewOpen: boolean;
  viewFloor: FloorId;
  locale: PrototypeLocale;
  reducedMotion: boolean;
}

export interface NavigationStoryActions {
  togglePlayback(): void;
  restart(): void;
  replayConnector(): void;
  toggleOverview(): void;
  selectViewedFloor(floor: FloorId): void;
  returnToRoute(): void;
  setLocale(locale: PrototypeLocale): void;
  setReducedMotion(reducedMotion: boolean): void;
  selectStep(stepIndex: number): void;
  setVariant(variant: VariantId): void;
}

interface NavigationStoryMachine extends NavigationStoryState {
  followingRoute: boolean;
}

type NavigationStoryAction =
  | { type: "toggle-playback" }
  | { type: "restart" }
  | { type: "replay-connector" }
  | { type: "toggle-overview" }
  | { type: "select-viewed-floor"; floor: FloorId }
  | { type: "return-to-route" }
  | { type: "set-locale"; locale: PrototypeLocale }
  | { type: "set-reduced-motion"; reducedMotion: boolean }
  | { type: "select-step"; stepIndex: number }
  | { type: "set-variant"; variant: VariantId }
  | { type: "advance" };

const FIRST_STEP_INDEX = 0;
const FINAL_STEP_INDEX = STORY_STEPS.length - 1;
const CONNECTOR_STEP_INDEX = STORY_STEPS.findIndex((step) => step.id === "connector");

const INITIAL_STATE: NavigationStoryMachine = {
  variant: "guided",
  stepIndex: FIRST_STEP_INDEX,
  playback: "ready",
  overviewOpen: false,
  viewFloor: stepFloor(STORY_STEPS[FIRST_STEP_INDEX]),
  locale: "en",
  reducedMotion: false,
  followingRoute: true,
};

function routeFloor(stepIndex: number): FloorId {
  return stepFloor(STORY_STEPS[stepIndex]);
}

function selectRouteStep(
  state: NavigationStoryMachine,
  stepIndex: number,
  playback: PlaybackState,
): NavigationStoryMachine {
  return {
    ...state,
    stepIndex,
    playback,
    overviewOpen: false,
    viewFloor: routeFloor(stepIndex),
    followingRoute: true,
  };
}

function navigationStoryReducer(
  state: NavigationStoryMachine,
  action: NavigationStoryAction,
): NavigationStoryMachine {
  switch (action.type) {
    case "toggle-playback":
      if (state.playback === "playing") {
        return { ...state, playback: "paused" };
      }
      if (state.playback === "complete") {
        return selectRouteStep(state, FIRST_STEP_INDEX, "playing");
      }
      return { ...state, playback: "playing" };

    case "restart":
      return selectRouteStep(state, FIRST_STEP_INDEX, "ready");

    case "replay-connector":
      return selectRouteStep(state, CONNECTOR_STEP_INDEX, "playing");

    case "toggle-overview":
      return { ...state, overviewOpen: !state.overviewOpen };

    case "select-viewed-floor":
      return {
        ...state,
        viewFloor: action.floor,
        followingRoute: false,
      };

    case "return-to-route":
      return {
        ...state,
        viewFloor: routeFloor(state.stepIndex),
        followingRoute: true,
      };

    case "set-locale":
      return { ...state, locale: action.locale };

    case "set-reduced-motion":
      return { ...state, reducedMotion: action.reducedMotion };

    case "select-step": {
      const stepIndex = Math.min(
        Math.max(Math.trunc(action.stepIndex), FIRST_STEP_INDEX),
        FINAL_STEP_INDEX,
      );
      const playback: PlaybackState = stepIndex === FINAL_STEP_INDEX ? "complete" : "paused";
      return selectRouteStep(state, stepIndex, playback);
    }

    case "set-variant":
      return { ...state, variant: action.variant };

    case "advance": {
      if (state.stepIndex === FINAL_STEP_INDEX) {
        return { ...state, playback: "complete" };
      }
      const stepIndex = state.stepIndex + 1;
      return {
        ...state,
        stepIndex,
        viewFloor: state.followingRoute ? routeFloor(stepIndex) : state.viewFloor,
      };
    }
  }
}

export function useNavigationStory(): {
  state: NavigationStoryState;
  actions: NavigationStoryActions;
} {
  const [machine, dispatch] = useReducer(navigationStoryReducer, INITIAL_STATE);

  useEffect(() => {
    if (machine.playback !== "playing") {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      dispatch({ type: "advance" });
    }, STORY_STEPS[machine.stepIndex].durationMs);

    return () => {
      window.clearTimeout(timer);
    };
  }, [machine.playback, machine.stepIndex]);

  const state = useMemo<NavigationStoryState>(() => ({
    variant: machine.variant,
    stepIndex: machine.stepIndex,
    playback: machine.playback,
    overviewOpen: machine.overviewOpen,
    viewFloor: machine.viewFloor,
    locale: machine.locale,
    reducedMotion: machine.reducedMotion,
  }), [
    machine.locale,
    machine.overviewOpen,
    machine.playback,
    machine.reducedMotion,
    machine.stepIndex,
    machine.variant,
    machine.viewFloor,
  ]);

  const actions = useMemo<NavigationStoryActions>(() => ({
    togglePlayback: () => dispatch({ type: "toggle-playback" }),
    restart: () => dispatch({ type: "restart" }),
    replayConnector: () => dispatch({ type: "replay-connector" }),
    toggleOverview: () => dispatch({ type: "toggle-overview" }),
    selectViewedFloor: (floor) => dispatch({ type: "select-viewed-floor", floor }),
    returnToRoute: () => dispatch({ type: "return-to-route" }),
    setLocale: (locale) => dispatch({ type: "set-locale", locale }),
    setReducedMotion: (reducedMotion) => dispatch({
      type: "set-reduced-motion",
      reducedMotion,
    }),
    selectStep: (stepIndex) => dispatch({ type: "select-step", stepIndex }),
    setVariant: (variant) => dispatch({ type: "set-variant", variant }),
  }), [dispatch]);

  return { state, actions };
}
