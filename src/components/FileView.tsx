import { useMemo } from "react";
import { useVirtual } from "../useVirtual";
import type { FileContent } from "../types";
import EmptyState, { DocIcon, BinaryIcon } from "./EmptyState";
import { langForPath, highlightTokens, composeSpans } from "../highlight";
import { useFind, scrollRowIntoView } from "../useFind";
import FindBar from "./FindBar";
import { renderCode } from "./CodeLine";

const ROW_H = 18; // must match .diff-line height in CSS

interface Props {
  content: FileContent | null;
  findOpen: boolean;
  onFindClose: () => void;
}

/// Virtualized whole-file view - the counterpart to DiffViewer for the "File"
/// preview tab. Same fixed-row virtualization (only the rows in/around the
/// viewport are mounted), so a huge file still scrolls smoothly. Syntax-colored
/// per its path; no +/- signs, selection, or hunk menus. Ctrl/Cmd+F opens a
/// find bar that searches the whole file (not just mounted rows).
export default function FileView({ content, findOpen, onFindClose }: Props) {
  const lines = content?.lines ?? [];
  const lang = useMemo(() => (content ? langForPath(content.path) : null), [content]);
  // Only build the search corpus while the bar is open - one cell per line.
  const rowCells = useMemo(() => (findOpen ? lines.map((l) => [l]) : []), [findOpen, lines]);
  const { ref, el, start, end, padTop, padBottom } = useVirtual(lines.length, ROW_H, content);
  const find = useFind(findOpen, rowCells, (row) => scrollRowIntoView(el, ROW_H, row));

  if (!content) return <EmptyState icon={<DocIcon />} title="No file selected" hint="Pick a file from the list to view it." />;
  if (content.binary) return <EmptyState icon={<BinaryIcon />} title="Binary file" hint="No preview available." />;
  if (lines.length === 0) return <EmptyState icon={<DocIcon />} title="Empty file" hint="This file has no content." />;

  return (
    <div className="diff fileview">
      {findOpen && <FindBar api={find} onClose={onFindClose} />}
      <div className="diff-scroll" ref={ref}>
        <div style={{ paddingTop: padTop, paddingBottom: padBottom }}>
          {lines.slice(start, end).map((l, i) => {
            const idx = start + i;
            return (
              <div className="diff-line ctx" key={idx}>
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
