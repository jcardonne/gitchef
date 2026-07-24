// Lightweight persistence for recents + the open-tab session, backed by the
// webview's localStorage. Pure frontend - no backend round-trips.

import type { TabColor } from "./types";

const RECENTS_KEY = "gitchef.recents";
const SESSION_KEY = "gitchef.session";
const VIEW_KEY = "gitchef.changesView";
const MAX_RECENTS = 20;

export type ChangesView = "list" | "tree";

export function getChangesView(): ChangesView {
  return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "tree";
}

export function setChangesView(view: ChangesView): void {
  localStorage.setItem(VIEW_KEY, view);
}

const SIDEBAR_KEY = "gitchef.sidebarGroups";

/// Expanded/collapsed state of the sidebar sections.
export interface SidebarGroups {
  local: boolean;
  remote: boolean;
  remotes: boolean;
  pullRequests: boolean;
  tags: boolean;
  worktrees: boolean;
  submodules: boolean;
  stashes: boolean;
}

/// Defaults merged over any stored value, so sections added after a user's
/// prefs were first written still default to open instead of undefined/closed.
export function getSidebarGroups(): SidebarGroups {
  return {
    local: true,
    remote: true,
    remotes: true,
    pullRequests: true,
    tags: true,
    worktrees: true,
    submodules: true,
    stashes: true,
    ...read<Partial<SidebarGroups>>(SIDEBAR_KEY, {}),
  };
}

export function setSidebarGroups(groups: SidebarGroups): void {
  localStorage.setItem(SIDEBAR_KEY, JSON.stringify(groups));
}

const COLS_KEY = "gitchef.graphCols";
const COL_VISIBILITY_KEY = "gitchef.graphColumnVisibility";
const SORT_KEY = "gitchef.graphSortAsc";
const RIGHT_PANEL_KEY = "gitchef.rightPanelWidth";

/// User overrides for the graph's resizable column widths (px). `graph` is legacy
/// (the lane column is now auto-sized to lane depth); `refs` is the branch/tag
/// column left of the lanes.
export interface GraphCols {
  graph?: number;
  refs?: number;
  author?: number;
  sha?: number;
  date?: number;
}

export function getGraphCols(): GraphCols {
  return read<GraphCols>(COLS_KEY, {});
}
export function setGraphCols(cols: GraphCols): void {
  localStorage.setItem(COLS_KEY, JSON.stringify(cols));
}

export interface GraphColumnVisibility {
  refs: boolean;
  graph: boolean;
  message: boolean;
  author: boolean;
  sha: boolean;
  date: boolean;
}

const DEFAULT_GRAPH_COLUMN_VISIBILITY: GraphColumnVisibility = {
  refs: true,
  graph: true,
  message: true,
  author: true,
  sha: true,
  date: true,
};

export function getGraphColumnVisibility(): GraphColumnVisibility {
  return { ...DEFAULT_GRAPH_COLUMN_VISIBILITY, ...read<Partial<GraphColumnVisibility>>(COL_VISIBILITY_KEY, {}) };
}
export function setGraphColumnVisibility(visibility: GraphColumnVisibility): void {
  localStorage.setItem(COL_VISIBILITY_KEY, JSON.stringify(visibility));
}

const PULL_KEY = "gitchef.pullDefault";

/// Default action of the Pull split-button.
export type PullAction = "fetch" | "ff" | "ff-only" | "rebase";

export function getPullDefault(): PullAction {
  const v = localStorage.getItem(PULL_KEY);
  return v === "fetch" || v === "ff-only" || v === "rebase" ? v : "ff";
}
/// Broadcast that a persisted preference changed so already-mounted views can
/// re-read it. Guarded for the non-DOM (vitest) environment.
export function notifyPrefs(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("gitchef:prefs"));
}

export function setPullDefault(action: PullAction): void {
  localStorage.setItem(PULL_KEY, action);
  notifyPrefs();
}

/// Graph sort direction: false = newest first (default), true = oldest first.
export function getSortAsc(): boolean {
  return localStorage.getItem(SORT_KEY) === "1";
}
export function setSortAsc(asc: boolean): void {
  localStorage.setItem(SORT_KEY, asc ? "1" : "0");
  notifyPrefs();
}

export function getRightPanelWidth(): number {
  return read<number>(RIGHT_PANEL_KEY, 440);
}
export function setRightPanelWidth(width: number): void {
  localStorage.setItem(RIGHT_PANEL_KEY, JSON.stringify(width));
}

const FETCH_INTERVAL_KEY = "gitchef.fetchIntervalMinutes";

/// Minutes between background auto-fetches for the active repo; 0 = disabled.
/// Defaults to 5 (safe on GitHub/GitLab: only the active+visible tab fetches, and
/// backgroundFetch backs off on a rate-limit). Users who explicitly picked "Off"
/// have 0 stored, so this default only affects those who never touched it.
export function getFetchIntervalMinutes(): number {
  return read<number>(FETCH_INTERVAL_KEY, 5);
}
export function setFetchIntervalMinutes(minutes: number): void {
  localStorage.setItem(FETCH_INTERVAL_KEY, JSON.stringify(minutes));
  notifyPrefs();
}

const CLONE_DIR_KEY = "gitchef.cloneDir";

/// Last parent folder a repo was cloned into, so the clone dialog pre-fills it.
export function getCloneDir(): string {
  return localStorage.getItem(CLONE_DIR_KEY) ?? "";
}
export function setCloneDir(dir: string): void {
  localStorage.setItem(CLONE_DIR_KEY, dir);
}

export interface RecentRepo {
  path: string;
  name: string;
  lastOpened: number;
}

/// Repo paths open last session + which one was focused, so launch can restore.
export interface Session {
  paths: string[];
  activePath: string | null; // null = the Home tab was focused
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function getRecents(): RecentRepo[] {
  const list = read<unknown>(RECENTS_KEY, []);
  if (!Array.isArray(list)) return [];
  return list.filter((r): r is RecentRepo => !!r && typeof (r as RecentRepo).path === "string");
}

export function addRecent(repo: { path: string; name: string }): void {
  const list = getRecents().filter((r) => r.path !== repo.path);
  list.unshift({ ...repo, lastOpened: Date.now() });
  localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, MAX_RECENTS)));
}

export function removeRecent(path: string): void {
  const list = getRecents().filter((r) => r.path !== path);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(list));
}

/// Shape-checked, not just cast: App restores the session in a useState
/// initializer (`session.paths.map(...)`), so a value written by an older schema
/// or a truncated write would throw on the very first render - a permanently
/// blank window, because the effect that would overwrite the bad value never
/// gets to run. Anything unexpected degrades to "no session".
export function getSession(): Session {
  const s = read<Partial<Session>>(SESSION_KEY, {});
  const paths = Array.isArray(s?.paths) ? s.paths.filter((p) => typeof p === "string") : [];
  // activePath must name one of the restored tabs. App hides the Home tab
  // whenever it is non-null, so an activePath with no matching tab renders a
  // blank window on launch.
  const activePath = typeof s?.activePath === "string" && paths.includes(s.activePath)
    ? s.activePath
    : null;
  return { paths, activePath };
}

export function saveSession(session: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

/// Last path segment of a folder path - the tab label before the repo loads.
export function basename(path: string): string {
  return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || path;
}

const TAB_COLORS_KEY = "gitchef.tabColors";

/// Per-repo tab colors keyed by repo path, so a color survives close/reopen and
/// relaunch (tabs are restored by path). An absent path means no color.
export function getTabColors(): Record<string, TabColor> {
  return read<Record<string, TabColor>>(TAB_COLORS_KEY, {});
}

/// Assign (color) or clear (null) a tab's color and persist the change.
export function setTabColor(path: string, color: TabColor | null): void {
  const colors = getTabColors();
  if (color) colors[path] = color;
  else delete colors[path];
  localStorage.setItem(TAB_COLORS_KEY, JSON.stringify(colors));
}
