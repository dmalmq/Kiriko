/**
 * The neutral conveyance form (#32).
 *
 * The JIS Z 8210 set Kiriko draws its conveyance pictograms from has no ramp
 * pictogram, so a ramp had no badge at all — the one conveyance a wheelchair
 * user most needs to find was the one the map declined to mark. Rather than
 * borrowing a pictogram that means something else, a ramp gets the neutral
 * form the visual language specifies: an inclined plane with one static slope
 * chevron, drawn in the same weight as the traced pictograms so it reads as
 * part of the same set rather than as a placeholder.
 *
 * Static by design: nothing in the scene animates a conveyance (#32's motion
 * rules), so the chevron states direction without implying movement.
 */

/** Inline SVG for the neutral inclined plane, sized like the JIS pictograms. */
export function rampGlyph(): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14"',
    ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"',
    ' stroke-linejoin="round" aria-hidden="true">',
    // The inclined plane: ground line, then the slope rising to the right.
    '<path d="M3 19h18" />',
    '<path d="M4 19 18 7" />',
    // One slope chevron, pointing up the incline.
    '<path d="M11 10.5 14.5 7 11 3.5" />',
    "</svg>",
  ].join("");
}
