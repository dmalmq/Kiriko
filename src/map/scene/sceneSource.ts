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
 * Sources the viewer can render, in ladder order: an activated 3D Tiles
 * package, the generated scene every published version retains, and the
 * universal 2D view.
 */
export type SceneSourceId = "tiles" | "generated" | "fallback2d";


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

/**
 * Automatic attempts at the tile scene. One: a package that will not start is
 * usually a package, not a blip, and the venue's generated scene is right
 * there.
 */
export const MAX_TILE_RETRIES = 1;

export interface SceneSourceState {
  active: SceneSourceId;
  /** Why 2D is showing; `null` when 3D renders, or when it was never asked for. */
  reason: FallbackReason | null;
  retriesLeft: number;
  /** Attempts left at the tile scene before it is given up for this session. */
  tileRetriesLeft: number;
  /** A swap is in progress and the canvas is veiled. Never a crossfade. */
  veil: boolean;
  /** Whether 3D was requested at all — a 2D-only session is not a fallback. */
  requested: boolean;
  /** Whether the device meets the floor; a retry cannot conjure capability. */
  capable: boolean;
  /**
   * The rung this state fell from, when it fell one rung rather than to 2D.
   * `null` when nothing was given up — a venue with no package rendering its
   * generated scene has lost nothing and is told nothing.
   */
  droppedFrom: SceneSourceId | null;
}

export type SceneSourceEvent =
  | { type: "scene_ready" }
  /** The version's activated package answered: its document is loadable. */
  | { type: "tiles_ready" }
  | { type: "capability_unmet" }
  | { type: "load_failed" }
  | { type: "context_lost" }
  | { type: "context_restored" }
  | { type: "user_chose_2d" }
  /** The reviewer asked for 3D — from the toggle, not a recovery. */
  | { type: "user_chose_3d" }
  | { type: "retry_requested" }
  | { type: "veil_finished" };

export interface SceneSourceOptions {
  /** Reduced motion replaces the source immediately, with no veil (#32). */
  reducedMotion: boolean;
}

export function initialSceneSource(
  options: SceneSourceOptions & {
    requested: boolean;
    capabilitySupported: boolean;
    /** Whether this version has an activated tile package to render. */
    tilesAvailable?: boolean;
  },
): SceneSourceState {
  const base = {
    retriesLeft: MAX_3D_RETRIES,
    tileRetriesLeft: MAX_TILE_RETRIES,
    // Nothing has been replaced yet, so there is nothing to veil.
    veil: false,
    droppedFrom: null,
    requested: options.requested,
    capable: options.capabilitySupported,
  };
  if (!options.requested) {
    return { ...base, active: "fallback2d", reason: null };
  }
  if (!options.capabilitySupported) {
    return { ...base, active: "fallback2d", reason: "capability_unmet" };
  }
  return {
    ...base,
    active: options.tilesAvailable === true ? "tiles" : "generated",
    reason: null,
  };
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

    case "tiles_ready":
      // Availability is learned by asking for the document, so this arrives
      // after the machine has already settled on the generated scene. It only
      // climbs from there, and never back over a tile scene already given up.
      if (state.active !== "generated" || state.droppedFrom !== null) {
        return state;
      }
      return { ...state, active: "tiles", reason: null };

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

    case "user_chose_3d": {
      // A deliberate ask, so it spends no retry budget: that budget bounds
      // *automatic* recoveries, and a toggle that stopped working after two
      // uses would be a bug. `requested` latches on, which is what turns the
      // provenance badge and any later fallback notice back on.
      if (!state.capable) {
        // Answer honestly rather than entering a state nothing can draw. The
        // toggle is hidden on such a device, so this is the defensive path.
        return { ...state, requested: true, active: "fallback2d", reason: "capability_unmet" };
      }
      if (state.active !== "fallback2d") {
        return state.requested ? state : { ...state, requested: true };
      }
      // The generated scene is the rung every published version retains, so an
      // explicit ask lands there; the tile document climbs from it when the
      // version has one and it has not already been given up this session.
      return {
        ...state,
        requested: true,
        active: "generated",
        reason: null,
        veil: !options.reducedMotion,
      };
    }

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
  // A tile scene that will not load costs one rung, not the whole ladder: the
  // venue always retains a generated scene (#30 section 1), and dropping past
  // it would discard 3D this device can render. A lost context is different —
  // the next rung needs the same GPU, so it would fail again immediately.
  if (state.active === "tiles" && reason === "load_failed" && state.tileRetriesLeft > 0) {
    return {
      ...state,
      active: "generated",
      reason: null,
      droppedFrom: "tiles",
      tileRetriesLeft: state.tileRetriesLeft - 1,
      veil: !options.reducedMotion,
    };
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
  if (state.active === "tiles") {
    return {
      badge: { ja: "3D Tiles", en: "3D Tiles" },
      provenance: {
        ja: "3D Tiles · 制作元の詳細形状",
        en: "3D Tiles · source-authored detail",
      },
    };
  }
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

/**
 * What was given up and why, in both languages; `null` when nothing was.
 *
 * Covers both kinds of loss: the whole 3D view falling to 2D, and the detailed
 * scene falling one rung to the generated one. A reviewer who was looking at
 * source-authored geometry a moment ago is owed the second explanation as much
 * as the first.
 */
export function fallbackNotice(state: SceneSourceState): { ja: string; en: string } | null {
  if (state.active === "generated" && state.droppedFrom === "tiles") {
    return {
      ja: "詳細な3Dシーンを読み込めませんでした。生成3Dで続けます。",
      en: "The detailed 3D scene could not be loaded. Continuing with the generated scene.",
    };
  }
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
      // Nothing was given up: the reviewer asked for this, the badge already
      // says 2D, and the toggle offers the way back. Narrating a choice back at
      // the person who made it, beside a control that undoes it, is noise.
      return null;
  }
}

/** Whether a retry is worth offering: capability exists and budget remains. */
export function canRetry3d(state: SceneSourceState): boolean {
  return state.active === "fallback2d" && state.capable && state.retriesLeft > 0;
}
