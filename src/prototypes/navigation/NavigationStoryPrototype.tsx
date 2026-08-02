import type { ReactElement } from "react";
import { KirikoMark } from "../../components/icons";
import { GuidedLegCard } from "./GuidedLegCard";
import {
  NavigationIcon,
  NavigationScene,
  cameraPhaseForStep,
  type CameraPhase,
  type NavigationVariantProps,
} from "./NavigationScene";
import { RouteScrubber } from "./RouteScrubber";
import {
  STORY_STEPS,
  VARIANT_LABELS,
  type PlaybackState,
  type PrototypeLocale,
  type VariantId,
} from "./navigationStory";
import { useNavigationStory } from "./useNavigationStory";
import { VerticalJourneyRail } from "./VerticalJourneyRail";

const SHELL_COPY = {
  title: {
    en: "Navigation story comparison",
    ja: "ナビゲーションストーリー比較",
  },
  prototypeData: {
    en: "Prototype data — synthetic route",
    ja: "プロトタイプデータ — 合成ルート",
  },
  scenario: {
    en: "Tokyo Station · B1 to Marunouchi exit",
    ja: "東京駅・地下1階から丸の内口へ",
  },
  language: {
    en: "Interface language",
    ja: "表示言語",
  },
  english: {
    en: "English",
    ja: "英語",
  },
  japanese: {
    en: "Japanese",
    ja: "日本語",
  },
  reducedMotion: {
    en: "Reduced motion",
    ja: "動きを抑える",
  },
  inspector: {
    en: "Prototype state",
    ja: "プロトタイプの状態",
  },
  variant: {
    en: "Variant",
    ja: "バリエーション",
  },
  playback: {
    en: "Playback",
    ja: "再生状態",
  },
  step: {
    en: "Step",
    ja: "ステップ",
  },
  routeFloor: {
    en: "Route floor",
    ja: "ルートのフロア",
  },
  viewedFloor: {
    en: "Viewed floor",
    ja: "表示中のフロア",
  },
  cameraPhase: {
    en: "Camera phase",
    ja: "カメラの段階",
  },
  overview: {
    en: "Overview",
    ja: "全体表示",
  },
  locale: {
    en: "Locale",
    ja: "言語",
  },
  enabled: {
    en: "On",
    ja: "オン",
  },
  disabled: {
    en: "Off",
    ja: "オフ",
  },
  open: {
    en: "Open",
    ja: "表示中",
  },
  closed: {
    en: "Closed",
    ja: "閉じている",
  },
  compareVariants: {
    en: "Compare navigation layouts",
    ja: "ナビゲーションレイアウトを比較",
  },
  liveFloor: {
    en: "Route floor",
    ja: "ルートのフロア",
  },
} as const;

const PLAYBACK_LABELS: Readonly<Record<PlaybackState, { en: string; ja: string }>> = {
  ready: {
    en: "Ready",
    ja: "準備完了",
  },
  playing: {
    en: "Playing",
    ja: "再生中",
  },
  paused: {
    en: "Paused",
    ja: "一時停止中",
  },
  complete: {
    en: "Complete",
    ja: "完了",
  },
};

const CAMERA_LABELS: Readonly<Record<CameraPhase, { en: string; ja: string }>> = {
  close: {
    en: "Close view",
    ja: "近景",
  },
  "pull-back": {
    en: "Pull back",
    ja: "引きの視点",
  },
  "floor-change": {
    en: "Floor change",
    ja: "フロア切り替え",
  },
  settle: {
    en: "Settle",
    ja: "視点を整える",
  },
};

const LOCALE_LABELS: Readonly<Record<PrototypeLocale, { en: string; ja: string }>> = {
  en: SHELL_COPY.english,
  ja: SHELL_COPY.japanese,
};

const VARIANT_ORDER: readonly VariantId[] = ["guided", "rail", "scrubber"];

export function NavigationStoryPrototype(): ReactElement {
  const { state, actions } = useNavigationStory();
  const step = STORY_STEPS[state.stepIndex]!;
  const routeFloor = step.floor;
  const cameraPhase = cameraPhaseForStep(step.id);
  const variantProps: NavigationVariantProps = {
    step,
    stepIndex: state.stepIndex,
    playback: state.playback,
    locale: state.locale,
    overviewOpen: state.overviewOpen,
    viewFloor: state.viewFloor,
    routeFloor,
    onTogglePlayback: actions.togglePlayback,
    onRestart: actions.restart,
    onReplayConnector: actions.replayConnector,
    onToggleOverview: actions.toggleOverview,
    onSelectStep: actions.selectStep,
    onSelectViewedFloor: (floor) => {
      if (floor === routeFloor) {
        actions.returnToRoute();
        return;
      }
      actions.selectViewedFloor(floor);
    },
    onReturnToRoute: actions.returnToRoute,
  };
  let activeVariant: ReactElement | null = null;

  switch (state.variant) {
    case "guided":
      activeVariant = <GuidedLegCard {...variantProps} />;
      break;
    case "rail":
      activeVariant = <VerticalJourneyRail {...variantProps} />;
      break;
    case "scrubber":
      activeVariant = <RouteScrubber {...variantProps} />;
      break;
  }

  return (
    <main
      className={`navigation-prototype navigation-prototype--${state.variant}${state.reducedMotion ? " navigation-prototype--reduced-motion" : ""}`}
      data-playback={state.playback}
      data-camera-phase={cameraPhase}
    >
      <header className="navigation-prototype__context">
        <div className="navigation-prototype__identity">
          <KirikoMark size={24} />
          <div>
            <h1>{SHELL_COPY.title[state.locale]}</h1>
            <p>{SHELL_COPY.scenario[state.locale]}</p>
          </div>
          <span className="navigation-prototype__badge">
            {SHELL_COPY.prototypeData[state.locale]}
          </span>
        </div>

        <div className="navigation-prototype__preferences">
          <div
            className="navigation-prototype__locale"
            role="group"
            aria-label={SHELL_COPY.language[state.locale]}
          >
            <button
              type="button"
              aria-pressed={state.locale === "ja"}
              aria-label={SHELL_COPY.japanese[state.locale]}
              onClick={() => {
                actions.setLocale("ja");
              }}
            >
              日本語
            </button>
            <button
              type="button"
              aria-pressed={state.locale === "en"}
              aria-label={SHELL_COPY.english[state.locale]}
              onClick={() => {
                actions.setLocale("en");
              }}
            >
              English
            </button>
          </div>
          <button
            type="button"
            className="navigation-prototype__motion-toggle"
            aria-pressed={state.reducedMotion}
            onClick={() => {
              actions.setReducedMotion(!state.reducedMotion);
            }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 7h9a3 3 0 1 0-3-3" />
              <path d="M4 12h14a3 3 0 1 1-3 3" />
              <path d="M4 17h5" />
            </svg>
            <span>{SHELL_COPY.reducedMotion[state.locale]}</span>
            <span aria-hidden="true">
              {state.reducedMotion
                ? SHELL_COPY.enabled[state.locale]
                : SHELL_COPY.disabled[state.locale]}
            </span>
          </button>
        </div>
      </header>

      <div className="navigation-prototype__scene-layer">
        <NavigationScene
          step={step}
          viewFloor={state.viewFloor}
          overviewOpen={state.overviewOpen}
          reducedMotion={state.reducedMotion}
          locale={state.locale}
        />
      </div>

      <div className={`navigation-prototype__variant navigation-prototype__variant--${state.variant}`}>
        {activeVariant}
      </div>

      <aside className="navigation-prototype__inspector" aria-labelledby="navigation-inspector-title">
        <h2 id="navigation-inspector-title">{SHELL_COPY.inspector[state.locale]}</h2>
        <dl>
          <div>
            <dt>{SHELL_COPY.variant[state.locale]}</dt>
            <dd data-state-value={state.variant}>{VARIANT_LABELS[state.variant][state.locale]}</dd>
          </div>
          <div>
            <dt>{SHELL_COPY.playback[state.locale]}</dt>
            <dd data-state-value={state.playback}>{PLAYBACK_LABELS[state.playback][state.locale]}</dd>
          </div>
          <div>
            <dt>{SHELL_COPY.step[state.locale]}</dt>
            <dd data-state-value={step.id}>
              {state.stepIndex + 1}/{STORY_STEPS.length} · {step.instruction[state.locale]}
            </dd>
          </div>
          <div>
            <dt>{SHELL_COPY.routeFloor[state.locale]}</dt>
            <dd>{routeFloor}</dd>
          </div>
          <div>
            <dt>{SHELL_COPY.viewedFloor[state.locale]}</dt>
            <dd>{state.viewFloor}</dd>
          </div>
          <div>
            <dt>{SHELL_COPY.cameraPhase[state.locale]}</dt>
            <dd data-state-value={cameraPhase}>{CAMERA_LABELS[cameraPhase][state.locale]}</dd>
          </div>
          <div>
            <dt>{SHELL_COPY.overview[state.locale]}</dt>
            <dd data-state-value={state.overviewOpen ? "open" : "closed"}>
              {state.overviewOpen ? SHELL_COPY.open[state.locale] : SHELL_COPY.closed[state.locale]}
            </dd>
          </div>
          <div>
            <dt>{SHELL_COPY.locale[state.locale]}</dt>
            <dd data-state-value={state.locale}>{LOCALE_LABELS[state.locale][state.locale]}</dd>
          </div>
          <div>
            <dt>{SHELL_COPY.reducedMotion[state.locale]}</dt>
            <dd data-state-value={state.reducedMotion ? "on" : "off"}>
              {state.reducedMotion
                ? SHELL_COPY.enabled[state.locale]
                : SHELL_COPY.disabled[state.locale]}
            </dd>
          </div>
        </dl>
      </aside>

      <nav className="navigation-prototype__switcher" aria-label={SHELL_COPY.compareVariants[state.locale]}>
        {VARIANT_ORDER.map((variant) => (
          <button
            key={variant}
            type="button"
            aria-pressed={state.variant === variant}
            onClick={() => {
              actions.setVariant(variant);
            }}
          >
            <NavigationIcon name={variant === "scrubber" ? "replay" : variant === "rail" ? "overview" : "route"} />
            <span>{VARIANT_LABELS[variant][state.locale]}</span>
          </button>
        ))}
      </nav>

      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {step.instruction[state.locale]}. {SHELL_COPY.liveFloor[state.locale]} {routeFloor}.
      </div>
    </main>
  );
}
