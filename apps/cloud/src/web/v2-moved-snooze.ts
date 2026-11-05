// ---------------------------------------------------------------------------
// How long the "moved to Executor v2" notice stays hidden once answered, per
// browser and per organization. Stored in localStorage as the epoch
// millisecond the snooze ends; a missing, unreadable, or past value shows the
// notice again.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** Closing the notice, or opening v2 from it: a quiet "not now". */
export const V2_MOVED_DISMISS_SNOOZE_MS = 7 * DAY_MS;
/** Telling us why they are staying on v1: they answered, so ask less often. */
export const V2_MOVED_FEEDBACK_SNOOZE_MS = 30 * DAY_MS;

/** The part of `Storage` the snooze uses. */
export interface SnoozeStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

export const v2MovedSnoozeKey = (organizationId: string): string =>
  `executor.v2MovedNotice.snoozedUntil.${organizationId}`;

/** Whether the notice is hidden for this organization at `now`. */
export const isV2MovedSnoozed = (
  storage: SnoozeStorage | null,
  organizationId: string,
  now: number,
): boolean => {
  if (storage === null) return false;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: localStorage can throw (private mode / disabled storage)
  try {
    const until = Number(storage.getItem(v2MovedSnoozeKey(organizationId)));
    return Number.isFinite(until) && until > now;
  } catch {
    return false;
  }
};

/** Hide the notice for this organization until `now + durationMs`. */
export const snoozeV2Moved = (
  storage: SnoozeStorage | null,
  organizationId: string,
  now: number,
  durationMs: number,
): void => {
  if (storage === null) return;
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: localStorage can throw (private mode / disabled storage)
  try {
    storage.setItem(v2MovedSnoozeKey(organizationId), String(now + durationMs));
  } catch {
    // Best effort: without storage the notice returns on the next visit.
  }
};

/** The browser's localStorage, or `null` during SSR or where it is disabled. */
export const browserSnoozeStorage = (): SnoozeStorage | null => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: reading localStorage throws where storage is disabled
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};
