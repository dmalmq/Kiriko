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
  Elevator: [0.835, 0.855, 0.891],
  Escalator: [0.835, 0.855, 0.891],
  Stairs: [0.835, 0.855, 0.891],
  Ramp: [0.835, 0.855, 0.891],
  Context: [0.835, 0.855, 0.891],
  Conveyance: [0.835, 0.855, 0.891],
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

export interface BatchVisibility {
  levelIndex: number;
  role: SemanticRoleName;
}

export interface VisibilityState {
  activeLevelIndex: number;
  showContextLevels: boolean;
}

/**
 * How visible one batch is under the current floor selection. `0` means the
 * batch is not drawn at all, which is also what keeps the draw-call budget a
 * per-floor number rather than a per-venue one.
 */
export function batchOpacity(batch: BatchVisibility, state: VisibilityState): number {
  if (batch.levelIndex === state.activeLevelIndex) {
    return Object.hasOwn(HIDDEN_ROLES_ON_ACTIVE_LEVEL, batch.role) ? 0 : 1;
  }
  return state.showContextLevels ? CONTEXT_LEVEL_OPACITY : 0;
}
