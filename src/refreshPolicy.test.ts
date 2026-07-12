import { describe, it, expect } from "vitest";
import {
  shouldBackgroundFetch,
  shouldHandleRepoChange,
  shouldRefreshPrs,
  extendBackoff,
} from "./refreshPolicy";

const MIN = 60_000;
const baseFetch = { minutes: 5, online: true, now: 100 * MIN, lastFetch: 0, backoffUntil: 0 };

describe("shouldBackgroundFetch", () => {
  it("fires when on, online, past backoff, and an interval has elapsed", () => {
    expect(shouldBackgroundFetch(baseFetch)).toBe(true);
  });
  it("is off when auto-fetch is disabled (minutes 0)", () => {
    expect(shouldBackgroundFetch({ ...baseFetch, minutes: 0 })).toBe(false);
  });
  it("skips while offline", () => {
    expect(shouldBackgroundFetch({ ...baseFetch, online: false })).toBe(false);
  });
  it("skips inside a rate-limit backoff window", () => {
    expect(shouldBackgroundFetch({ ...baseFetch, backoffUntil: 200 * MIN })).toBe(false);
  });
  it("skips when the last fetch was under one interval ago (shared throttle)", () => {
    // 4 minutes since last fetch, interval is 5 -> too soon.
    expect(shouldBackgroundFetch({ ...baseFetch, lastFetch: 96 * MIN })).toBe(false);
    // exactly 5 minutes -> allowed.
    expect(shouldBackgroundFetch({ ...baseFetch, lastFetch: 95 * MIN })).toBe(true);
  });
});

const baseChange = { matchesPath: true, busy: false, now: 10_000, lastOpAt: 0, graceMs: 700, hidden: false };

describe("shouldHandleRepoChange", () => {
  it("refreshes for our repo when idle and visible", () => {
    expect(shouldHandleRepoChange(baseChange)).toBe(true);
  });
  it("ignores events for a different repo path", () => {
    expect(shouldHandleRepoChange({ ...baseChange, matchesPath: false })).toBe(false);
  });
  it("skips while our own op is in flight", () => {
    expect(shouldHandleRepoChange({ ...baseChange, busy: true })).toBe(false);
  });
  it("skips our own write echo inside the grace window", () => {
    expect(shouldHandleRepoChange({ ...baseChange, now: 900, lastOpAt: 500 })).toBe(false); // 400ms < 700
    expect(shouldHandleRepoChange({ ...baseChange, now: 1300, lastOpAt: 500 })).toBe(true); // 800ms > 700
  });
  it("skips while the window is hidden", () => {
    expect(shouldHandleRepoChange({ ...baseChange, hidden: true })).toBe(false);
  });
});

describe("shouldRefreshPrs", () => {
  it("lists once the interval has elapsed since the last listing", () => {
    expect(shouldRefreshPrs(30 * MIN, 10 * MIN, 15 * MIN)).toBe(true); // 20min >= 15
    expect(shouldRefreshPrs(25 * MIN, 10 * MIN, 15 * MIN)).toBe(true); // 15min == 15
  });
  it("suppresses a re-list before the interval elapses", () => {
    expect(shouldRefreshPrs(20 * MIN, 10 * MIN, 15 * MIN)).toBe(false); // 10min < 15
  });
});

describe("extendBackoff", () => {
  it("enters backoff and reports the fresh entry", () => {
    const r = extendBackoff(0, 1000, 5000);
    expect(r).toEqual({ until: 6000, enteredNow: true });
  });
  it("extends an active window forward without re-entering", () => {
    // current window ends at 10000, now 6000 (inside it), add 5000 -> 11000, not fresh
    const r = extendBackoff(10_000, 6000, 5000);
    expect(r).toEqual({ until: 11_000, enteredNow: false });
  });
  it("never shortens an active window", () => {
    const r = extendBackoff(10_000, 6000, 1000); // now+add = 7000 < 10000
    expect(r.until).toBe(10_000);
  });
});
