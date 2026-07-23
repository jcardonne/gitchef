// Find-in-preview core: pure, DOM-free match computation shared by the file,
// blame, and diff views. The preview is virtualized (only on-screen rows are
// mounted), so a native browser find can't see off-screen text - we search the
// full in-memory model instead and let the caller scroll matches into view.

/// A single match occurrence: which virtual row, which cell within that row
/// (0 for single-column views; 0 = left / 1 = right in the split diff), and the
/// character range within that cell's text.
export interface Match {
  row: number;
  cell: number;
  start: number;
  end: number;
}

/// One match range projected onto a rendered line, with `current` set for the
/// active match so it can carry a distinct style. `start`/`end` are offsets in
/// the line's text; used by `overlayMatches` to split the syntax spans.
export interface Hit {
  start: number;
  end: number;
  current: boolean;
}

/// Every occurrence of `query` across the per-row, per-cell text of a view.
/// Case-insensitive unless `caseSensitive`. Matches are returned in reading
/// order (row, then cell, then position) so stepping walks the document
/// top-to-bottom; occurrences within a cell are non-overlapping. Empty query ->
/// no matches.
export function computeMatches(rowCells: string[][], query: string, caseSensitive: boolean): Match[] {
  const out: Match[] = [];
  if (!query) return out;
  const needle = caseSensitive ? query : query.toLowerCase();
  const n = needle.length;
  for (let row = 0; row < rowCells.length; row++) {
    const cells = rowCells[row];
    for (let cell = 0; cell < cells.length; cell++) {
      const raw = cells[cell];
      if (!raw) continue;
      const hay = caseSensitive ? raw : raw.toLowerCase();
      let i = hay.indexOf(needle);
      while (i !== -1) {
        out.push({ row, cell, start: i, end: i + n });
        i = hay.indexOf(needle, i + n); // non-overlapping
      }
    }
  }
  return out;
}
