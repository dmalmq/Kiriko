export type StoryStepId =
  | "ready"
  | "walk-b1"
  | "connector"
  | "pull-back"
  | "floor-change"
  | "settle-1f"
  | "walk-1f"
  | "complete";

export type FloorId = "B1" | "1F";
export type VariantId = "guided" | "rail" | "scrubber";
export type PlaybackState = "ready" | "playing" | "paused" | "complete";
export type PrototypeLocale = "en" | "ja";

export interface LocalizedText {
  en: string;
  ja: string;
}

export interface StoryStep {
  id: StoryStepId;
  floor: FloorId;
  durationMs: number;
  instruction: LocalizedText;
  detail: LocalizedText;
  distanceM: number;
}

export const STORY_STEPS: readonly StoryStep[] = [
  {
    id: "ready",
    floor: "B1",
    durationMs: 1_800,
    instruction: {
      en: "Route ready",
      ja: "ルートの準備ができました",
    },
    detail: {
      en: "Start on B1 near the south entrance.",
      ja: "地下1階の南口付近から出発します。",
    },
    distanceM: 0,
  },
  {
    id: "walk-b1",
    floor: "B1",
    durationMs: 3_200,
    instruction: {
      en: "Walk straight for 24 m",
      ja: "24メートル直進します",
    },
    detail: {
      en: "Pass the information counter on your right.",
      ja: "右手の案内カウンターを通過します。",
    },
    distanceM: 24,
  },
  {
    id: "connector",
    floor: "B1",
    durationMs: 2_600,
    instruction: {
      en: "Take the escalator to 1F",
      ja: "エスカレーターで1階へ上がります",
    },
    detail: {
      en: "The escalator is ahead on the left.",
      ja: "前方左手にエスカレーターがあります。",
    },
    distanceM: 8,
  },
  {
    id: "pull-back",
    floor: "B1",
    durationMs: 2_000,
    instruction: {
      en: "Following the floor change",
      ja: "フロア移動を追跡します",
    },
    detail: {
      en: "Pulling back to keep both levels in context.",
      ja: "両方のフロアが見えるように視点を引きます。",
    },
    distanceM: 0,
  },
  {
    id: "floor-change",
    floor: "1F",
    durationMs: 2_400,
    instruction: {
      en: "Moving up to 1F",
      ja: "1階へ移動しています",
    },
    detail: {
      en: "The route continues from the top of the escalator.",
      ja: "エスカレーターを上がった先からルートが続きます。",
    },
    distanceM: 0,
  },
  {
    id: "settle-1f",
    floor: "1F",
    durationMs: 1_800,
    instruction: {
      en: "Continue on 1F",
      ja: "1階で案内を続けます",
    },
    detail: {
      en: "Turn right after leaving the escalator.",
      ja: "エスカレーターを降りたら右へ曲がります。",
    },
    distanceM: 4,
  },
  {
    id: "walk-1f",
    floor: "1F",
    durationMs: 3_000,
    instruction: {
      en: "Walk straight for 18 m",
      ja: "18メートル直進します",
    },
    detail: {
      en: "Your destination is beside the east atrium.",
      ja: "目的地は東側アトリウムの隣です。",
    },
    distanceM: 18,
  },
  {
    id: "complete",
    floor: "1F",
    durationMs: 1_800,
    instruction: {
      en: "You have arrived",
      ja: "目的地に到着しました",
    },
    detail: {
      en: "The destination is on your left.",
      ja: "目的地は左手にあります。",
    },
    distanceM: 0,
  },
];

export const VARIANT_LABELS: Readonly<Record<VariantId, LocalizedText>> = {
  guided: {
    en: "Guided transition",
    ja: "ガイド付き切り替え",
  },
  rail: {
    en: "Step rail",
    ja: "ステップレール",
  },
  scrubber: {
    en: "Route scrubber",
    ja: "ルートスクラバー",
  },
};

export function stepFloor(step: StoryStep): FloorId {
  return step.floor;
}
