/**
 * Reading the persisted GDB plan that re-publish paths carry forward.
 *
 * Shared because every path that creates a version from an existing one has to
 * honour the same stored choices, and a second copy of this reader is a second
 * chance to get a venue's clip behaviour wrong.
 */

/**
 * Read `clipToSelection` off a persisted `versions.gdb_plan_json`.
 *
 * Re-publish paths carry the base version's stored plan forward into the new
 * version row, but the row is not what the compiler reads — `publish.ts`
 * destructures the *job payload*. Any path that means to honour the original
 * building-scoped clip choice must lift it out of the stored plan and put it
 * in the payload explicitly.
 *
 * Anything that is not a plan object carrying a literal `true` means no
 * clipping: IMDF-sourced versions have no plan at all (`null`), and a plan
 * written before this flag existed simply omits it.
 */
export function storedPlanClipsToSelection(planJson: string | null): boolean {
  if (planJson === null) return false;
  try {
    const parsed: unknown = JSON.parse(planJson);
    if (typeof parsed !== "object" || parsed === null || !("clipToSelection" in parsed)) {
      return false;
    }
    return parsed.clipToSelection === true;
  } catch {
    return false;
  }
}
