import type { ReactElement, ReactNode } from "react";
import type {
  FloorId,
  PlaybackState,
  PrototypeLocale,
  StoryStep,
  StoryStepId,
} from "./navigationStory";

export type CameraPhase = "close" | "pull-back" | "floor-change" | "settle";

export interface NavigationSceneProps {
  step: StoryStep;
  viewFloor: FloorId;
  overviewOpen: boolean;
  reducedMotion: boolean;
  locale: PrototypeLocale;
}

export interface NavigationVariantProps {
  step: StoryStep;
  stepIndex: number;
  playback: PlaybackState;
  locale: PrototypeLocale;
  overviewOpen: boolean;
  viewFloor: FloorId;
  routeFloor: FloorId;
  onTogglePlayback(): void;
  onRestart(): void;
  onReplayConnector(): void;
  onToggleOverview(): void;
  onSelectStep(stepIndex: number): void;
  onSelectViewedFloor(floor: FloorId): void;
  onReturnToRoute(): void;
}

export type NavigationIconName =
  | "overview"
  | "pause"
  | "play"
  | "replay"
  | "restart"
  | "route";

const SCENE_COPY = {
  title: {
    en: "Schematic navigation scene",
    ja: "ナビゲーション模式図",
  },
  description: {
    en: "A synthetic station floor plan showing the selected route, escalator, stairs, and elevator.",
    ja: "選択中のルート、エスカレーター、階段、エレベーターを示す合成駅フロア図です。",
  },
  prototypeData: {
    en: "Prototype data — synthetic Tokyo Station route",
    ja: "プロトタイプデータ — 合成した東京駅ルート",
  },
  southConcourse: {
    en: "South concourse",
    ja: "南コンコース",
  },
  eastAtrium: {
    en: "East atrium",
    ja: "東アトリウム",
  },
  start: {
    en: "Start",
    ja: "出発地",
  },
  destination: {
    en: "Marunouchi exit",
    ja: "丸の内口",
  },
  escalator: {
    en: "Selected escalator",
    ja: "選択中のエスカレーター",
  },
  stairs: {
    en: "Alternative stairs",
    ja: "別経路の階段",
  },
  elevator: {
    en: "Alternative elevator",
    ja: "別経路のエレベーター",
  },
  floorPlan: {
    en: "floor plan",
    ja: "フロア図",
  },
} as const;

export function cameraPhaseForStep(stepId: StoryStepId): CameraPhase {
  switch (stepId) {
    case "pull-back":
      return "pull-back";
    case "floor-change":
      return "floor-change";
    case "settle-1f":
      return "settle";
    default:
      return "close";
  }
}

function scenePhaseClass(stepId: StoryStepId): string {
  switch (stepId) {
    case "walk-b1":
    case "walk-1f":
      return "navigation-scene--walking";
    case "connector":
      return "navigation-scene--connector";
    case "pull-back":
      return "navigation-scene--pull-back";
    case "floor-change":
      return "navigation-scene--floor-change";
    case "settle-1f":
      return "navigation-scene--settle";
    case "complete":
      return "navigation-scene--complete";
    case "ready":
      return "navigation-scene--ready";
  }
}

export function NavigationIcon({ name }: { name: NavigationIconName }): ReactElement {
  let glyph: ReactNode = null;

  switch (name) {
    case "play":
      glyph = <path d="m9 7 8 5-8 5Z" />;
      break;
    case "pause":
      glyph = (
        <>
          <path d="M9 7v10" />
          <path d="M15 7v10" />
        </>
      );
      break;
    case "overview":
      glyph = (
        <>
          <path d="m12 4 8 4-8 4-8-4Z" />
          <path d="m4 13 8 4 8-4" />
          <path d="m4 17 8 4 8-4" />
        </>
      );
      break;
    case "replay":
      glyph = (
        <>
          <path d="M5 8V4l-3 3 3 3Z" />
          <path d="M5 7a8 8 0 1 1-1 8" />
        </>
      );
      break;
    case "restart":
      glyph = (
        <>
          <path d="M4 4v5h5" />
          <path d="M5.5 15a8 8 0 1 0 .7-7.7L4 9" />
        </>
      );
      break;
    case "route":
      glyph = (
        <>
          <circle cx="6" cy="17" r="2" />
          <circle cx="18" cy="7" r="2" />
          <path d="M8 17h3a3 3 0 0 0 3-3v-4a3 3 0 0 1 3-3" />
        </>
      );
      break;
  }

  return (
    <svg
      className="navigation-icon"
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
      {glyph}
    </svg>
  );
}

function ConnectorSymbols({ locale }: { locale: PrototypeLocale }): ReactElement {
  return (
    <g className="navigation-floor__connectors">
      <g
        className="navigation-floor__connector navigation-floor__connector--selected"
        transform="translate(552 166)"
        role="img"
        aria-label={SCENE_COPY.escalator[locale]}
      >
        <rect width="86" height="86" rx="12" />
        <path d="M17 63h14l27-36h12" />
        <path d="M26 55h10M34 47h10M42 39h10M50 31h10" />
        <path d="m62 18 8 9-8 9" />
        <text x="43" y="78" textAnchor="middle">
          {locale === "ja" ? "エスカレーター" : "Escalator"}
        </text>
      </g>

      <g
        className="navigation-floor__connector navigation-floor__connector--alternative"
        transform="translate(658 166)"
        role="img"
        aria-label={SCENE_COPY.stairs[locale]}
      >
        <rect width="70" height="62" rx="10" />
        <path d="M14 43h11V34h11v-9h11v-9h10" />
        <text x="35" y="56" textAnchor="middle">
          {locale === "ja" ? "階段" : "Stairs"}
        </text>
      </g>

      <g
        className="navigation-floor__connector navigation-floor__connector--alternative"
        transform="translate(658 246)"
        role="img"
        aria-label={SCENE_COPY.elevator[locale]}
      >
        <rect width="70" height="62" rx="10" />
        <rect x="18" y="12" width="34" height="34" rx="3" />
        <path d="m29 22 6-6 6 6M29 36l6 6 6-6" />
        <text x="35" y="56" textAnchor="middle">
          {locale === "ja" ? "EV" : "Lift"}
        </text>
      </g>
    </g>
  );
}

function FloorPlate({
  floor,
  locale,
  transform,
  routeFloor,
}: {
  floor: FloorId;
  locale: PrototypeLocale;
  transform: string;
  routeFloor: FloorId;
}): ReactElement {
  const isB1 = floor === "B1";
  const routePath = isB1
    ? "M90 344H250c42 0 56-28 82-58l72-76h190"
    : "M166 210h164c42 0 58-18 82-46l48-54h188";

  return (
    <g
      className={
        floor === routeFloor
          ? "navigation-floor navigation-floor--route"
          : "navigation-floor navigation-floor--context"
      }
      data-floor={floor}
      transform={transform}
      role="img"
      aria-label={`${floor} ${SCENE_COPY.floorPlan[locale]}`}
    >
      <rect className="navigation-floor__plate" x="0" y="0" width="760" height="430" rx="20" />
      <path className="navigation-floor__wall" d="M28 28h704v82H610v42H150v-42H28Z" />
      <path className="navigation-floor__wall" d="M28 320h126v82H28ZM606 320h126v82H606Z" />
      <rect className="navigation-floor__room" x="174" y="32" width="146" height="74" rx="8" />
      <rect className="navigation-floor__room" x="344" y="32" width="238" height="74" rx="8" />
      <rect className="navigation-floor__room" x="176" y="324" width="170" height="74" rx="8" />
      <rect className="navigation-floor__room" x="370" y="324" width="212" height="74" rx="8" />
      <path className="navigation-floor__corridor" d="M52 132h656v166H52Z" />
      <path className="navigation-floor__route-shadow" d={routePath} pathLength="1" />
      <path className="navigation-floor__route" d={routePath} pathLength="1" />

      <text className="navigation-floor__label" x="52" y="72">
        {floor}
      </text>
      <text className="navigation-floor__place-label" x="246" y="76" textAnchor="middle">
        {isB1 ? SCENE_COPY.southConcourse[locale] : SCENE_COPY.eastAtrium[locale]}
      </text>

      {isB1 ? (
        <g className="navigation-floor__marker navigation-floor__marker--start" transform="translate(90 344)">
          <circle r="14" />
          <circle r="5" />
          <text x="0" y="32" textAnchor="middle">
            {SCENE_COPY.start[locale]}
          </text>
        </g>
      ) : (
        <g
          className="navigation-floor__marker navigation-floor__marker--destination"
          transform="translate(648 110)"
        >
          <path d="M0-16 15-1 0 14-15-1Z" />
          <circle cy="-1" r="5" />
          <text x="0" y="34" textAnchor="end">
            {SCENE_COPY.destination[locale]}
          </text>
        </g>
      )}

      <ConnectorSymbols locale={locale} />
    </g>
  );
}

export function NavigationScene({
  step,
  viewFloor,
  overviewOpen,
  reducedMotion,
  locale,
}: NavigationSceneProps): ReactElement {
  const sceneClass = [
    "navigation-scene",
    scenePhaseClass(step.id),
    `navigation-scene--step-${step.id}`,
    overviewOpen ? "navigation-scene--overview" : "navigation-scene--single-floor",
    reducedMotion ? "navigation-scene--reduced-motion" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <figure
      className={sceneClass}
      data-camera-phase={cameraPhaseForStep(step.id)}
      data-view-floor={viewFloor}
      data-route-floor={step.floor}
    >
      <svg
        className="navigation-scene__svg"
        viewBox="0 0 960 620"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-labelledby="navigation-scene-title navigation-scene-description"
      >
        <title id="navigation-scene-title">{SCENE_COPY.title[locale]}</title>
        <desc id="navigation-scene-description">{SCENE_COPY.description[locale]}</desc>

        {overviewOpen ? (
          <>
            <FloorPlate
              floor="1F"
              locale={locale}
              routeFloor={step.floor}
              transform="translate(416 42) scale(.62)"
            />
            <path
              className="navigation-scene__floor-change-path"
              d="M574 286c-14 56-36 78-72 104s-58 54-66 104"
            />
            <circle className="navigation-scene__floor-change-node" cx="574" cy="286" r="8" />
            <circle className="navigation-scene__floor-change-node" cx="436" cy="494" r="8" />
            <FloorPlate
              floor="B1"
              locale={locale}
              routeFloor={step.floor}
              transform="translate(48 310) scale(.62)"
            />
          </>
        ) : (
          <FloorPlate
            floor={viewFloor}
            locale={locale}
            routeFloor={step.floor}
            transform="translate(100 95)"
          />
        )}
      </svg>
      <figcaption className="navigation-scene__caption">{SCENE_COPY.prototypeData[locale]}</figcaption>
    </figure>
  );
}
