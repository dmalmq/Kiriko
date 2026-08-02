import type { ReactElement } from "react";
import {
  NavigationIcon,
  type NavigationVariantProps,
} from "./NavigationScene";

const RAIL_COPY = {
  region: {
    en: "Vertical journey rail navigation",
    ja: "縦型ジャーニーレール式ナビゲーション",
  },
  title: {
    en: "Journey through floors",
    ja: "フロア間の移動",
  },
  currentInstruction: {
    en: "Current instruction",
    ja: "現在の案内",
  },
  basement: {
    en: "B1 concourse",
    ja: "地下1階コンコース",
  },
  basementDetail: {
    en: "Walk to the connector",
    ja: "乗り換え設備まで歩く",
  },
  connector: {
    en: "Escalator to 1F",
    ja: "1階行きエスカレーター",
  },
  connectorDetail: {
    en: "Selected floor change",
    ja: "選択中のフロア移動",
  },
  firstFloor: {
    en: "1F Marunouchi exit",
    ja: "1階 丸の内口",
  },
  firstFloorDetail: {
    en: "Final walking leg",
    ja: "最後の徒歩区間",
  },
  completed: {
    en: "Completed",
    ja: "完了",
  },
  current: {
    en: "Current",
    ja: "現在",
  },
  upcoming: {
    en: "Upcoming",
    ja: "次の予定",
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
    en: "Explore floor",
    ja: "フロアを表示",
  },
  returnToRoute: {
    en: "Return to route",
    ja: "ルートに戻る",
  },
} as const;

type RailStageState = "completed" | "current" | "upcoming";

export function VerticalJourneyRail(props: NavigationVariantProps): ReactElement {
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
  const stages: readonly {
    id: "b1" | "connector" | "1f";
    label: string;
    detail: string;
    state: RailStageState;
    targetStep: number;
  }[] = [
    {
      id: "b1",
      label: RAIL_COPY.basement[locale],
      detail: RAIL_COPY.basementDetail[locale],
      state: stepIndex < 2 ? "current" : "completed",
      targetStep: 1,
    },
    {
      id: "connector",
      label: RAIL_COPY.connector[locale],
      detail: RAIL_COPY.connectorDetail[locale],
      state: stepIndex < 2 ? "upcoming" : stepIndex <= 4 ? "current" : "completed",
      targetStep: 2,
    },
    {
      id: "1f",
      label: RAIL_COPY.firstFloor[locale],
      detail: RAIL_COPY.firstFloorDetail[locale],
      state: stepIndex < 5 ? "upcoming" : stepIndex < 7 ? "current" : "completed",
      targetStep: 5,
    },
  ];
  const statusLabels: Readonly<Record<RailStageState, string>> = {
    completed: RAIL_COPY.completed[locale],
    current: RAIL_COPY.current[locale],
    upcoming: RAIL_COPY.upcoming[locale],
  };
  const playbackLabel =
    playback === "playing"
      ? RAIL_COPY.pause[locale]
      : playback === "complete"
        ? RAIL_COPY.playAgain[locale]
        : RAIL_COPY.play[locale];

  return (
    <aside className="journey-rail" aria-label={RAIL_COPY.region[locale]}>
      <header className="journey-rail__header">
        <h2>{RAIL_COPY.title[locale]}</h2>
        <span className="journey-rail__floor">{routeFloor}</span>
      </header>

      <ol className="journey-rail__stages">
        {stages.map((stage) => (
          <li key={stage.id} className="journey-rail__stage" data-state={stage.state}>
            <button
              type="button"
              className="journey-rail__stage-button"
              aria-current={stage.state === "current" ? "step" : undefined}
              onClick={() => {
                onSelectStep(stage.targetStep);
              }}
            >
              <span className="journey-rail__stage-icon" aria-hidden="true">
                {stage.id === "connector" ? (
                  <svg viewBox="0 0 32 32" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M5 24h7L22 8h5" />
                    <path d="M10 20h5M14 16h5M18 12h5" />
                    <path d="m23 5 4 3-4 3" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 32 32" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="m16 5 12 6-12 6-12-6Z" />
                    <path d="m4 17 12 6 12-6" />
                  </svg>
                )}
              </span>
              <span className="journey-rail__stage-copy">
                <strong>{stage.label}</strong>
                <span>{stage.detail}</span>
              </span>
              <span className="journey-rail__stage-status">{statusLabels[stage.state]}</span>
            </button>
          </li>
        ))}
      </ol>

      <section className="journey-rail__instruction" aria-labelledby="journey-current-instruction">
        <p id="journey-current-instruction">{RAIL_COPY.currentInstruction[locale]}</p>
        <strong>{step.instruction[locale]}</strong>
        <span>{step.detail[locale]}</span>
      </section>

      <div className="journey-rail__floor-controls" role="group" aria-label={RAIL_COPY.viewFloor[locale]}>
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
          <button type="button" className="journey-rail__return" onClick={onReturnToRoute}>
            <NavigationIcon name="route" />
            <span>{RAIL_COPY.returnToRoute[locale]}</span>
          </button>
        ) : null}
      </div>

      <div className="journey-rail__actions">
        <button type="button" className="journey-rail__primary" onClick={onTogglePlayback}>
          <NavigationIcon name={playback === "playing" ? "pause" : "play"} />
          <span>{playbackLabel}</span>
        </button>
        <button type="button" aria-pressed={overviewOpen} onClick={onToggleOverview}>
          <NavigationIcon name="overview" />
          <span>
            {overviewOpen ? RAIL_COPY.closeOverview[locale] : RAIL_COPY.overview[locale]}
          </span>
        </button>
        <button type="button" onClick={onReplayConnector}>
          <NavigationIcon name="replay" />
          <span>{RAIL_COPY.replayConnector[locale]}</span>
        </button>
        <button type="button" onClick={onRestart}>
          <NavigationIcon name="restart" />
          <span>{RAIL_COPY.restart[locale]}</span>
        </button>
      </div>
    </aside>
  );
}
