export interface Clock {
  now(): Date;
}

/**
 * A clock whose readings are strictly increasing, even when called twice within the
 * same millisecond. This guarantees that every edit or transition changes `updatedAt`
 * and that `createdAt` never ties, so newest-first ordering is deterministic.
 *
 * `source` is injectable so the clock can be driven from a fixed time.
 */
export function createMonotonicClock(source: () => number = Date.now): Clock {
  let last = Number.NEGATIVE_INFINITY;
  return {
    now(): Date {
      last = Math.max(source(), last + 1);
      return new Date(last);
    },
  };
}
