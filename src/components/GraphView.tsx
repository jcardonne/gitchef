import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CheckMenuItem, Menu } from "@tauri-apps/api/menu";
import type { CommitNode, RefKind, RefLabel, WorkStats } from "../types";
import { avatarUrl, type AvatarContext, laneColor, relativeTime } from "../util";
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
const LANE_W = 16;
const DOT_R = 5;
const AVATAR_R = 8; // committer avatar disc radius (~16px, fits one lane)
const PAD_X = 14;
const OVERSCAN = 8; // rows kept mounted above/below the viewport
const GRAPH_COLUMNS: { key: keyof GraphColumnVisibility; label: string }[] = [
  { key: "graph", label: "Group" },
  { key: "message", label: "Message" },
  { key: "author", label: "Author" },
  { key: "sha", label: "SHA" },
  { key: "date", label: "Date" },
];

interface Props {
  nodes: CommitNode[];
  selectedId: string | null;
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
}

/// Renders the commit DAG: an SVG of lanes/edges/dots on the left, aligned
/// row-for-row with commit text on the right. Both use the same ROW_H so the
/// dot always sits next to its message. When there are uncommitted changes, a
/// "WIP" node is drawn one row above HEAD (like GitKraken).
export default function GraphView({
  nodes,
  selectedId,
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
  const currentMatchId = matchList[matchIdx]?.id ?? null;
  const step = (d: number) =>
    matchList.length && setMatchIdx((i) => (i + d + matchList.length) % matchList.length);
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
  const offset = hasWip ? 1 : 0;
  const wipLane = displayed[0]?.lane ?? 0;
  const wipColor = laneColor(displayed[0]?.color ?? 0);

  // --- virtualization: mount only the rows in/around the viewport ---
  const graphRef = useRef<HTMLDivElement>(null);
  const scRef = useRef<HTMLElement | null>(null);
  const [band, setBand] = useState({ start: 0, end: 60 });
  const total = displayed.length + offset; // visual rows, incl. the WIP node
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
  const wipVisible = hasWip && vStart === 0;
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
    const gTop = g.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    sc.scrollTop = gTop + (i + offset) * ROW_H + ROW_H / 2 - sc.clientHeight / 2;
  }, [currentMatchId, index, offset]);

  const maxLane = nodes.reduce((m, n) => Math.max(m, n.lane), 0);
  const graphWidth = PAD_X + (maxLane + 1) * LANE_W;
  // The graph column holds lanes/dots + branch badges; message column starts
  // after it (fixed) so all messages align regardless of lane depth. Resizable.
  const graphColW = cols.graph ?? graphWidth + 150;
  const authorW = cols.author ?? 150;
  const shaW = cols.sha ?? 64;
  const dateW = cols.date ?? 66;
  const x = (lane: number) => PAD_X + lane * LANE_W;

  // Drag a header separator to resize a column (clamped, persisted on change).
  const startResize =
    (keyName: "graph" | "author" | "sha" | "date", startW: number, direction: 1 | -1 = 1) =>
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
  const wipY = ROW_H / 2;

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

  return (
    <div className="graph-wrap">
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
            {matchList.length ? `${matchIdx + 1}/${matchList.length}` : query ? "0" : ""}
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
        {visibleCols.graph && (
          <div className="col-graph" style={{ flex: `0 0 ${graphColW}px` }}>
            Group
            <div
              className="col-resize"
              onMouseDown={startResize("graph", graphColW)}
              title="Resize group column"
            />
          </div>
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
      <div className="graph" ref={graphRef} tabIndex={0} onKeyDown={onGraphKey} style={{ minWidth: visibleCols.graph ? graphColW : 0 }}>
      {visibleCols.graph && (
        <svg
          className="graph-svg"
          width={graphWidth}
          height={(displayed.length + offset) * ROW_H}
        >
        {/* dashed edge from the WIP node down into HEAD */}
        {hasWip && nodes.length > 0 && (
          <path
            d={`M ${x(wipLane)} ${wipY} L ${x(nodes[0].lane)} ${y(0)}`}
            fill="none"
            stroke={wipColor}
            strokeWidth={1.6}
            strokeDasharray="3 3"
          />
        )}
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
            const mid = (y1 + y2) / 2;
            const d = `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
            // pi === 0 is the first-parent (mainline) edge; pi > 0 is a merge.
            const firstParent = pi === 0;
            const onSpine = firstParent && active.has(n.id) && active.has(pid);
            return (
              <path
                key={`${n.id}-${pid}`}
                d={d}
                fill="none"
                stroke={laneColor(n.color)}
                strokeWidth={onSpine ? 2.6 : firstParent ? 1.6 : 1.3}
                strokeDasharray={firstParent ? undefined : "4 3"}
                opacity={onSpine ? 1 : firstParent ? 0.45 : 0.4}
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
          // Off-spine dots dim to match their edges; the current branch's dots
          // stay full strength so the backbone is unbroken.
          const dim = !active.has(n.id) && !selected ? 0.5 : 1;
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
        {wipVisible && (
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
            {visibleCols.graph && (
              <div
                className="col-graph"
                style={{ flex: `0 0 ${graphColW}px`, paddingLeft: x(wipLane) + DOT_R + 8 }}
              />
            )}
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
        )}
        {visibleRows.map((n) => {
          const url = n.email ? avatars.get(n.email) : undefined;
          return (
            <div
              key={n.id}
              className={`commit-row${n.id === selectedId ? " selected" : ""}${
                matchSet ? (matchSet.has(n.id) ? " matched" : " dimmed") : ""
              }${n.id === currentMatchId ? " match-current" : ""}`}
              style={{ height: ROW_H }}
              onClick={() => onSelect(n.id)}
              onMouseEnter={() => setTraceId(n.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                onCommitMenu(n);
              }}
            >
              {visibleCols.graph && (
                <div
                  className="col-graph"
                  style={{ flex: `0 0 ${graphColW}px`, paddingLeft: x(n.lane) + DOT_R + 8 }}
                >
                  <CommitRefs
                    refs={n.refs}
                    onBranchMenu={(branchName, isRemote) =>
                      onBranchMenu(branchName, isRemote, n.id)
                    }
                    onTagMenu={(tagName) => onTagMenu(tagName, n.id)}
                  />
                </div>
              )}
              {visibleCols.message && (
                <div className="col-msg">
                  <span className="commit-summary">{n.summary || "(no message)"}</span>
                </div>
              )}
              {visibleCols.author && (
                <div className="col-author" style={{ flex: `0 0 ${authorW}px` }}>
                  {url && <img className="author-avatar" src={url} alt="" />}
                  <span className="col-author-name">{n.author}</span>
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
  onBranchMenu,
  onTagMenu,
}: {
  refs: RefLabel[];
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
      {isHead && !hasLocalBranch && <RefBadge kinds={["head"]} name="HEAD" current />}
      {branchGroups.map((g) => (
        <RefBadge
          key={`branch-group:${g.name}`}
          kinds={[
            ...(g.locals.length ? (["branch"] as const) : []),
            ...(g.remotes.length ? (["remote"] as const) : []),
          ]}
          name={g.name}
          title={branchGroupTitle(g)}
          current={g.locals.length > 0 && isHead}
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
  onContextMenu,
}: {
  kinds: RefKind[];
  name: string;
  title?: string;
  current?: boolean;
  onContextMenu?: () => void;
}) {
  const primary = kinds.includes("branch") ? "branch" : kinds[0];
  return (
    <span
      className={`ref-badge ref-${primary}${current ? " current" : ""}`}
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
      {kinds.map((kind) => (
        <RefIcon key={kind} kind={kind} />
      ))}
      <span className="ref-name">{name}</span>
    </span>
  );
}

/// Monochrome SVG icon per ref kind (currentColor, no emoji).
function RefIcon({ kind }: { kind: RefKind }) {
  const p = {
    width: 11,
    height: 11,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  switch (kind) {
    case "tag":
      return (
        <svg {...p}>
          <path d="M2.5 8.3V3.2a.7.7 0 0 1 .7-.7h5.1L14 7.8a1 1 0 0 1 0 1.4l-3.8 3.8a1 1 0 0 1-1.4 0L2.5 8.3z" />
          <circle cx="5.2" cy="5.2" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      );
    case "stash":
      return (
        <svg {...p}>
          <path d="M2 5l6-3 6 3-6 3-6-3z" />
          <path d="M2 8.5l6 3 6-3M2 11.5l6 3 6-3" />
        </svg>
      );
    case "remote":
      return (
        <svg {...p}>
          <path d="M4.5 12.5a3 3 0 0 1-.3-6A3.6 3.6 0 0 1 11 5.3a2.8 2.8 0 0 1 .4 7.2H4.5z" />
        </svg>
      );
    case "head":
      return (
        <svg {...p}>
          <circle cx="8" cy="8" r="3.2" />
        </svg>
      );
    default:
      return (
        <svg {...p}>
          <circle cx="5" cy="4" r="1.6" />
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="11" cy="6.5" r="1.6" />
          <path d="M5 5.6v4.8M5 8h2.5A3 3 0 0 0 10.5 5" />
        </svg>
      );
  }
}
