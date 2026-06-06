// Lightweight persistence for recents + the open-tab session, backed by the
// webview's localStorage. Pure frontend - no backend round-trips.

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

/// Expanded/collapsed state of the sidebar's Local / Remote / Tags sections.
export interface SidebarGroups {
  local: boolean;
  remote: boolean;
  tags: boolean;
}

export function getSidebarGroups(): SidebarGroups {
  return read<SidebarGroups>(SIDEBAR_KEY, { local: true, remote: true, tags: true });
}

export function setSidebarGroups(groups: SidebarGroups): void {
  localStorage.setItem(SIDEBAR_KEY, JSON.stringify(groups));
}

const COLS_KEY = "gitchef.graphCols";
const SORT_KEY = "gitchef.graphSortAsc";

/// User overrides for the graph's resizable column widths (px).
export interface GraphCols {
  graph?: number;
  author?: number;
}

export function getGraphCols(): GraphCols {
  return read<GraphCols>(COLS_KEY, {});
}
export function setGraphCols(cols: GraphCols): void {
  localStorage.setItem(COLS_KEY, JSON.stringify(cols));
}

const PULL_KEY = "gitchef.pullDefault";

/// Default action of the Pull split-button.
export type PullAction = "fetch" | "ff" | "ff-only" | "rebase";

export function getPullDefault(): PullAction {
  const v = localStorage.getItem(PULL_KEY);
  return v === "fetch" || v === "ff-only" || v === "rebase" ? v : "ff";
}
export function setPullDefault(action: PullAction): void {
  localStorage.setItem(PULL_KEY, action);
}

/// Graph sort direction: false = newest first (default), true = oldest first.
export function getSortAsc(): boolean {
  return localStorage.getItem(SORT_KEY) === "1";
}
export function setSortAsc(asc: boolean): void {
  localStorage.setItem(SORT_KEY, asc ? "1" : "0");
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
  return read<RecentRepo[]>(RECENTS_KEY, []);
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

export function getSession(): Session {
  return read<Session>(SESSION_KEY, { paths: [], activePath: null });
}

export function saveSession(session: Session): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

/// Last path segment of a folder path - the tab label before the repo loads.
export function basename(path: string): string {
  return path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || path;
}
