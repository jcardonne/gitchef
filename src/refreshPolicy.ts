/// Pure decision logic for RepoView's background-refresh wiring. Kept out of the
/// component so the gnarly "should this fire?" conditions are unit-testable
/// without rendering: the component supplies live values (Date.now(), refs,
/// navigator.onLine) and acts on the boolean; the rules live here.

export interface BackgroundFetchState {
  /** Configured auto-fetch interval in minutes; 0 = disabled. */
  minutes: number;
  online: boolean;
  now: number;
  /** Epoch ms of the last background fetch (shared by interval + focus). */
  lastFetch: number;
  /** Epoch ms until which a rate-limit backoff pauses background network. */
  backoffUntil: number;
}

/// Tolerance on the "one interval has passed" test. The timer period and this
/// throttle are the same value, so a fetch that landed slightly off the tick -
/// which the focus path does on every tab activation - would leave the next tick
/// a few hundred ms short, skip it, and silently double the effective period
/// (a 5-minute setting fetching every 10). Well under the 1-minute minimum.
const INTERVAL_SLACK_MS = 5_000;

/// Whether a background fetch should fire now: auto-fetch on, online, not inside a
/// rate-limit backoff, and at least one interval since the last fetch (so the
/// interval tick and a focus refresh share one throttle instead of double-firing).
export function shouldBackgroundFetch(s: BackgroundFetchState): boolean {
  return (
    s.minutes > 0 &&
    s.online &&
    s.now >= s.backoffUntil &&
    s.now - s.lastFetch >= s.minutes * 60_000 - INTERVAL_SLACK_MS
  );
}

export interface RepoChangeState {
  /** The `repo-changed` event was for the tab's own repo path. */
  matchesPath: boolean;
  /** One of our own git ops is in flight (it refreshes itself). */
  busy: boolean;
  now: number;
  /** Epoch ms our last own op settled. */
  lastOpAt: number;
  /** Grace window after an op, to skip its debounced write echo. */
  graceMs: number;
  hidden: boolean;
}

/// Whether a filesystem `repo-changed` event should trigger a live refresh: it's
/// our repo, no op of ours is in flight or just settled (its own writes echo via
/// the watcher ~400ms later), and the window is visible (focus covers the hidden
/// case).
export function shouldHandleRepoChange(s: RepoChangeState): boolean {
  return s.matchesPath && !s.busy && s.now - s.lastOpAt >= s.graceMs && !s.hidden;
}

/// Whether the background loop should re-list PRs/MRs: only once per `everyMs`,
/// since that spawns a gh/glab subprocess + hits the API bucket, unlike the fetch.
export function shouldRefreshPrs(now: number, lastPrAt: number, everyMs: number): boolean {
  return now - lastPrAt >= everyMs;
}

/// Extend a rate-limit backoff window forward (never shorten it), reporting whether
/// this is a fresh entry into backoff (was not already active) - so the caller
/// toasts once on entry, not on every subsequent throttled hit.
export function extendBackoff(
  current: number,
  now: number,
  addMs: number
): { until: number; enteredNow: boolean } {
  return { until: Math.max(current, now + addMs), enteredNow: now >= current };
}
