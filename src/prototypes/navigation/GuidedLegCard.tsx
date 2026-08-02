import type { ReactElement } from "react";
import { STORY_STEPS } from "./navigationStory";
import {
  NavigationIcon,
  type NavigationVariantProps,
} from "./NavigationScene";

const GUIDED_COPY = {
  region: {
    en: "Guided leg card navigation",
    ja: "ガイドカード式ナビゲーション",
  },
  nextAction: {
    en: "Next action",
    ja: "次のアクション",
  },
  remaining: {
    en: "Remaining",
    ja: "残り",
  },
  currentFloor: {
    en: "Current floor",
    ja: "現在のフロア",
  },
  routeProgress: {
    en: "Route progress",
    ja: "ルート進行状況",
  },
  step: {
    en: "Route step",
    ja: "ルートステップ",
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
  overview: {
    en: "Show route overview",
    ja: "ルート全体を表示",
  },
  closeOverview: {
    en: "Close route overview",
    ja: "ルート全体表示を閉じる",
  },
  replayConnector: {
    en: "Replay floor change",
    ja: "フロア移動を再生し直す",
  },
  restart: {
    en: "Restart route",
    ja: "ルートを最初からやり直す",
  },
  viewFloor: {
    en: "View floor",
    ja: "表示するフロア",
  },
  returnToRoute: {
    en: "Return to route",
    ja: "ルートに戻る",
  },
} as const;

function remainingDistance(stepIndex: number): number {
  let distance = 0;
  for (let index = stepIndex; index < STORY_STEPS.length; index += 1) {
    const routeStep = STORY_STEPS[index];
    if (routeStep) {
      distance += routeStep.distanceM;
    }
  }
  return distance;
}

function routeStepState(index: number, currentIndex: number): "completed" | "current" | "upcoming" {
  if (index < currentIndex) {
    return "completed";
  }
  if (index === currentIndex) {
    return "current";
  }
  return "upcoming";
}

export function GuidedLegCard(props: NavigationVariantProps): ReactElement {
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
  const playbackLabel =
    playback === "playing"
      ? GUIDED_COPY.pause[locale]
      : playback === "complete"
        ? GUIDED_COPY.playAgain[locale]
        : GUIDED_COPY.play[locale];

  return (
    <section className="guided-leg" aria-label={GUIDED_COPY.region[locale]}>
      <article className="guided-leg__card">
        <header className="guided-leg__header">
          <p className="guided-leg__label">{GUIDED_COPY.nextAction[locale]}</p>
          <span className="guided-leg__floor" aria-label={`${GUIDED_COPY.currentFloor[locale]} ${routeFloor}`}>
            {routeFloor}
          </span>
        </header>

        <h2 className="guided-leg__instruction">{step.instruction[locale]}</h2>
        <p className="guided-leg__detail">{step.detail[locale]}</p>

        <dl className="guided-leg__metrics">
          <div>
            <dt>{GUIDED_COPY.remaining[locale]}</dt>
            <dd>{remainingDistance(stepIndex)} m</dd>
          </div>
          <div>
            <dt>{GUIDED_COPY.currentFloor[locale]}</dt>
            <dd>{routeFloor}</dd>
          </div>
        </dl>

        <nav className="guided-leg__strip" aria-label={GUIDED_COPY.routeProgress[locale]}>
          <ol>
            {STORY_STEPS.map((routeStep, index) => {
              const itemState = routeStepState(index, stepIndex);
              return (
                <li key={routeStep.id} data-state={itemState}>
                  <button
                    type="button"
                    className="guided-leg__step"
                    aria-current={itemState === "current" ? "step" : undefined}
                    aria-label={`${GUIDED_COPY.step[locale]} ${index + 1}: ${routeStep.instruction[locale]}`}
                    onClick={() => {
                      onSelectStep(index);
                    }}
                  >
                    <span aria-hidden="true" />
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <div className="guided-leg__floor-controls" role="group" aria-label={GUIDED_COPY.viewFloor[locale]}>
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
            <button type="button" className="guided-leg__return" onClick={onReturnToRoute}>
              <NavigationIcon name="route" />
              <span>{GUIDED_COPY.returnToRoute[locale]}</span>
            </button>
          ) : null}
        </div>

        <div className="guided-leg__actions">
          <button type="button" className="guided-leg__primary" onClick={onTogglePlayback}>
            <NavigationIcon name={playback === "playing" ? "pause" : "play"} />
            <span>{playbackLabel}</span>
          </button>
          <button
            type="button"
            aria-pressed={overviewOpen}
            onClick={onToggleOverview}
          >
            <NavigationIcon name="overview" />
            <span>
              {overviewOpen
                ? GUIDED_COPY.closeOverview[locale]
                : GUIDED_COPY.overview[locale]}
            </span>
          </button>
          <button type="button" onClick={onReplayConnector}>
            <NavigationIcon name="replay" />
            <span>{GUIDED_COPY.replayConnector[locale]}</span>
          </button>
          <button type="button" onClick={onRestart}>
            <NavigationIcon name="restart" />
            <span>{GUIDED_COPY.restart[locale]}</span>
          </button>
        </div>
      </article>
    </section>
  );
}
