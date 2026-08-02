import type { CSSProperties, ReactElement } from "react";
import { STORY_STEPS } from "./navigationStory";
import {
  NavigationIcon,
  type NavigationVariantProps,
} from "./NavigationScene";

const SCRUBBER_COPY = {
  region: {
    en: "Route scrubber navigation",
    ja: "ルートスクラバー式ナビゲーション",
  },
  now: {
    en: "Now",
    ja: "現在",
  },
  timeline: {
    en: "Route story timeline",
    ja: "ルートストーリーのタイムライン",
  },
  progress: {
    en: "Route progress",
    ja: "ルート進行状況",
  },
  step: {
    en: "Select route step",
    ja: "ルートステップを選択",
  },
  play: {
    en: "Play route",
    ja: "ルートを再生",
  },
  playAgain: {
    en: "Play route again",
    ja: "ルートをもう一度再生",
  },
  pause: {
    en: "Pause route",
    ja: "ルートを一時停止",
  },
  replayConnector: {
    en: "Replay floor change",
    ja: "フロア移動を再生し直す",
  },
  overview: {
    en: "Show route overview",
    ja: "ルート全体を表示",
  },
  closeOverview: {
    en: "Close route overview",
    ja: "ルート全体表示を閉じる",
  },
  restart: {
    en: "Restart route",
    ja: "ルートを最初からやり直す",
  },
  viewFloor: {
    en: "Explore floor",
    ja: "フロアを表示",
  },
  returnToRoute: {
    en: "Return to route",
    ja: "ルートに戻る",
  },
} as const;

export function RouteScrubber(props: NavigationVariantProps): ReactElement {
  const {
    step,
    stepIndex,
    playback,
    locale,
    overviewOpen,
    viewFloor,
    routeFloor,
    onTogglePlayback,
    onRestart,
    onReplayConnector,
    onToggleOverview,
    onSelectStep,
    onSelectViewedFloor,
    onReturnToRoute,
  } = props;
  const progressPercent = (stepIndex / (STORY_STEPS.length - 1)) * 100;
  const markerStyle: CSSProperties = { left: `${progressPercent}%` };
  const playbackLabel =
    playback === "playing"
      ? SCRUBBER_COPY.pause[locale]
      : playback === "complete"
        ? SCRUBBER_COPY.playAgain[locale]
        : SCRUBBER_COPY.play[locale];

  return (
    <section className="route-scrubber" aria-label={SCRUBBER_COPY.region[locale]}>
      <header className="route-scrubber__header">
        <div className="route-scrubber__current">
          <p>{SCRUBBER_COPY.now[locale]}</p>
          <strong>{step.instruction[locale]}</strong>
          <span>{step.detail[locale]}</span>
        </div>
        <span className="route-scrubber__floor">{routeFloor}</span>
      </header>

      <div className="route-scrubber__timeline" aria-label={SCRUBBER_COPY.timeline[locale]}>
        <progress
          className="route-scrubber__progress"
          max={STORY_STEPS.length - 1}
          value={stepIndex}
          aria-label={SCRUBBER_COPY.progress[locale]}
        />
        <span className="route-scrubber__marker" style={markerStyle} aria-hidden="true">
          <span />
        </span>
        <ol>
          {STORY_STEPS.map((routeStep, index) => {
            const itemState = index < stepIndex ? "completed" : index === stepIndex ? "current" : "upcoming";
            return (
              <li key={routeStep.id} data-state={itemState}>
                <button
                  type="button"
                  className="route-scrubber__step"
                  aria-current={itemState === "current" ? "step" : undefined}
                  aria-label={`${SCRUBBER_COPY.step[locale]} ${index + 1}: ${routeStep.instruction[locale]}`}
                  onClick={() => {
                    onSelectStep(index);
                  }}
                >
                  <span className="route-scrubber__step-icon" aria-hidden="true">
                    {routeStep.id === "connector" || routeStep.id === "floor-change" ? (
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M5 17h5l7-10h3" />
                        <path d="m17 4 3 3-3 3" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                        <circle cx="12" cy="12" r="4" />
                        <path d="M4 12h4M16 12h4" />
                      </svg>
                    )}
                  </span>
                  <span className="route-scrubber__step-number">{index + 1}</span>
                  <span className="route-scrubber__step-copy">
                    <strong>{routeStep.floor}</strong>
                    <span>{routeStep.instruction[locale]}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      <footer className="route-scrubber__footer">
        <div className="route-scrubber__actions">
          <button type="button" className="route-scrubber__primary" onClick={onTogglePlayback}>
            <NavigationIcon name={playback === "playing" ? "pause" : "play"} />
            <span>{playbackLabel}</span>
          </button>
          <button type="button" onClick={onReplayConnector}>
            <NavigationIcon name="replay" />
            <span>{SCRUBBER_COPY.replayConnector[locale]}</span>
          </button>
          <button type="button" aria-pressed={overviewOpen} onClick={onToggleOverview}>
            <NavigationIcon name="overview" />
            <span>
              {overviewOpen
                ? SCRUBBER_COPY.closeOverview[locale]
                : SCRUBBER_COPY.overview[locale]}
            </span>
          </button>
          <button type="button" onClick={onRestart}>
            <NavigationIcon name="restart" />
            <span>{SCRUBBER_COPY.restart[locale]}</span>
          </button>
        </div>

        <div className="route-scrubber__floor-controls" role="group" aria-label={SCRUBBER_COPY.viewFloor[locale]}>
          {(["B1", "1F"] as const).map((floor) => (
            <button
              key={floor}
              type="button"
              aria-pressed={viewFloor === floor}
              onClick={() => {
                onSelectViewedFloor(floor);
              }}
            >
              {floor}
            </button>
          ))}
          {viewFloor !== routeFloor ? (
            <button type="button" className="route-scrubber__return" onClick={onReturnToRoute}>
              <NavigationIcon name="route" />
              <span>{SCRUBBER_COPY.returnToRoute[locale]}</span>
            </button>
          ) : null}
        </div>
      </footer>
    </section>
  );
}
