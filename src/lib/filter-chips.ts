import type { DisplayState } from './api/types';

/**
 * Which state chips the fleet filter bar offers, and in what order.
 *
 * The vocabulary comes from `meta.enums.displayState` (§10), which is served
 * precisely so a badge added to `:api` reaches a dashboard's filters with no
 * frontend release — `DEGRADED` and `UNREADABLE` arrived exactly that way.
 *
 * Two rules:
 *
 * - **Order follows the served list**, so the bar reads the same way the API
 *   ranks its badges rather than in whatever order servers happened to arrive.
 * - **Only states actually present get a chip.** A filter that selects nothing
 *   is not worth the width, and an operator scanning the bar is reading it as a
 *   summary of the fleet as much as a set of controls.
 *
 * A state that is present but *not* in the served list still gets a chip,
 * appended. That is the case where this build is older than the API: the badge
 * renders, so it must be filterable, or it would be the one state you could see
 * and not isolate.
 */
export function filterChips(
  known: readonly DisplayState[],
  present: ReadonlyMap<DisplayState, number>,
): DisplayState[] {
  const inOrder = known.filter((state) => present.has(state));
  const unknown = [...present.keys()].filter((state) => !known.includes(state));
  return [...inOrder, ...unknown];
}
