/**
 * What the renderer draws, in what order, and how visibly — the decisions that
 * are policy rather than plumbing, kept out of the GL layer so they can be
 * tested without a GPU.
 *
 * The palette and the ceiling rule come from the Architectural Cutaway visual
 * language (#32). Paint order and depth bias come from a property of indoor
 * data: it is full of coplanar surfaces — a level's floor plate under its unit
 * finishes, a doorway inside the wall it pierces — and equal depth values make
 * which surface wins a coin flip. Order plus a fraction of a depth unit
 * resolves it deterministically.
 */
import type { SemanticRoleName } from "./sceneFormat";

/**
 * The semantic palette: warm white navigable surfaces, cool stone structure.
 * A source material never reaches normal navigation, and generated geometry is
 * never tinted to look inferior — both sources render from this one table.
 */
export const ROLE_COLORS: Record<SemanticRoleName, readonly [number, number, number]> = {
  Walkable: [0.98, 0.98, 0.976],
  Public: [0.914, 0.929, 0.957],
  Service: [0.941, 0.922, 0.878],
  Restricted: [0.835, 0.855, 0.891],
  Structure: [0.835, 0.855, 0.891],
  Ceiling: [0.835, 0.855, 0.891],
  Opening: [0.604, 0.639, 0.698],
  // Conveyance shells share the cool structure family and separate by value,
  // not by a new hue: #32 keeps Ai Indigo for interaction and reserves amber
  // for review. Kind identity is carried by the pictogram and the direction
  // chevron; the tint only keeps two adjacent forms from merging into one mass.
  Elevator: [0.718, 0.757, 0.839],
  Escalator: [0.663, 0.714, 0.808],
  Stairs: [0.773, 0.804, 0.871],
  Ramp: [0.824, 0.847, 0.902],
  Context: [0.835, 0.855, 0.891],
  // An untyped conveyance never borrows a kind the source never stated.
  Conveyance: [0.741, 0.773, 0.835],
};

/** Lower paints first. Coplanar surfaces rely on this being total per role. */
export const ROLE_PAINT_ORDER: Record<SemanticRoleName, number> = {
  // Contextual mass first: the plate everything else sits on.
  Context: 0,
  // Occupiable finishes on top of the plate.
  Public: 1,
  Service: 1,
  Restricted: 1,
  Walkable: 2,
  // Conveyances read as surfaces you can take, above the finishes.
  Elevator: 3,
  Escalator: 3,
  Stairs: 3,
  Ramp: 3,
  Conveyance: 3,
  // Vertical structure, then the openings that pierce it.
  Structure: 4,
  Opening: 5,
  Ceiling: 6,
};

/**
 * Vertical separation in millimetres, applied at render time to coplanar
 * geometry that a depth bias alone cannot separate.
 *
 * A depth-buffer bias is measured in depth units, so its effect shrinks as the
 * camera pulls back and precision degrades — at venue-wide zoom the floor plate
 * and the unit finishes on it start trading pixels again. A separation in world
 * space does not care about the camera: one centimetre is far more than the
 * depth buffer's resolution at indoor distances, and far less than anything a
 * reviewer can see. The pick pass keeps reporting the surface's true position,
 * so this never becomes a coordinate anyone reads.
 */
export const ROLE_VERTICAL_NUDGE_MM: Record<SemanticRoleName, number> = {
  // The plate sits a centimetre under the finishes it carries.
  Context: -10,
  Public: 0,
  Service: 0,
  Restricted: 0,
  Walkable: 0,
  Elevator: 0,
  Escalator: 0,
  Stairs: 0,
  Ramp: 0,
  Conveyance: 0,
  Structure: 0,
  Opening: 0,
  Ceiling: 0,
};

/** Depth-buffer bias in units: positive pushes away from the camera. */
export const ROLE_DEPTH_BIAS: Record<SemanticRoleName, number> = {
  Context: 4,
  Public: 0,
  Service: 0,
  Restricted: 0,
  Walkable: 0,
  Elevator: 0,
  Escalator: 0,
  Stairs: 0,
  Ramp: 0,
  Conveyance: 0,
  Structure: 0,
  Opening: -4,
  Ceiling: 0,
};

/**
 * The active floor's classified ceilings are hidden so the space below is
 * legible (#32 section 6). The rest of the ceiling and occlusion policy —
 * adjacent-floor context during handoff, protected-corridor fade — lands with
 * the visual language slice.
 */
const HIDDEN_ROLES_ON_ACTIVE_LEVEL: Record<string, true> = { Ceiling: true };

/** Adjacent floors, when shown as context, stay quiet enough to read past. */
export const CONTEXT_LEVEL_OPACITY = 0.22;

/**
 * A protected-corridor occluder fades to this when it would obstruct what the
 * reviewer is looking at (#32 section 6). Nothing else in the scene is
 * dissolved for the camera: a wall stays a wall.
 */
export const OCCLUDER_FADE_OPACITY = 0.15;

/**
 * The higher floor of a retained route pair renders at this opacity — #32
 * section 6's route-floor band, applied by elevation rather than by selection.
 *
 * A cross-floor connection is only legible if the floor above it is see-through:
 * with both floors drawn by selection alone, an active floor sitting above its
 * route partner hid the connector and the whole floor below it. The lower floor
 * of the pair keeps full semantic opacity, so the reviewer reads the connection
 * against solid geometry rather than against two ghosts.
 */
export const UPPER_FLOOR_OPACITY = 0.25;

/**
 * A conveyance shell renders at this opacity, always.
 *
 * The shell is a neutral volume standing in for machinery the source never
 * described (#19), and it is the one form whose whole purpose is to say that a
 * route leaves the floor here. Drawn opaque it hid the graph inside it, which
 * is the question the reviewer opened 3D to answer. It stays a visible form —
 * both faces blend, so a shell still reads as a volume — without becoming the
 * lid on its own evidence.
 */
export const CONVEYANCE_SHELL_OPACITY = 0.3;

/**
 * A portal renders at this opacity, always.
 *
 * A portal is the evidence that a boundary can be passed, and #32 section 9
 * draws it as a gap or threshold edge — a closed leaf only where the source
 * states one, which the generated scene never does. Drawn opaque, the portals
 * standing at a conveyance's boundary became the solid box the shell had just
 * stopped being.
 */
export const OPENING_THRESHOLD_OPACITY = 0.2;

/**
 * The inter-floor connector's own colour: the network overlay's magenta, so the
 * edge between two floors reads as the same graph the 2D review view draws.
 * A selected connector switches to Ai Indigo — #32 allows exactly one
 * interaction hue and no second one here.
 */
export const CONNECTOR_COLOR: readonly [number, number, number] = [0.847, 0.106, 0.549];

/**
 * Ribbon widths in CSS pixels. Visual widths match the 2D network overlay
 * (`indoor-network-path` 1.5 / selected 3). The pick pass uses a wider
 * invisible hit, same idea as `indoor-network-path-hit` (12px), because GPU
 * picking is exact per-pixel.
 */
export const CONNECTOR_WIDTH_PX = 1.5;
export const CONNECTOR_SELECTED_WIDTH_PX = 3;
export const CONNECTOR_HIT_WIDTH_PX = 12;

/**
 * How long adjacent floors stay visible as context when the floor changes —
 * inside #32's 140–180 ms motion window. Long enough to see where the floor
 * you left went, short enough that it is not a state you sit in.
 */
export const CONTEXT_HANDOFF_MS = 160;

/** Roles classified as protected-corridor occluders (#32's fade set). */
const PROTECTED_CORRIDOR_ROLES: Record<string, true> = { Ceiling: true };

/** Transport forms: the roles whose shells must never hide the graph inside. */
const CONVEYANCE_ROLES: Record<string, true> = {
  Elevator: true,
  Escalator: true,
  Stairs: true,
  Ramp: true,
  Conveyance: true,
};

export interface BatchVisibility {
  levelIndex: number;
  role: SemanticRoleName;
}

export interface VisibilityState {
  /**
   * Every scene level the active canonical floor renders. A floor maps to one
   * or more composite source levels (#31), and the reviewer selected the floor
   * — not one of the source documents it happens to be exported from.
   */
  activeLevelIndices: readonly number[];
  /** Registered levels for the one route floor retained as quiet context. */
  contextLevelIndices: readonly number[];
  showContextLevels: boolean;
  /**
   * Resolved plane per scene level, venue-local metres, indexed as
   * `scene.levels`. Elevation decides which floor of a retained pair is the one
   * being looked through; an index this array does not answer for carries no
   * ordering, and the pair falls back to the selection-keyed treatment rather
   * than inventing one.
   */
  levelPlanesM: readonly number[];
}

/** One level's plane in millimetres, or `null` when the scene carries none. */
function planeMillimetres(state: VisibilityState, levelIndex: number): number | null {
  const plane = state.levelPlanesM[levelIndex];
  if (plane === undefined || !Number.isFinite(plane)) {
    return null;
  }
  return Math.round(plane * 1000);
}

/**
 * The lowest plane among the retained pair, or `null` when any member of it has
 * no plane — one unknown member means the stack order is unknown, and a guessed
 * order would silently pick which floor to look through.
 */
function lowestPairPlaneMm(state: VisibilityState): number | null {
  let lowest: number | null = null;
  // Deliberately two loops over the two index lists: this runs per batch per
  // frame, so it must not allocate a joined array to iterate.
  for (const index of state.activeLevelIndices) {
    const mm = planeMillimetres(state, index);
    if (mm === null) return null;
    lowest = lowest === null || mm < lowest ? mm : lowest;
  }
  for (const index of state.contextLevelIndices) {
    const mm = planeMillimetres(state, index);
    if (mm === null) return null;
    lowest = lowest === null || mm < lowest ? mm : lowest;
  }
  return lowest;
}

/**
 * How visible one level is: hidden, full, the see-through treatment given to
 * the higher floor of a retained pair, or quiet context.
 */
function levelOpacity(levelIndex: number, state: VisibilityState): number {
  const active = state.activeLevelIndices.includes(levelIndex);
  const paired = state.contextLevelIndices.includes(levelIndex);
  if (!active && !paired && !state.showContextLevels) {
    return 0;
  }
  if (state.contextLevelIndices.length > 0 && (active || paired)) {
    const lowest = lowestPairPlaneMm(state);
    const mine = planeMillimetres(state, levelIndex);
    if (lowest !== null && mine !== null) {
      return mine <= lowest ? 1 : UPPER_FLOOR_OPACITY;
    }
  }
  return active ? 1 : CONTEXT_LEVEL_OPACITY;
}

/**
 * How visible one batch is under the current floor selection. `0` means the
 * batch is not drawn at all, which is also what keeps the draw-call budget a
 * per-floor number rather than a per-venue one.
 */
export function batchOpacity(batch: BatchVisibility, state: VisibilityState): number {
  const floor = levelOpacity(batch.levelIndex, state);
  if (floor === 0) {
    return 0;
  }
  if (
    Object.hasOwn(HIDDEN_ROLES_ON_ACTIVE_LEVEL, batch.role) &&
    state.activeLevelIndices.includes(batch.levelIndex)
  ) {
    return 0;
  }
  // Nothing is ever drawn more solidly than the floor carrying it, so a fade
  // set can only ever quieten a surface further.
  if (Object.hasOwn(PROTECTED_CORRIDOR_ROLES, batch.role)) {
    return Math.min(floor, OCCLUDER_FADE_OPACITY);
  }
  if (Object.hasOwn(CONVEYANCE_ROLES, batch.role)) {
    return Math.min(floor, CONVEYANCE_SHELL_OPACITY);
  }
  if (batch.role === "Opening") {
    return Math.min(floor, OPENING_THRESHOLD_OPACITY);
  }
  return floor;
}

/**
 * Whether a batch may answer a click. See-through is a state treatment, not
 * absence: a conveyance shell and the floor being looked through are both
 * still the active floor, and both stay selectable. A hidden batch and a
 * context floor never intercept a click — a retained route floor is reference,
 * not a target, and a hidden ceiling must not stand in front of the room below
 * it.
 */
export function batchPickable(batch: BatchVisibility, state: VisibilityState): boolean {
  return (
    state.activeLevelIndices.includes(batch.levelIndex) && batchOpacity(batch, state) > 0
  );
}

export interface PlannedBatch<T extends BatchVisibility> {
  batch: T;
  opacity: number;
}

/**
 * Split the scene into the two passes a blended frame needs.
 *
 * Solid geometry draws first and owns the depth buffer. See-through geometry
 * draws after it, bottom floor first: the camera never goes under the model, so
 * ascending elevation is back-to-front, and a translucent surface that wrote
 * depth — or drew before the floor beneath it — would erase exactly the floor
 * the reviewer is looking through it to see.
 */
export function planSceneDraw<T extends BatchVisibility>(
  batches: readonly T[],
  state: VisibilityState,
): { opaque: PlannedBatch<T>[]; translucent: PlannedBatch<T>[] } {
  const opaque: PlannedBatch<T>[] = [];
  const translucent: PlannedBatch<T>[] = [];
  for (const batch of batches) {
    const opacity = batchOpacity(batch, state);
    if (opacity <= 0) {
      continue;
    }
    (opacity >= 1 ? opaque : translucent).push({ batch, opacity });
  }
  translucent.sort((left, right) => {
    // A level with no plane sorts to the back: it cannot be shown to be in
    // front of anything, so it must not paint over geometry that can.
    const leftPlane = planeMillimetres(state, left.batch.levelIndex) ?? Number.NEGATIVE_INFINITY;
    const rightPlane = planeMillimetres(state, right.batch.levelIndex) ?? Number.NEGATIVE_INFINITY;
    return (
      leftPlane - rightPlane ||
      ROLE_PAINT_ORDER[left.batch.role] - ROLE_PAINT_ORDER[right.batch.role]
    );
  });
  return { opaque, translucent };
}
