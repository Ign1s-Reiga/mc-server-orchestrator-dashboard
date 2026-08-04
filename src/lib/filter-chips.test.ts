import { describe, expect, it } from 'vitest';
import { filterChips } from './filter-chips';
import type { DisplayState } from './api/types';

/**
 * The "no frontend release" guarantee, from the dashboard's side.
 *
 * §10 serves `displayState` so a badge added to `:api` reaches these filters
 * with no change here. `:api` pins that it advertises the value and that
 * `?state=DEGRADED` selects on it; this pins the other half — that the chip
 * actually appears once a server is in that state.
 */

/** Exactly what a live `:api` served, in its order. */
const SERVED: DisplayState[] = [
  'PENDING',
  'STARTING',
  'RUNNING',
  'READY',
  'DEGRADED',
  'DRAINING',
  'TERMINATING',
  'STOPPING',
  'STOPPED',
  'FAILED',
  'UNREADABLE',
  'UNKNOWN',
];

describe('fleet filter chips', () => {
  it('offers DEGRADED as soon as a server is in it, with no code change here', () => {
    const chips = filterChips(SERVED, new Map([['READY', 3], ['DEGRADED', 1]]));
    expect(chips).toEqual(['READY', 'DEGRADED']);
  });

  it('offers UNREADABLE the same way', () => {
    const chips = filterChips(SERVED, new Map([['UNREADABLE', 2]]));
    expect(chips).toContain('UNREADABLE');
  });

  it('orders chips by the served list, not by arrival', () => {
    // `present` is built by iterating servers, so its key order is arbitrary.
    // The bar should still read the way the API ranks its badges.
    const chips = filterChips(
      SERVED,
      new Map([['UNKNOWN', 1], ['READY', 5], ['PENDING', 2], ['DEGRADED', 1]]),
    );
    expect(chips).toEqual(['PENDING', 'READY', 'DEGRADED', 'UNKNOWN']);
  });

  it('omits states nothing is in', () => {
    expect(filterChips(SERVED, new Map([['READY', 1]]))).toEqual(['READY']);
  });

  it('still offers a state this build has never heard of', () => {
    // The API is ahead of this bundle. The badge renders regardless, so it has
    // to be filterable — otherwise it is the one state you can see and cannot
    // isolate.
    const future = 'QUARANTINED' as DisplayState;
    const chips = filterChips(SERVED, new Map([['READY', 1], [future, 1]]));
    expect(chips).toEqual(['READY', future]);
  });
});
