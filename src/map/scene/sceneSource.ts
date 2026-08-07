/**
 * Which source is rendering, and how the viewer moves between them (#30
 * section 5).
 *
 * The state holds exactly one active source, which is the type-level form of
 * the rule that matters most: Kiriko never crossfades two independently fitted
 * sources, and no frame may contain geometry from both. A swap covers the
 * canvas with a brief canvas-coloured veil, replaces the source, and updates
 * the badge — it never dissolves one into the other.
 *
 * Fallback is one-way. A quality fallback — the floor is unmet, the scene
 * failed to load, the reviewer chose 2D — stays put until the reviewer asks for
 * 3D again, because a view that silently oscillates is worse than a view that
 * is merely simpler. A *lost context* is different: it is transient, and #26's
 * recovery mechanism is to re-establish the view when it returns. That
 * recovery is bounded, so a GPU that keeps dying settles on the view that
 * works instead of thrashing.
 *
 * Nothing here touches route, floor, or selection. That is deliberate: those
 * live in the app's own state, so a source swap cannot lose them.
 */

/**
 * Sources the viewer can render. `tiles` joins in Stage 3 and enters the same
 * ladder above `generated`; the machine is written so that arrival adds a
 * source rather than a second machine.
 */
export type SceneSourceId = "generated" | "fallback2d";

export type FallbackReason =
  /** The device does not meet the capability floor. */
  | "capability_unmet"
  /** The scene could not be compiled, decoded, or uploaded. */
  | "load_failed"
  /** The GL context was lost. */
  | "context_lost"
  /** The reviewer chose the 2D view. */
  | "user_choice";

/**
 * Automatic recoveries a session may spend. Bounded so a failing GPU cannot
 * put the reviewer in a loop of losing and re-establishing the scene.
 */
export const MAX_3D_RETRIES = 2;

export interface SceneSourceState {
  active: SceneSourceId;
  /** Why 2D is showing; `null` when 3D renders, or when it was never asked for. */
  reason: FallbackReason | null;
  retriesLeft: number;
  /** A swap is in progress and the canvas is veiled. Never a crossfade. */
  veil: boolean;
  /** Whether 3D was requested at all — a 2D-only session is not a fallback. */
  requested: boolean;
  /** Whether the device meets the floor; a retry cannot conjure capability. */
  capable: boolean;
}

export type SceneSourceEvent =
  | { type: "scene_ready" }
  | { type: "capability_unmet" }
  | { type: "load_failed" }
  | { type: "context_lost" }
  | { type: "context_restored" }
  | { type: "user_chose_2d" }
  | { type: "retry_requested" }
  | { type: "veil_finished" };

export interface SceneSourceOptions {
  /** Reduced motion replaces the source immediately, with no veil (#32). */
  reducedMotion: boolean;
}

export function initialSceneSource(
  options: SceneSourceOptions & { requested: boolean; capabilitySupported: boolean },
): SceneSourceState {
  const base = {
    retriesLeft: MAX_3D_RETRIES,
    // Nothing has been replaced yet, so there is nothing to veil.
    veil: false,
    requested: options.requested,
    capable: options.capabilitySupported,
  };
  if (!options.requested) {
    return { ...base, active: "fallback2d", reason: null };
  }
  if (!options.capabilitySupported) {
    return { ...base, active: "fallback2d", reason: "capability_unmet" };
  }
  return { ...base, active: "generated", reason: null };
}

export function reduceSceneSource(
  state: SceneSourceState,
  event: SceneSourceEvent,
  options: SceneSourceOptions,
): SceneSourceState {
  switch (event.type) {
    case "scene_ready":
      // Confirmation, not a transition: a source already fell back stays there.
      return state;

    case "veil_finished":
      return state.veil ? { ...state, veil: false } : state;

    case "capability_unmet":
      return fallBack(state, "capability_unmet", options);

    case "load_failed":
      return fallBack(state, "load_failed", options);

    case "context_lost":
      return fallBack(state, "context_lost", options);

    case "context_restored": {
      // Only a lost context recovers on its own, and only while the budget
      // lasts. Any other reason waits for the reviewer.
      if (state.active !== "fallback2d" || state.reason !== "context_lost") {
        return state;
      }
      if (state.retriesLeft <= 0 || !state.capable) {
        return state;
      }
      return {
        ...state,
        active: "generated",
        reason: null,
        retriesLeft: state.retriesLeft - 1,
        veil: !options.reducedMotion,
      };
    }

    case "user_chose_2d":
      return fallBack(state, "user_choice", options);

    case "retry_requested": {
      if (state.active === "generated" || !state.capable || state.retriesLeft <= 0) {
        // A device that cannot render 3D is not offered a retry that would
        // veil the canvas and land back on 2D.
        return state;
      }
      return {
        ...state,
        active: "generated",
        reason: null,
        retriesLeft: state.retriesLeft - 1,
        veil: !options.reducedMotion,
      };
    }
  }
}

function fallBack(
  state: SceneSourceState,
  reason: FallbackReason,
  options: SceneSourceOptions,
): SceneSourceState {
  if (state.active === "fallback2d") {
    // Already there. Re-reporting the same condition must not re-veil the
    // canvas or overwrite the reason that first explained it.
    return state;
  }
  return {
    ...state,
    active: "fallback2d",
    reason,
    veil: !options.reducedMotion,
  };
}

export interface SourceProvenance {
  badge: { ja: string; en: string };
  provenance: { ja: string; en: string };
}

/**
 * The quiet source badge and its one provenance line (#32). The line states
 * what is rendering — never a source that is not.
 */
export function sourceProvenance(state: SceneSourceState): SourceProvenance {
  if (state.active === "generated") {
    return {
      badge: { ja: "生成3D", en: "Generated 3D" },
      provenance: {
        ja: "Kiriko生成 · 根拠に基づく近似",
        en: "Kiriko generated · evidence-backed approximation",
      },
    };
  }
  return {
    badge: { ja: "2D", en: "2D" },
    provenance: { ja: "共通2D表示", en: "Universal 2D fallback" },
  };
}

/** Why 2D is showing, in both languages; `null` when nothing fell back. */
export function fallbackNotice(state: SceneSourceState): { ja: string; en: string } | null {
  if (state.active !== "fallback2d" || state.reason === null) {
    return null;
  }
  switch (state.reason) {
    case "capability_unmet":
      return {
        ja: "この端末では3D表示を利用できません。2D表示で続けます。",
        en: "3D is unavailable on this device. Continuing in 2D.",
      };
    case "load_failed":
      return {
        ja: "3Dシーンを読み込めませんでした。2D表示で続けます。",
        en: "The 3D scene could not be loaded. Continuing in 2D.",
      };
    case "context_lost":
      return {
        ja: "3D表示が中断されました。2D表示で続けます。",
        en: "3D rendering was interrupted. Continuing in 2D.",
      };
    case "user_choice":
      return { ja: "2D表示で続けます。", en: "Continuing in 2D." };
  }
}

/** Whether a retry is worth offering: capability exists and budget remains. */
export function canRetry3d(state: SceneSourceState): boolean {
  return state.active === "fallback2d" && state.capable && state.retriesLeft > 0;
}
