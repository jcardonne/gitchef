import { useEffect, useMemo, useRef, useState } from "react";
import type { CommitNode, RefKind, RefLabel, WorkStats } from "../types";
import { gravatarUrl, laneColor, relativeTime } from "../util";
import { getGraphCols, getSortAsc, setGraphCols, setSortAsc } from "../storage";

const ROW_H = 48;
const LANE_W = 16;
const DOT_R = 5;
const AVATAR_R = 8; // committer avatar disc radius (~16px, fits one lane)
const PAD_X = 14;

interface Props {
  nodes: CommitNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCommitMenu: (node: CommitNode) => void;
  workStats: WorkStats | null;
  workActive: boolean;
  onSelectWork: () => void;
  searchOpen: boolean;
  onSearchClose: () => void;
  canLoadMore: boolean;
  onLoadMore: () => void;
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
  workStats,
  workActive,
  onSelectWork,
  searchOpen,
  onSearchClose,
  canLoadMore,
  onLoadMore,
}: Props) {
  // Resizable column widths (persisted) + sort direction.
  const [cols, setCols] = useState(getGraphCols);
  useEffect(() => setGraphCols(cols), [cols]);
  const [sortAsc, setSortAscState] = useState(getSortAsc);
  const toggleSort = () => {
    const next = !sortAsc;
    setSortAscState(next);
    setSortAsc(next);
  };

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

  // Resolve a Gravatar URL per unique committer email (cached in util).
  const [avatars, setAvatars] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let alive = true;
    const emails = [...new Set(nodes.map((n) => n.email).filter(Boolean))];
    Promise.all(emails.map(async (e) => [e, await gravatarUrl(e)] as const)).then((pairs) => {
      if (!alive) return;
      // Warm the browser cache so dots + row avatars don't pop in on first paint.
      for (const [, url] of pairs) new Image().src = url;
      setAvatars(new Map(pairs));
    });
    return () => {
      alive = false;
    };
  }, [nodes]);

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
  const hasWip = !!workStats && workStats.files > 0 && !filtering;
  const offset = hasWip ? 1 : 0;
  const wipLane = displayed[0]?.lane ?? 0;
  const wipColor = laneColor(displayed[0]?.color ?? 0);

  const maxLane = nodes.reduce((m, n) => Math.max(m, n.lane), 0);
  const graphWidth = PAD_X + (maxLane + 1) * LANE_W;
  // The graph column holds lanes/dots + branch badges; message column starts
  // after it (fixed) so all messages align regardless of lane depth. Resizable.
  const graphColW = cols.graph ?? graphWidth + 150;
  const authorW = cols.author ?? 150;
  const x = (lane: number) => PAD_X + lane * LANE_W;

  // Drag a header separator to resize a column (clamped, persisted on change).
  const startResize = (keyName: "graph" | "author", startW: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const move = (ev: MouseEvent) =>
      setCols((c) => ({ ...c, [keyName]: Math.max(80, startW + (ev.clientX - startX)) }));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const y = (i: number) => (i + offset) * ROW_H + ROW_H / 2;
  const wipY = ROW_H / 2;

  if (nodes.length === 0 && !hasWip) {
    return <div className="empty-hint">No commits yet.</div>;
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
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 10l4-4 4 4" /></svg>
          </button>
          <button className="search-nav" disabled={!matchList.length} onClick={() => step(1)} title="Next (Enter)">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l4 4 4-4" /></svg>
          </button>
          <button className="search-nav" onClick={closeSearch} title="Close (Esc)">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>
      )}
      <div className="graph-header">
        <div className="col-graph" style={{ flex: `0 0 ${graphColW}px` }}>
          <div className="col-resize" onMouseDown={startResize("graph", graphColW)} />
        </div>
        <div className="col-msg">Message</div>
        <div className="col-author" style={{ flex: `0 0 ${authorW}px` }}>
          Author
          <div className="col-resize" onMouseDown={startResize("author", authorW)} />
        </div>
        <div className="col-sha">SHA</div>
        <div className="col-date sortable" onClick={toggleSort} title="Sort by date">
          Date
          <SortArrow asc={sortAsc} />
        </div>
      </div>
      <div className="graph" style={{ minWidth: graphColW }}>
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
        {hasWip && (
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

      <div className="graph-rows" onMouseLeave={() => setTraceId(null)}>
        {hasWip && workStats && (
          <div
            className={`commit-row wip-row${workActive ? " selected" : ""}`}
            style={{ height: ROW_H }}
            onClick={onSelectWork}
            onMouseEnter={() => setTraceId(null)}
          >
            <div
              className="col-graph"
              style={{ flex: `0 0 ${graphColW}px`, paddingLeft: x(wipLane) + DOT_R + 8 }}
            />
            <div className="col-msg">
              <span className="commit-summary">Uncommitted changes</span>
            </div>
            <div className="col-wip">
              <span className="wip-add">+{workStats.insertions}</span>
              <span className="wip-del">-{workStats.deletions}</span>
              <span className="wip-files">
                {workStats.files} file{workStats.files === 1 ? "" : "s"}
              </span>
            </div>
          </div>
        )}
        {displayed.map((n) => {
          const url = n.email ? avatars.get(n.email) : undefined;
          return (
            <div
              key={n.id}
              ref={(el) => {
                if (el && n.id === currentMatchId && lastScrolled.current !== currentMatchId) {
                  lastScrolled.current = currentMatchId;
                  el.scrollIntoView({ block: "center" });
                }
              }}
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
              <div
                className="col-graph"
                style={{ flex: `0 0 ${graphColW}px`, paddingLeft: x(n.lane) + DOT_R + 8 }}
              >
                <CommitRefs refs={n.refs} />
              </div>
              <div className="col-msg">
                <span className="commit-summary">{n.summary || "(no message)"}</span>
              </div>
              <div className="col-author" style={{ flex: `0 0 ${authorW}px` }}>
                {url && <img className="author-avatar" src={url} alt="" />}
                <span className="col-author-name">{n.author}</span>
              </div>
              <div className="col-sha">{n.short_id}</div>
              <div className="col-date">{relativeTime(n.time)}</div>
            </div>
          );
        })}
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

/// Typed ref badges for a commit. HEAD marks the current branch as "current"
/// (filled); a standalone HEAD badge appears only on a detached checkout.
function CommitRefs({ refs }: { refs: RefLabel[] }) {
  const isHead = refs.some((r) => r.kind === "head");
  const visible = refs
    .filter((r) => r.kind !== "head")
    .sort((a, b) => REF_ORDER[a.kind] - REF_ORDER[b.kind]);
  const hasBranch = visible.some((r) => r.kind === "branch");
  return (
    <>
      {isHead && !hasBranch && <RefBadge kind="head" name="HEAD" current />}
      {visible.map((r) => (
        <RefBadge
          key={`${r.kind}:${r.name}`}
          kind={r.kind}
          name={r.name}
          current={r.kind === "branch" && isHead}
        />
      ))}
    </>
  );
}

function RefBadge({ kind, name, current }: { kind: RefKind; name: string; current?: boolean }) {
  return (
    <span className={`ref-badge ref-${kind}${current ? " current" : ""}`} title={name}>
      <RefIcon kind={kind} />
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
