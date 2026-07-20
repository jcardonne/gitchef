import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CheckMenuItem, Menu } from "@tauri-apps/api/menu";
import type { CommitNode, RefKind, RefLabel, WorkStats } from "../types";
import { avatarUrl, type AvatarContext, edgePath, LANE_COLORS, laneColor, relativeTime } from "../util";
import { BranchIcon, HeadIcon, LocalIcon, RemoteIcon, StashIcon, TagIcon } from "../icons";
import {
  getGraphColumnVisibility,
  getGraphCols,
  getSortAsc,
  setGraphColumnVisibility,
  setGraphCols,
  setSortAsc,
  type GraphColumnVisibility,
} from "../storage";

function readRowH(): number {
  const v = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--row-h"), 10);
  return Number.isFinite(v) && v > 0 ? v : 48;
}
const LANE_W = 20;
const DOT_R = 6;
const AVATAR_R = 10; // committer avatar disc radius (~20px, fits one lane); also drives the author-column avatar size via --avatar-d
const PAD_X = 14;
const OVERSCAN = 8; // rows kept mounted above/below the viewport
/// The graph's toggleable columns, in header order. Exported as the single
/// source of truth: Settings renders the same list, and when it kept its own
/// copy the two drifted - `refs` was missing there entirely (so hiding it from
/// the header menu made it unrestorable) and `graph` was mislabelled.
export const GRAPH_COLUMNS: { key: keyof GraphColumnVisibility; label: string }[] = [
  { key: "refs", label: "Branch / Tag" },
  { key: "graph", label: "Graph" },
  { key: "message", label: "Message" },
  { key: "author", label: "Author" },
  { key: "sha", label: "SHA" },
  { key: "date", label: "Date" },
];
const REFS_W_DEFAULT = 180; // branch/tag column, resizable

/// Snappy eased scroll (easeOutCubic) to `to`. Fixed short duration so far jumps
/// stay quick. Returns a cancel fn; respects prefers-reduced-motion by jumping.
function animateScrollTop(el: HTMLElement, to: number, duration = 320): () => void {
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const from = el.scrollTop;
  const dist = to - from;
  if (reduce || Math.abs(dist) < 2) {
    el.scrollTop = to;
    return () => {};
  }
  let raf = 0;
  const start = performance.now();
  const ease = (t: number) => 1 - Math.pow(1 - t, 3);
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    el.scrollTop = from + dist * ease(t);
    if (t < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

/// Scroll offset that centers row `i` in the scroll container. Computed from row
/// geometry (not the row's DOM node) so it works even when the row is virtualized
/// out. Shared by the search-match and sidebar-reveal scrolls.
function centerRowScrollTop(sc: HTMLElement, g: HTMLElement, i: number, offset: number, rowH: number): number {
  const gTop = g.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
  return gTop + (i + offset) * rowH + rowH / 2 - sc.clientHeight / 2;
}

interface Props {
  nodes: CommitNode[];
  /// The checked-out branch name (authoritative `branch.is_head()`), or null when
  /// detached. Drives the "current" fill by NAME, so two branches sharing the HEAD
  /// commit don't both light up.
  headBranch: string | null;
  selectedId: string | null;
  /// A request to scroll a commit into view (from the sidebar). `seq` bumps so
  /// the same id can be revealed again.
  reveal: { id: string; seq: number } | null;
  onSelect: (id: string) => void;
  onCommitMenu: (node: CommitNode) => void;
  onBranchMenu: (branchName: string, isRemote: boolean, targetSha: string) => void;
  onTagMenu: (tagName: string, targetSha: string) => void;
  workStats: WorkStats | null;
  dirtyFiles: number;
  workActive: boolean;
  onSelectWork: () => void;
  onWorkMenu: () => void;
  searchOpen: boolean;
  onSearchClose: () => void;
  canLoadMore: boolean;
  onLoadMore: () => void;
  avatarCtx: AvatarContext;
  /// Branch names (short) with an open PR/MR - their badge shows the fork icon.
  prBranches: ReadonlySet<string>;
}

/// Renders the commit DAG: an SVG of lanes/edges/dots on the left, aligned
/// row-for-row with commit text on the right. Both use the same ROW_H so the
/// dot always sits next to its message. When there are uncommitted changes, a
/// "WIP" node is drawn one row above HEAD (like GitKraken).
export default function GraphView({
  nodes,
  headBranch,
  selectedId,
  reveal,
  onSelect,
  onCommitMenu,
  onBranchMenu,
  onTagMenu,
  workStats,
  dirtyFiles,
  workActive,
  onSelectWork,
  onWorkMenu,
  searchOpen,
  onSearchClose,
  canLoadMore,
  onLoadMore,
  avatarCtx,
  prBranches,
}: Props) {
  // Resizable column widths (persisted) + sort direction.
  const [cols, setCols] = useState(getGraphCols);
  useEffect(() => setGraphCols(cols), [cols]);
  const [visibleCols, setVisibleCols] = useState(getGraphColumnVisibility);
  useEffect(() => setGraphColumnVisibility(visibleCols), [visibleCols]);
  const [sortAsc, setSortAscState] = useState(getSortAsc);
  const toggleSort = () => {
    const next = !sortAsc;
    setSortAscState(next);
    setSortAsc(next);
  };
  const [ROW_H, setRowH] = useState(readRowH);
  useEffect(() => {
    const sync = () => {
      setRowH(readRowH());
      setSortAscState(getSortAsc());
      setVisibleCols(getGraphColumnVisibility());
    };
    window.addEventListener("gitchef:prefs", sync);
    return () => window.removeEventListener("gitchef:prefs", sync);
  }, []);

  // Display order: newest-first by default, reversed for "oldest first". Lanes
  // (x) are order-independent, so reversing rows just flips the DAG vertically.
  const ordered = useMemo(() => (sortAsc ? [...nodes].reverse() : nodes), [nodes, sortAsc]);

  // --- commit search (Cmd/Ctrl+F) ---
  const [query, setQuery] = useState("");
  const [filterMode, setFilterMode] = useState(false);
  const [matchIdx, setMatchIdx] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const lastScrolled = useRef<string | null>(null);

  useEffect(() => {
    if (searchOpen) searchInput.current?.focus();
  }, [searchOpen]);
  useEffect(() => setMatchIdx(0), [query]);

  const matchSet = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return null;
    const s = new Set<string>();
    for (const n of ordered) {
      const hay = `${n.author} ${n.email} ${n.id} ${n.message}`.toLowerCase();
      if (terms.every((t) => hay.includes(t))) s.add(n.id);
    }
    return s;
  }, [ordered, query]);
  const matchList = useMemo(
    () => (matchSet ? ordered.filter((n) => matchSet.has(n.id)) : []),
    [ordered, matchSet]
  );
  // Clamp on read: a background fetch or "Load more" rebuilds matchList, and if
  // it shrank, the stale index would render a counter past the end ("7/3") and
  // leave currentMatchId null, so Enter would jump to the wrong row.
  const safeIdx = Math.min(matchIdx, Math.max(0, matchList.length - 1));
  const currentMatchId = matchList[safeIdx]?.id ?? null;
  const step = (d: number) =>
    matchList.length && setMatchIdx((i) => (Math.min(i, matchList.length - 1) + d + matchList.length) % matchList.length);
  const closeSearch = () => onSearchClose();

  // Closing search (Esc / ✕) clears the query + filter, stopping highlighting.
  useEffect(() => {
    if (!searchOpen) {
      setQuery("");
      setFilterMode(false);
    }
  }, [searchOpen]);

  // When filtering, only matching commits are rendered (graph holes accepted).
  const filtering = filterMode && !!matchSet;
  const displayed = filtering ? matchList : ordered;
  const index = useMemo(() => {
    const m = new Map<string, number>();
    displayed.forEach((n, i) => m.set(n.id, i));
    return m;
  }, [displayed]);

  // Resolve each unique committer's avatar (GitHub / GitLab / Gravatar per the
  // repo's provider; cached in util).
  const [avatars, setAvatars] = useState<Map<string, string>>(new Map());
  // Resolved URLs that failed to load (e.g. a renamed account behind the legacy
  // no-reply .png redirect); the row shows a colored initial instead of a broken
  // <img>. The SVG dot already degrades to its lane-colored backdrop.
  const [failedAvatars, setFailedAvatars] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    const emails = [...new Set(nodes.map((n) => n.email).filter(Boolean))];
    Promise.all(emails.map(async (e) => [e, await avatarUrl(e, avatarCtx)] as const)).then(
      (pairs) => {
        if (!alive) return;
        // Warm the browser cache so dots + row avatars don't pop in on first paint.
        for (const [, url] of pairs) new Image().src = url;
        setAvatars(new Map(pairs));
      }
    );
    return () => {
      alive = false;
    };
  }, [nodes, avatarCtx]);

  // First-parent chain from any commit: walk parents[0] until it leaves the
  // loaded set. This is the "commits that belong to this branch" definition,
  // reused for both the auto spine (A) and hover tracing (B).
  const chainFrom = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    return (startId: string | null) => {
      const set = new Set<string>();
      let cur = startId ? byId.get(startId) ?? null : null;
      while (cur && !set.has(cur.id)) {
        set.add(cur.id);
        cur = cur.parents.length ? byId.get(cur.parents[0]) ?? null : null;
      }
      return set;
    };
  }, [nodes]);

  // The commit carrying the HEAD ref anchors the default (current-branch) spine.
  const headId = useMemo(
    () => nodes.find((n) => n.refs.some((r) => r.kind === "head"))?.id ?? null,
    [nodes]
  );

  // Which branch each commit "belongs to", so a hovered row with no ref badge can
  // show it. Tips are ordered current-branch, then locals, then remotes.
  //   Pass 1 (first-parent chains): the branch that *introduced* the commit - the
  //   specific answer for a commit on a branch's own mainline.
  //   Pass 2 (full ancestry, all parents): fills anything left - e.g. commits
  //   merged in from a branch whose tip is gone, which are reachable from a branch
  //   only through a merge's second parent. A shared `seen` set keeps it O(V+E).
  const branchByCommit = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const label = new Map<string, { name: string; kind: "branch" | "remote" }>();
    const tips: { id: string; name: string; kind: "branch" | "remote"; prio: number }[] = [];
    for (const n of nodes) {
      const isHead = n.refs.some((r) => r.kind === "head");
      for (const r of n.refs) {
        if (r.kind === "branch") tips.push({ id: n.id, name: r.name, kind: "branch", prio: isHead ? 0 : 1 });
        else if (r.kind === "remote") tips.push({ id: n.id, name: r.name, kind: "remote", prio: 2 });
      }
    }
    tips.sort((a, b) => a.prio - b.prio);
    // Pass 1: first-parent introducer chain.
    for (const tip of tips) {
      let cur: CommitNode | undefined = byId.get(tip.id);
      while (cur && !label.has(cur.id)) {
        label.set(cur.id, { name: tip.name, kind: tip.kind });
        cur = cur.parents.length ? byId.get(cur.parents[0]) : undefined;
      }
    }
    // Pass 2: full ancestry fill (containing branch), shared `seen` = O(V+E).
    const seen = new Set<string>();
    for (const tip of tips) {
      const stack = [tip.id];
      while (stack.length) {
        const id = stack.pop() as string;
        if (seen.has(id)) continue;
        seen.add(id);
        const node = byId.get(id);
        if (!node) continue;
        if (!label.has(id)) label.set(id, { name: tip.name, kind: tip.kind });
        for (const p of node.parents) if (byId.has(p) && !seen.has(p)) stack.push(p);
      }
    }
    return label;
  }, [nodes]);

  // Hovering a commit row traces its ancestry (B); off-hover falls back to the
  // current branch (A). The "active" chain paints bold at full opacity while
  // everything else dims, so the highlighted branch reads as the graph's
  // backbone. Merge (2nd-parent) edges draw thin + dashed so incoming branches
  // stay legible at a glance (C).
  const [traceId, setTraceId] = useState<string | null>(null);
  const active = useMemo(
    () => chainFrom(traceId ?? headId),
    [chainFrom, traceId, headId]
  );

  // A WIP node sits in row 0; commits shift down by one row when it's shown.
  // Visibility follows `dirtyFiles` (the file list, always fresh), NOT workStats:
  // the auto refresh skips the costly work_stats diff, so gating on it would hide
  // the node when changes arrive via an external edit. workStats only feeds +/-.
  const hasWip = dirtyFiles > 0 && !filtering;
  // The WIP node is "now", so it belongs on HEAD's side of the history: above it
  // newest-first, below it oldest-first. Only when it sits ABOVE do the commit
  // rows shift down by one. HEAD is displayed[0] newest-first and the last row
  // oldest-first; anchoring the node and its dashed edge to that row (rather
  // than always to row 0) is what keeps it attached to HEAD in both orders.
  const wipRow = sortAsc ? displayed.length : 0;
  const offset = hasWip && !sortAsc ? 1 : 0;
  const headIdx = sortAsc ? displayed.length - 1 : 0;
  const wipLane = displayed[headIdx]?.lane ?? 0;
  const wipColor = laneColor(displayed[headIdx]?.color ?? 0);

  // --- virtualization: mount only the rows in/around the viewport ---
  const graphRef = useRef<HTMLDivElement>(null);
  const scRef = useRef<HTMLElement | null>(null);
  const [band, setBand] = useState({ start: 0, end: 60 });
  const total = displayed.length + (hasWip ? 1 : 0); // visual rows, incl. the WIP node
  const hasGraph = nodes.length > 0 || hasWip;
  // Track the visible band against the scrolling ancestor (.center-graph). The
  // SVG keeps its full height + absolute coordinates; we only cull its children
  // and pad the row column, so dots / edges / rows stay aligned.
  useLayoutEffect(() => {
    const g = graphRef.current;
    if (!g) return;
    let p: HTMLElement | null = g.parentElement;
    while (p) {
      const oy = getComputedStyle(p).overflowY;
      if (oy === "auto" || oy === "scroll") break;
      p = p.parentElement;
    }
    scRef.current = p;
    const sc: HTMLElement = p ?? document.documentElement;
    const recompute = () => {
      const top = sc.getBoundingClientRect().top - g.getBoundingClientRect().top;
      const start = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
      const end = Math.ceil((top + sc.clientHeight) / ROW_H) + OVERSCAN;
      setBand((b) => (b.start === start && b.end === end ? b : { start, end }));
    };
    recompute();
    const evt: Window | HTMLElement = p ?? window;
    evt.addEventListener("scroll", recompute, { passive: true });
    const ro = new ResizeObserver(recompute);
    if (p) ro.observe(p);
    ro.observe(g);
    return () => {
      evt.removeEventListener("scroll", recompute);
      ro.disconnect();
    };
  }, [hasGraph, ROW_H]);

  const vStart = Math.min(band.start, total);
  const vEnd = Math.min(band.end, total);
  // `vEnd` is exclusive (padBottom uses `total - vEnd`), so this bound must be
  // too - otherwise, oldest-first, the WIP row renders AND padBottom still
  // reserves a row for it, leaving a stray blank row at the bottom.
  const wipVisible = hasWip && wipRow >= vStart && wipRow < vEnd;
  const visibleRows = displayed.slice(Math.max(0, vStart - offset), Math.max(0, vEnd - offset));
  const padTop = vStart * ROW_H;
  const padBottom = Math.max(0, (total - vEnd) * ROW_H);

  // Center the current search match; it may be outside the mounted window, so
  // scroll by computed position rather than relying on the matched row's ref.
  useEffect(() => {
    if (!currentMatchId || lastScrolled.current === currentMatchId) return;
    const i = index.get(currentMatchId);
    const sc = scRef.current;
    const g = graphRef.current;
    if (i === undefined || !sc || !g) return;
    lastScrolled.current = currentMatchId;
    sc.scrollTop = centerRowScrollTop(sc, g, i, offset, ROW_H);
  }, [currentMatchId, index, offset]);

  // Reveal a commit picked in the sidebar: smoothly center its row (computed
  // position, so it works even when the row is virtualized out). Keyed on
  // reveal.seq so the same commit can be re-revealed. Tip outside the loaded
  // window is a no-op.
  const revealCancel = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!reveal) return;
    const i = index.get(reveal.id);
    const sc = scRef.current;
    const g = graphRef.current;
    if (i === undefined || !sc || !g) return;
    const to = centerRowScrollTop(sc, g, i, offset, ROW_H);
    const clamped = Math.max(0, Math.min(to, sc.scrollHeight - sc.clientHeight));
    revealCancel.current?.();
    revealCancel.current = animateScrollTop(sc, clamped);
    return () => revealCancel.current?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.seq]);

  const maxLane = nodes.reduce((m, n) => Math.max(m, n.lane), 0);
  const graphWidth = PAD_X + (maxLane + 1) * LANE_W;
  // Refs now live in their own column (left of the lanes, GitKraken-style), so the
  // graph column is pure lanes/dots, auto-sized to lane depth - not resizable. The
  // refs column is resizable; the SVG is shifted right by it so lanes overlay the
  // graph cell, not the refs cell.
  const graphColW = graphWidth;
  const refsW = visibleCols.refs ? cols.refs ?? REFS_W_DEFAULT : 0;
  const svgLeft = refsW;
  const authorW = cols.author ?? 150;
  const shaW = cols.sha ?? 64;
  const dateW = cols.date ?? 66;
  // Every non-shrinkable column, plus a floor for the message. The header has no
  // `overflow` so it always lays out at its intrinsic width, while `.commit-row`
  // clips at `overflow: hidden` - if `.graph` isn't at least this wide, a narrow
  // center pane leaves the header labels scrolling over blank rows with the
  // commit message gone entirely. Sizing the whole graph instead makes the
  // container scroll horizontally and keeps header and rows in lockstep.
  const MSG_MIN_W = 120;
  const minGraphW =
    refsW +
    (visibleCols.graph ? graphColW : 0) +
    (visibleCols.message ? MSG_MIN_W : 0) +
    (visibleCols.author ? authorW : 0) +
    (visibleCols.sha ? shaW : 0) +
    (visibleCols.date ? dateW : 0);
  const x = (lane: number) => PAD_X + lane * LANE_W;

  // Drag a header separator to resize a column (clamped, persisted on change).
  const startResize =
    (keyName: "refs" | "author" | "sha" | "date", startW: number, direction: 1 | -1 = 1) =>
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const min = keyName === "date" ? 56 : keyName === "sha" ? 56 : 80;
      const move = (ev: MouseEvent) =>
        setCols((c) => ({
          ...c,
          [keyName]: Math.max(min, startW + direction * (ev.clientX - startX)),
        }));
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    };

  const showHeaderMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    // Keep at least one column visible so right-clicking the header (and the
    // graph itself) never disappears into an all-blank state.
    const visibleCount = GRAPH_COLUMNS.filter(({ key }) => visibleCols[key]).length;
    const items = await Promise.all(
      GRAPH_COLUMNS.map(({ key, label }) =>
        CheckMenuItem.new({
          text: label,
          checked: visibleCols[key],
          enabled: !(visibleCols[key] && visibleCount === 1),
          action: () => setVisibleCols((v) => ({ ...v, [key]: !v[key] })),
        })
      )
    );
    await (await Menu.new({ items })).popup();
  };
  const y = (i: number) => (i + offset) * ROW_H + ROW_H / 2;
  const wipY = wipRow * ROW_H + ROW_H / 2;

  const scrollRowIntoView = (i: number) => {
    const sc = scRef.current;
    const g = graphRef.current;
    if (!sc || !g) return;
    const gTop = g.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    const rowTop = gTop + (i + offset) * ROW_H;
    if (rowTop < sc.scrollTop) sc.scrollTop = rowTop;
    else if (rowTop + ROW_H > sc.scrollTop + sc.clientHeight) sc.scrollTop = rowTop + ROW_H - sc.clientHeight;
  };

  // Arrow / j-k navigation through the displayed commits while the graph is focused.
  const onGraphKey = (e: React.KeyboardEvent) => {
    const down = e.key === "ArrowDown" || e.key === "j";
    const up = e.key === "ArrowUp" || e.key === "k";
    if ((!down && !up) || !displayed.length) return;
    e.preventDefault();
    const cur = selectedId ? index.get(selectedId) : undefined;
    const next = cur === undefined ? 0 : Math.max(0, Math.min(displayed.length - 1, cur + (down ? 1 : -1)));
    if (next === cur) return;
    onSelect(displayed[next].id);
    scrollRowIntoView(next);
  };

  if (!hasGraph) {
    return (
      <div className="empty-state">
        <svg width="30" height="30" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="8" cy="3" r="1.6" />
          <circle cx="8" cy="13" r="1.6" />
          <path d="M8 4.6v6.8" />
        </svg>
        <div className="empty-state-title">No commits yet</div>
        <div className="empty-state-hint">Make your first commit and your history will appear here.</div>
      </div>
    );
  }

  // The "Uncommitted changes" row. Held in a variable because its position in
  // the list depends on the sort order (see wipRow) - it renders before the
  // commit rows newest-first and after them oldest-first.
  const wipRowEl = (
    <div
      className={`commit-row wip-row${workActive ? " selected" : ""}`}
      style={{ height: ROW_H }}
      onClick={onSelectWork}
      onContextMenu={(e) => {
        e.preventDefault();
        onWorkMenu();
      }}
      onMouseEnter={() => setTraceId(null)}
    >
      {visibleCols.refs && <div className="col-refs" style={{ flex: `0 0 ${refsW}px` }} />}
      {visibleCols.graph && <div className="col-graph" style={{ flex: `0 0 ${graphColW}px` }} />}
      {visibleCols.message && (
        <div className="col-msg">
          <span className="commit-summary">Uncommitted changes</span>
        </div>
      )}
      <div className="col-wip">
        {workStats && (
          <>
            <span className="wip-add">+{workStats.insertions}</span>
            <span className="wip-del">-{workStats.deletions}</span>
          </>
        )}
        <span className="wip-files">
          {dirtyFiles} file{dirtyFiles === 1 ? "" : "s"}
        </span>
      </div>
    </div>
  );

  return (
    <div
      className="graph-wrap"
      style={
        {
          ["--avatar-d" as string]: `${AVATAR_R * 2}px`,
          // On the WRAP, not on `.graph`: the header is a sibling of `.graph`,
          // so sizing only the latter widens the rows while the header stays at
          // the pane width - the columns then disagree and, since `sticky top`
          // does not stick horizontally, scrolling right slides the header off
          // and leaves blank header above populated rows.
          minWidth: minGraphW,
        } as CSSProperties
      }
    >
      {searchOpen && (
        <div className="graph-search">
          <input
            ref={searchInput}
            className="graph-search-input"
            value={query}
            placeholder="Search author / sha / message…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                closeSearch();
              } else if (e.key === "Enter") {
                e.preventDefault();
                step(e.shiftKey ? -1 : 1);
              }
            }}
          />
          <span className="graph-search-count">
            {/* Same n/m shape when empty, so the counter doesn't jitter as the
                fixed-width box re-centers while typing. */}
            {matchList.length ? `${safeIdx + 1}/${matchList.length}` : query ? "0/0" : ""}
          </span>
          <button
            className={`search-nav${filterMode ? " active" : ""}`}
            onClick={() => setFilterMode((f) => !f)}
            title="Show only matching commits"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h12l-4.5 5.5V13L6.5 14.5V8.5z" /></svg>
          </button>
          <button className="search-nav" disabled={!matchList.length} onClick={() => step(-1)} title="Previous (Shift+Enter)">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 10l4-4 4 4" /></svg>
          </button>
          <button className="search-nav" disabled={!matchList.length} onClick={() => step(1)} title="Next (Enter)">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l4 4 4-4" /></svg>
          </button>
          <button className="search-nav" onClick={closeSearch} title="Close (Esc)">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>
      )}
      <div className="graph-header" onContextMenu={showHeaderMenu}>
        {visibleCols.refs && (
          <div className="col-refs" style={{ flex: `0 0 ${refsW}px` }}>
            Branch / Tag
            <div
              className="col-resize"
              onMouseDown={startResize("refs", refsW)}
              title="Resize branch/tag column"
            />
          </div>
        )}
        {visibleCols.graph && (
          <div className="col-graph" style={{ flex: `0 0 ${graphColW}px` }}>Graph</div>
        )}
        {visibleCols.message && <div className="col-msg">Message</div>}
        {visibleCols.author && (
          <div className="col-author" style={{ flex: `0 0 ${authorW}px` }}>
            <div
              className="col-resize left"
              onMouseDown={startResize("author", authorW, -1)}
              onClick={(e) => e.stopPropagation()}
              title="Resize author column"
            />
            Author
          </div>
        )}
        {visibleCols.sha && (
          <div className="col-sha" style={{ flex: `0 0 ${shaW}px` }}>
            <div
              className="col-resize left"
              onMouseDown={startResize("sha", shaW, -1)}
              onClick={(e) => e.stopPropagation()}
              title="Resize SHA column"
            />
            SHA
          </div>
        )}
        {visibleCols.date && (
          <div
            className="col-date sortable"
            style={{ flex: `0 0 ${dateW}px` }}
            onClick={toggleSort}
            title="Sort by date"
          >
            <div
              className="col-resize left"
              onMouseDown={startResize("date", dateW, -1)}
              onClick={(e) => e.stopPropagation()}
              title="Resize date column"
            />
            Date
            <SortArrow asc={sortAsc} />
          </div>
        )}
      </div>
      <div className="graph" ref={graphRef} tabIndex={0} onKeyDown={onGraphKey}>
      {visibleCols.graph && (
        <svg
          className="graph-svg"
          width={graphWidth}
          height={total * ROW_H}
          style={{ left: svgLeft }}
        >
        {/* One horizontal transparent->color gradient per lane color, reused by
            every relief band (objectBoundingBox remaps it to each rect's box). */}
        <defs>
          {LANE_COLORS.map((c, i) => (
            <linearGradient key={i} id={`band-${i}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" stopColor={c} stopOpacity="0" />
              <stop offset="1" stopColor={c} stopOpacity="1" />
            </linearGradient>
          ))}
        </defs>
        {/* dashed edge between the WIP node and HEAD (above it oldest-first) */}
        {hasWip && displayed.length > 0 && (
          <path
            d={edgePath(x(wipLane), wipY, x(displayed[headIdx].lane), y(headIdx))}
            fill="none"
            stroke={wipColor}
            strokeWidth={1.6}
            strokeDasharray="3 3"
          />
        )}
        {/* Relief band from each node out to the message column: a faint
            lane-colored rectangle with a more opaque right edge, so the eye
            tracks avatar -> message. Drawn first, under the lanes/dots. */}
        {displayed.map((n, i) => {
          if (i + offset < vStart || i + offset > vEnd) return null;
          const cy = y(i);
          const selected = n.id === selectedId;
          const on = active.has(n.id);
          const x0 = x(n.lane) + AVATAR_R + 2;
          const bandH = AVATAR_R * 2 + 2; // slim: ~ the avatar's own height
          const top = cy - bandH / 2;
          const col = laneColor(n.color);
          const border = 4; // opaque right edge, kept just inside the SVG
          return (
            <g key={`band-${n.id}`}>
              {/* connector stub linking the (right-aligned) branch/tag badges to
                  this commit's bubble, so a label reads as tied to its node. */}
              {n.refs.length > 0 && (
                <line
                  x1={0}
                  y1={cy}
                  x2={x(n.lane)}
                  y2={cy}
                  stroke={col}
                  strokeWidth={2}
                  opacity={selected || on ? 0.9 : 0.6}
                />
              )}
              {/* faded fill: invisible on the left, full color at the right */}
              <rect
                x={x0}
                y={top}
                width={Math.max(0, graphWidth - x0)}
                height={bandH}
                fill={`url(#band-${n.color % LANE_COLORS.length})`}
                opacity={selected ? 0.32 : on ? 0.2 : 0.13}
              />
              <rect
                x={graphWidth - border}
                y={top}
                width={border}
                height={bandH}
                fill={col}
                opacity={selected ? 0.85 : on ? 0.5 : 0.32}
              />
            </g>
          );
        })}
        {/* edges first so dots paint over them */}
        {displayed.map((n, i) =>
          n.parents.map((pid, pi) => {
            const j = index.get(pid);
            if (j === undefined) return null;
            if (Math.max(i, j) + offset < vStart || Math.min(i, j) + offset > vEnd) return null;
            const x1 = x(n.lane);
            const y1 = y(i);
            const x2 = x(displayed[j].lane);
            const y2 = y(j);
            const d = edgePath(x1, y1, x2, y2);
            // pi === 0 is the first-parent (mainline) edge; pi > 0 is a merge.
            const firstParent = pi === 0;
            const onSpine = firstParent && active.has(n.id) && active.has(pid);
            // Solid, full-color lanes (GitKraken); the current-branch spine just
            // reads a touch bolder rather than dimming everything else out.
            return (
              <path
                key={`${n.id}-${pid}`}
                d={d}
                fill="none"
                stroke={laneColor(n.color)}
                strokeWidth={onSpine ? 2.6 : firstParent ? 2 : 1.6}
                strokeDasharray={firstParent ? undefined : "4 3"}
                opacity={onSpine ? 1 : 0.85}
              />
            );
          })
        )}
        {/* WIP node: hollow dashed dot = uncommitted changes */}
        {wipVisible && (
          <circle
            cx={x(wipLane)}
            cy={wipY}
            r={DOT_R}
            fill="none"
            style={{ stroke: workActive ? "var(--text)" : wipColor }}
            strokeWidth={2}
            strokeDasharray="2.5 2"
          />
        )}
        {displayed.map((n, i) => {
          if (i + offset < vStart || i + offset > vEnd) return null;
          const cx = x(n.lane);
          const cy = y(i);
          const selected = n.id === selectedId;
          // Off-spine dots stay nearly solid (GitKraken keeps lanes crisp); the
          // current branch's dots are full strength so the backbone still leads.
          const dim = !active.has(n.id) && !selected ? 0.9 : 1;
          // Stashes are not commits in the usual sense - draw them as a diamond
          // (never an avatar bubble) so they stand out as off-to-the-side state.
          if (n.refs.some((r) => r.kind === "stash")) {
            const r = DOT_R + 2.5;
            return (
              <path
                key={n.id}
                d={`M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z`}
                fill={laneColor(n.color)}
                opacity={dim}
                style={{ stroke: selected ? "var(--text)" : "var(--bg)" }}
                strokeWidth={selected ? 2 : 1.5}
              />
            );
          }
          const url = n.email ? avatars.get(n.email) : undefined;
          if (!url) {
            // No avatar yet (loading / no email): the classic colored lane dot.
            return (
              <circle
                key={n.id}
                cx={cx}
                cy={cy}
                r={n.refs.length ? DOT_R + 1.5 : DOT_R}
                fill={laneColor(n.color)}
                opacity={dim}
                style={{ stroke: selected ? "var(--text)" : "var(--bg)" }}
                strokeWidth={selected ? 2 : 1.5}
              />
            );
          }
          return (
            <g key={n.id} opacity={dim}>
              <clipPath id={`av-${n.id}`}>
                <circle cx={cx} cy={cy} r={AVATAR_R} />
              </clipPath>
              {/* lane-colored backdrop shows through while the image loads / offline */}
              <circle cx={cx} cy={cy} r={AVATAR_R} fill={laneColor(n.color)} />
              <image
                href={url}
                x={cx - AVATAR_R}
                y={cy - AVATAR_R}
                width={AVATAR_R * 2}
                height={AVATAR_R * 2}
                clipPath={`url(#av-${n.id})`}
                preserveAspectRatio="xMidYMid slice"
              />
              {/* ring: lane color, or white when selected */}
              <circle
                cx={cx}
                cy={cy}
                r={AVATAR_R}
                fill="none"
                style={{ stroke: selected ? "var(--text)" : laneColor(n.color) }}
                strokeWidth={selected ? 2 : 1.5}
              />
            </g>
          );
        })}
        </svg>
      )}

      <div className="graph-rows" onMouseLeave={() => setTraceId(null)}>
        <div aria-hidden style={{ height: padTop }} />
        {/* Newest-first the WIP row leads the list; oldest-first it trails it. */}
        {wipVisible && !sortAsc && wipRowEl}
        {visibleRows.map((n) => {
          const url = n.email ? avatars.get(n.email) : undefined;
          // On hover of a row with no branch/remote badge, hint which branch the
          // commit belongs to (a tag-only row still gets the hint).
          const hasBranchBadge = n.refs.some((r) => r.kind === "branch" || r.kind === "remote");
          const ghost = !hasBranchBadge && traceId === n.id ? branchByCommit.get(n.id) : undefined;
          return (
            <div
              key={n.id}
              className={`commit-row${n.id === selectedId ? " selected" : ""}${
                matchSet ? (matchSet.has(n.id) ? " matched" : " dimmed") : ""
              }${n.id === currentMatchId ? " match-current" : ""}`}
              style={{
                height: ROW_H,
                // Checked-out branch: a thick lane-colored bar down the far left of
                // the row marks "you are here".
                boxShadow: n.id === headId ? `inset 3px 0 0 ${laneColor(n.color)}` : undefined,
              }}
              onClick={() => onSelect(n.id)}
              onMouseEnter={() => setTraceId(n.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                onCommitMenu(n);
              }}
            >
              {visibleCols.refs && (
                <div className="col-refs" style={{ flex: `0 0 ${refsW}px` }}>
                  <CommitRefs
                    refs={n.refs}
                    color={laneColor(n.color)}
                    prBranches={prBranches}
                    headBranch={headBranch}
                    onBranchMenu={(branchName, isRemote) =>
                      onBranchMenu(branchName, isRemote, n.id)
                    }
                    onTagMenu={(tagName) => onTagMenu(tagName, n.id)}
                  />
                  {ghost && (
                    <span
                      className="ref-badge ref-ghost"
                      style={{ ["--lane"]: laneColor(n.color) } as CSSProperties}
                      title={`On ${ghost.name}`}
                    >
                      <span className="ref-name">{ghost.name}</span>
                      <RefIcon kind={ghost.kind} />
                    </span>
                  )}
                </div>
              )}
              {visibleCols.graph && (
                <div className="col-graph" style={{ flex: `0 0 ${graphColW}px` }} />
              )}
              {visibleCols.message && (
                <div className="col-msg">
                  <span className="commit-summary" title={n.summary || undefined}>
                    {n.summary || "(no message)"}
                  </span>
                </div>
              )}
              {visibleCols.author && (
                <div className="col-author" style={{ flex: `0 0 ${authorW}px` }}>
                  {url &&
                    (failedAvatars.has(url) ? (
                      <span
                        className="author-avatar author-avatar-fallback"
                        style={{ background: laneColor(n.color), borderColor: laneColor(n.color) }}
                        aria-hidden="true"
                      >
                        {n.author.trim().charAt(0).toUpperCase() || "?"}
                      </span>
                    ) : (
                      <img
                        className="author-avatar"
                        src={url}
                        alt=""
                        style={{ borderColor: laneColor(n.color) }}
                        onError={() => setFailedAvatars((s) => new Set(s).add(url))}
                      />
                    ))}
                  <span className="col-author-name" title={n.email ? `${n.author} <${n.email}>` : n.author}>
                    {n.author}
                  </span>
                </div>
              )}
              {visibleCols.sha && (
                <div className="col-sha" style={{ flex: `0 0 ${shaW}px` }}>{n.short_id}</div>
              )}
              {visibleCols.date && (
                <div className="col-date" style={{ flex: `0 0 ${dateW}px` }}>{relativeTime(n.time)}</div>
              )}
            </div>
          );
        })}
        {wipVisible && sortAsc && wipRowEl}
        <div aria-hidden style={{ height: padBottom }} />
        {canLoadMore && !filtering && (
          <div className="load-more-row">
            <button className="load-more-btn" onClick={onLoadMore}>
              Load more commits
            </button>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}

function SortArrow({ asc }: { asc: boolean }) {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
      <path d={asc ? "M4 1l3 5H1z" : "M4 7L1 2h6z"} fill="currentColor" />
    </svg>
  );
}

const REF_ORDER: Record<RefKind, number> = { branch: 0, tag: 1, stash: 2, remote: 3, head: 4 };

interface BranchRefGroup {
  name: string;
  locals: string[];
  remotes: string[];
}

/// Typed ref badges for a commit. HEAD marks the current branch as "current"
/// (filled); a standalone HEAD badge appears only on a detached checkout.
function CommitRefs({
  refs,
  color,
  prBranches,
  headBranch,
  onBranchMenu,
  onTagMenu,
}: {
  refs: RefLabel[];
  /// Lane color of the commit these refs sit on; branch/remote/HEAD badges are
  /// tinted with it so a badge matches the line it belongs to (GitKraken).
  color: string;
  /// Branch names with an open PR/MR - those badges show the fork icon.
  prBranches: ReadonlySet<string>;
  headBranch: string | null;
  onBranchMenu: (branchName: string, isRemote: boolean) => void;
  onTagMenu: (tagName: string) => void;
}) {
  const isHead = refs.some((r) => r.kind === "head");
  const branchGroups = groupBranchRefs(refs);
  const otherRefs = refs
    .filter((r) => r.kind !== "head" && r.kind !== "branch" && r.kind !== "remote")
    .sort((a, b) => REF_ORDER[a.kind] - REF_ORDER[b.kind]);
  const hasLocalBranch = branchGroups.some((g) => g.locals.length > 0);
  return (
    <>
      {isHead && !hasLocalBranch && <RefBadge kinds={["head"]} name="HEAD" current color={color} />}
      {branchGroups.map((g) => (
        <RefBadge
          key={`branch-group:${g.name}`}
          kinds={[
            ...(g.locals.length ? (["branch"] as const) : []),
            ...(g.remotes.length ? (["remote"] as const) : []),
          ]}
          name={g.name}
          title={branchGroupTitle(g)}
          current={headBranch != null && g.locals.includes(headBranch)}
          color={color}
          hasPr={prBranches.has(g.name)}
          onContextMenu={() =>
            onBranchMenu(g.locals[0] ?? g.remotes[0] ?? g.name, !g.locals.length)
          }
        />
      ))}
      {otherRefs.map((r) => (
        <RefBadge
          key={`${r.kind}:${r.name}`}
          kinds={[r.kind]}
          name={r.name}
          color={color}
          onContextMenu={r.kind === "tag" ? () => onTagMenu(r.name) : undefined}
        />
      ))}
    </>
  );
}

function groupBranchRefs(refs: RefLabel[]): BranchRefGroup[] {
  const groups = new Map<string, BranchRefGroup>();
  const ensure = (name: string) => {
    const existing = groups.get(name);
    if (existing) return existing;
    const next = { name, locals: [], remotes: [] };
    groups.set(name, next);
    return next;
  };

  for (const ref of refs) {
    if (ref.kind === "branch") {
      ensure(ref.name).locals.push(ref.name);
    } else if (ref.kind === "remote") {
      ensure(remoteBranchName(ref.name)).remotes.push(ref.name);
    }
  }

  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function remoteBranchName(name: string): string {
  const short = name.includes("/") ? name.slice(name.indexOf("/") + 1) : name;
  return short === "HEAD" ? name : short;
}

function branchGroupTitle(group: BranchRefGroup): string {
  return [
    ...group.locals.map((name) => `Local: ${name}`),
    ...group.remotes.map((name) => `Remote: ${name}`),
  ].join("\n");
}

function RefBadge({
  kinds,
  name,
  title,
  current,
  color,
  hasPr,
  onContextMenu,
}: {
  kinds: RefKind[];
  name: string;
  title?: string;
  current?: boolean;
  color?: string;
  /// The branch has an open PR/MR - show the fork icon instead of the monitor.
  hasPr?: boolean;
  onContextMenu?: () => void;
}) {
  const primary = kinds.includes("branch") ? "branch" : kinds[0];
  // All badge color derives from the lane color in CSS (via --lane), so it can
  // adapt per theme: white text on the faint tint in dark themes, a darkened lane
  // color on light (where white would be unreadable). The checked-out branch gets
  // a solid fill + bold; the icon shape tells the kinds apart.
  const style = color ? ({ ["--lane"]: color } as CSSProperties) : undefined;
  return (
    <span
      className={`ref-badge ref-${primary}${current ? " current" : ""}`}
      style={style}
      title={title ?? name}
      onContextMenu={
        onContextMenu
          ? (e) => {
              e.preventDefault();
              e.stopPropagation();
              onContextMenu();
            }
          : undefined
      }
    >
      {current && (
        <svg
          className="ref-check"
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3.5 8.5l3 3 6-6.5" />
        </svg>
      )}
      <span className="ref-name">{name}</span>
      {hasPr ? (
        // A branch with an open PR shows a single fork, not monitor+cloud - for
        // local, remote-only (origin/x you haven't checked out), or both.
        <RefIcon kind="branch" hasPr />
      ) : (
        kinds.map((kind) => <RefIcon key={kind} kind={kind} />)
      )}
    </span>
  );
}

/// Icon per ref kind, from the shared icon set so badges match the left sidebar.
/// A local branch shows the monitor/PC glyph (like the sidebar's "Local" section),
/// or the fork glyph when it has an open PR/MR.
function RefIcon({ kind, hasPr }: { kind: RefKind; hasPr?: boolean }) {
  switch (kind) {
    case "tag":
      return <TagIcon />;
    case "stash":
      return <StashIcon />;
    case "remote":
      return <RemoteIcon />;
    case "head":
      return <HeadIcon />;
    default:
      return hasPr ? <BranchIcon /> : <LocalIcon />;
  }
}
