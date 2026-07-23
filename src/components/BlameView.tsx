import { useMemo } from "react";
import { useVirtual } from "../useVirtual";
import type { BlameHunkInfo, FileContent } from "../types";
import EmptyState, { DocIcon, BinaryIcon } from "./EmptyState";
import { relativeTime } from "../util";
import { langForPath, highlightTokens, composeSpans } from "../highlight";
import { useFind, scrollRowIntoView } from "../useFind";
import FindBar from "./FindBar";
import { renderCode } from "./CodeLine";

const ROW_H = 18; // must match .diff-line height in CSS

/// Whole-file view with a per-line blame gutter (short sha + author), shown once
/// per hunk run like git blame. Clicking a line's gutter jumps to that commit.
/// Virtualized like FileView so a large file still scrolls smoothly, syntax-
/// colored per its path, with the same Ctrl/Cmd+F find over the whole file.
export default function BlameView({
  content,
  hunks,
  onPickCommit,
  findOpen,
  onFindClose,
}: {
  content: FileContent | null;
  hunks: BlameHunkInfo[];
  onPickCommit: (sha: string) => void;
  findOpen: boolean;
  onFindClose: () => void;
}) {
  const lineCount = content?.lines.length ?? 0;
  const lines = content?.lines ?? [];
  const lang = useMemo(() => (content ? langForPath(content.path) : null), [content]);
  // Per-line hunk lookup so each virtualized row finds its blame in O(1).
  const perLine = useMemo(() => {
    const arr: (BlameHunkInfo | null)[] = new Array(lineCount).fill(null);
    for (const h of hunks) {
      for (let l = h.start_line; l < h.start_line + h.lines && l - 1 < lineCount; l++) {
        arr[l - 1] = h;
      }
    }
    return arr;
  }, [hunks, lineCount]);
  const rowCells = useMemo(() => (findOpen ? lines.map((l) => [l]) : []), [findOpen, lines]);

  const { ref, el, start, end, padTop, padBottom } = useVirtual(lineCount, ROW_H, content);
  const find = useFind(findOpen, rowCells, (row) => scrollRowIntoView(el, ROW_H, row));

  if (!content) return <EmptyState icon={<DocIcon />} title="No file selected" hint="Pick a file to blame." />;
  if (content.binary) return <EmptyState icon={<BinaryIcon />} title="Binary file" hint="No blame available." />;
  if (lineCount === 0) return <EmptyState icon={<DocIcon />} title="Empty file" hint="Nothing to blame." />;

  return (
    <div className="diff blameview">
      {findOpen && <FindBar api={find} onClose={onFindClose} />}
      <div className="diff-scroll" ref={ref}>
        <div style={{ paddingTop: padTop, paddingBottom: padBottom }}>
          {lines.slice(start, end).map((l, i) => {
            const idx = start + i;
            const h = perLine[idx];
            // Label only at the first line of each hunk run (grouped like git blame).
            const isStart = !!h && (idx === 0 || perLine[idx - 1] !== h);
            return (
              <div className="diff-line ctx blame-line" key={idx}>
                <span
                  className={"blame-gutter" + (h ? " clickable" : "")}
                  title={h ? `${h.short_id} · ${h.author} · ${relativeTime(h.time)}` : ""}
                  onClick={h ? () => onPickCommit(h.commit_id) : undefined}
                >
                  {isStart && h ? (
                    <>
                      <span className="blame-sha">{h.short_id}</span>
                      <span className="blame-author">{h.author}</span>
                    </>
                  ) : null}
                </span>
                <span className="ln">{idx + 1}</span>
                <span className="code">{renderCode(l || "", composeSpans(highlightTokens(l, lang), null), find.matchesByRow.get(idx))}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
