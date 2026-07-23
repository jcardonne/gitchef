import { useEffect, useMemo, useRef, useState } from "react";
import { computeMatches, type Hit, type Match } from "./find";

export interface FindApi {
  query: string;
  setQuery: (q: string) => void;
  caseSensitive: boolean;
  toggleCase: () => void;
  count: number;
  index: number; // 1-based position of the active match, 0 when there are none
  step: (d: number) => void;
  matchesByRow: Map<number, (Hit & { cell: number })[]>;
  inputRef: React.RefObject<HTMLInputElement>;
}

/// Find-in-view state machine shared by the file, blame, diff, and conflict
/// previews. `rowCells[i]` is the searchable text of row i (one cell for the
/// single-column views, `[left, right]` for the split diff). Matches are found
/// over the whole model - not the DOM - so a hit scrolled out of a virtualized
/// window is still counted, and `scrollToRow` brings the active one into view.
/// Only meaningful while `open`; the caller owns the open flag.
///
/// `scrollToRow(row)` is view-specific: virtualized views compute the offset
/// from the fixed row height (see `scrollRowIntoView`); the non-virtualized
/// conflict view scrolls its already-mounted line element into view.
export function useFind(
  open: boolean,
  rowCells: string[][],
  scrollToRow: (row: number) => void
): FindApi {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input when the bar opens; drop the query when it closes so a
  // reopen starts clean (and stale highlights vanish).
  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setQuery("");
  }, [open]);
  // A new query/case starts navigation from the first match.
  useEffect(() => setIdx(0), [query, caseSensitive]);

  const matches = useMemo<Match[]>(
    () => (open && query ? computeMatches(rowCells, query, caseSensitive) : []),
    [open, query, caseSensitive, rowCells]
  );
  // Guard the index against a shrinking match list (e.g. the query grew), so the
  // counter never reads past the end and the active match stays valid.
  const safeIdx = matches.length ? Math.min(idx, matches.length - 1) : 0;
  const current = matches[safeIdx] ?? null;

  const step = (d: number) => {
    if (!matches.length) return;
    setIdx((i) => (Math.min(i, matches.length - 1) + d + matches.length) % matches.length);
  };

  // Group matches by row for O(1) per-row lookup while rendering, flagging the
  // active one so it renders with the "current" style.
  const matchesByRow = useMemo(() => {
    const m = new Map<number, (Hit & { cell: number })[]>();
    matches.forEach((mt, i) => {
      const arr = m.get(mt.row);
      const hit = { cell: mt.cell, start: mt.start, end: mt.end, current: i === safeIdx };
      if (arr) arr.push(hit);
      else m.set(mt.row, [hit]);
    });
    return m;
  }, [matches, safeIdx]);

  // Bring the active match into view. Kept in a ref so the effect fires only on
  // a match change, always using the latest (per-render) scroller.
  const scrollRef = useRef(scrollToRow);
  scrollRef.current = scrollToRow;
  useEffect(() => {
    if (current) scrollRef.current(current.row);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  return {
    query,
    setQuery,
    caseSensitive,
    toggleCase: () => setCaseSensitive((c) => !c),
    count: matches.length,
    index: matches.length ? safeIdx + 1 : 0,
    step,
    matchesByRow,
    inputRef,
  };
}

/// Scroll fixed-height row `row` to the vertical center of `el`'s viewport - the
/// `scrollToRow` for the virtualized previews, where a row's offset is `row *
/// rowH` even when the row itself is unmounted.
export function scrollRowIntoView(
  el: React.MutableRefObject<HTMLDivElement | null>,
  rowH: number,
  row: number
): void {
  const sc = el.current;
  if (!sc) return;
  const target = row * rowH - sc.clientHeight / 2 + rowH / 2;
  sc.scrollTop = Math.max(0, Math.min(target, sc.scrollHeight - sc.clientHeight));
}
