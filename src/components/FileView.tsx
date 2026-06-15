import { useVirtual } from "../useVirtual";
import type { FileContent } from "../types";

const ROW_H = 18; // must match .diff-line height in CSS

interface Props {
  content: FileContent | null;
}

/// Virtualized whole-file view - the counterpart to DiffViewer for the "File"
/// preview tab. Same fixed-row virtualization (only the rows in/around the
/// viewport are mounted), so a huge file still scrolls smoothly. Plain content:
/// one line-number gutter, no +/- signs, no selection or hunk menus.
export default function FileView({ content }: Props) {
  const { ref, start, end, padTop, padBottom } = useVirtual(
    content?.lines.length ?? 0,
    ROW_H,
    content
  );

  if (!content) return <div className="empty-hint">Select a file to view it.</div>;
  if (content.binary) return <div className="empty-hint">Binary file - no preview.</div>;
  if (content.lines.length === 0) return <div className="empty-hint">Empty file.</div>;

  const lines = content.lines;

  return (
    <div className="diff fileview">
      <div className="diff-scroll" ref={ref}>
        <div style={{ paddingTop: padTop, paddingBottom: padBottom }}>
          {lines.slice(start, end).map((l, i) => (
            <div className="diff-line ctx" key={start + i}>
              <span className="ln">{start + i + 1}</span>
              <span className="code">{l || " "}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
