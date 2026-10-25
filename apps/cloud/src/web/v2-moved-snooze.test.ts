import { describe, expect, it } from "@effect/vitest";

import {
  isV2MovedSnoozed,
  snoozeV2Moved,
  V2_MOVED_DISMISS_SNOOZE_MS,
  V2_MOVED_FEEDBACK_SNOOZE_MS,
  v2MovedSnoozeKey,
  type SnoozeStorage,
} from "./v2-moved-snooze";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const ORG = "org_example";
const OTHER_ORG = "org_other";

const memoryStorage = (): SnoozeStorage & { readonly items: Map<string, string> } => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
  };
};

/** Storage that throws on every access, like a disabled localStorage. */
const throwingStorage: SnoozeStorage = {
  getItem: () => {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- fixture: disabled localStorage throws a DOMException
    throw new Error("SecurityError");
  },
  setItem: () => {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- fixture: disabled localStorage throws a DOMException
    throw new Error("SecurityError");
  },
};

describe("v2 moved notice snooze", () => {
  it("snoozes for 7 days on dismissal and 30 days after feedback", () => {
    expect(V2_MOVED_DISMISS_SNOOZE_MS).toBe(7 * DAY_MS);
    expect(V2_MOVED_FEEDBACK_SNOOZE_MS).toBe(30 * DAY_MS);
  });

  it("shows the notice until it is snoozed, and again once the snooze ends", () => {
    const storage = memoryStorage();
    expect(isV2MovedSnoozed(storage, ORG, NOW)).toBe(false);

    snoozeV2Moved(storage, ORG, NOW, V2_MOVED_DISMISS_SNOOZE_MS);
    expect(isV2MovedSnoozed(storage, ORG, NOW)).toBe(true);
    expect(isV2MovedSnoozed(storage, ORG, NOW + 7 * DAY_MS - 1)).toBe(true);
    expect(isV2MovedSnoozed(storage, ORG, NOW + 7 * DAY_MS)).toBe(false);
  });

  it("snoozes one organization at a time", () => {
    const storage = memoryStorage();
    snoozeV2Moved(storage, ORG, NOW, V2_MOVED_FEEDBACK_SNOOZE_MS);
    expect(isV2MovedSnoozed(storage, ORG, NOW + 29 * DAY_MS)).toBe(true);
    expect(isV2MovedSnoozed(storage, OTHER_ORG, NOW)).toBe(false);
    expect([...storage.items.keys()]).toEqual([v2MovedSnoozeKey(ORG)]);
  });

  it("shows the notice when the stored value is unreadable", () => {
    const storage = memoryStorage();
    storage.setItem(v2MovedSnoozeKey(ORG), "not a number");
    expect(isV2MovedSnoozed(storage, ORG, NOW)).toBe(false);
  });

  it("shows the notice without storage, and never throws", () => {
    expect(isV2MovedSnoozed(null, ORG, NOW)).toBe(false);
    expect(isV2MovedSnoozed(throwingStorage, ORG, NOW)).toBe(false);
    expect(() => snoozeV2Moved(null, ORG, NOW, V2_MOVED_DISMISS_SNOOZE_MS)).not.toThrow();
    expect(() =>
      snoozeV2Moved(throwingStorage, ORG, NOW, V2_MOVED_DISMISS_SNOOZE_MS),
    ).not.toThrow();
  });
});
