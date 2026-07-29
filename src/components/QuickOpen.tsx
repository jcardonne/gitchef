import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";

// Kept small on purpose: a short list reads faster than a wall of near-misses.
const MAX_RESULTS = 6;

/// Greedy case-insensitive subsequence match. Returns the index in `text` of each
/// matched query char (in order), or `null` if `query` is not a subsequence.
/// Positions drive both scoring and the matched-char highlight, so both agree.
function matchPositions(text: string, query: string): number[] | null {
  const t = text.toLowerCase();
  const out: number[] = [];
  let ti = 0;
  for (const c of query) {
    let found = -1;
    for (let j = ti; j < t.length; j++) {
      if (t[j] === c) { found = j; break; }
    }
    if (found === -1) return null;
    out.push(found);
    ti = found + 1;
  }
  return out;
}

/// Score a subsequence match: rewards consecutive matches and matches at a path
/// segment boundary (basename start), so "repoview" ranks RepoView.tsx on top.
function scoreOf(text: string, positions: number[]): number {
  const t = text.toLowerCase();
  let score = 0, streak = 0, prev = -2;
  for (const p of positions) {
    if (p === prev + 1) { streak += 1; score += 1 + streak; } else { streak = 0; score += 1; }
    if (p === 0 || t[p - 1] === "/") score += 3;
    prev = p;
  }
  return score;
}

/// Split `path` into plain text and highlighted <span> runs at `positions`.
function highlight(path: string, positions: number[]) {
  const hit = new Set(positions);
  const nodes: React.ReactNode[] = [];
  let buf = "";
  let bufHit = hit.has(0);
  for (let i = 0; i < path.length; i++) {
    const h = hit.has(i);
    if (h !== bufHit) {
      nodes.push(bufHit ? <span key={i} className="qo-hl">{buf}</span> : buf);
      buf = "";
      bufHit = h;
    }
    buf += path[i];
  }
  nodes.push(bufHit ? <span key={path.length} className="qo-hl">{buf}</span> : buf);
  return nodes;
}

/// Cmd+P quick-open: fuzzy-find a tracked file by name and open it in the File
/// preview. Starts as a centered, empty search box; typing raises the box and
/// reveals up to MAX_RESULTS matches below, with matched characters highlighted.
export default function QuickOpen({
  repoPath,
  onOpen,
  onClose,
}: {
  repoPath: string;
  onOpen: (path: string) => void;
  onClose: () => void;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const deferredQuery = useDeferredValue(query);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api.listFiles(repoPath).then((f) => { if (alive) setFiles(f); }, () => {});
    return () => { alive = false; };
  }, [repoPath]);

  // Whether the panel is expanded (something typed). Derived from `query`, not the
  // deferred value, so the box starts rising the instant the user types.
  const open = query.replace(/\s+/g, "").length > 0;

  const results = useMemo(() => {
    const q = deferredQuery.replace(/\s+/g, "").toLowerCase();
    if (!q) return [];
    const scored: { path: string; positions: number[]; score: number }[] = [];
    for (const path of files) {
      const positions = matchPositions(path, q);
      if (positions) scored.push({ path, positions, score: scoreOf(path, positions) });
    }
    scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
    return scored.slice(0, MAX_RESULTS);
  }, [files, deferredQuery]);

  useEffect(() => setActive(0), [deferredQuery]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".palette-item.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (path: string | undefined) => {
    if (!path) return;
    onClose();
    onOpen(path);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0))); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(results[active]?.path); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className={"quick-open" + (open ? " open" : "")} onClick={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          spellCheck={false}
          placeholder="Go to file…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className={"quick-open-results" + (open ? " open" : "")}>
          <div className="quick-open-list" ref={listRef}>
            {results.map((r, i) => (
              <div
                key={r.path}
                className={"palette-item" + (i === active ? " active" : "")}
                onMouseMove={() => setActive(i)}
                onClick={() => pick(r.path)}
              >
                {highlight(r.path, r.positions)}
              </div>
            ))}
            {open && results.length === 0 && (
              <div className="palette-empty">{files.length ? "No matching file" : "No tracked files"}</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
