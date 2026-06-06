import { useEffect, useMemo, useRef, useState } from "react";
import type { DiffLine, FileDiff } from "../types";

const ROW_H = 18; // must match .diff-line / .diff-hunk-header height in CSS
const OVERSCAN = 20;

interface Props {
  diff: FileDiff | null;
  onLoadFull?: () => void;
}

type Row = { hunk: string } | { line: DiffLine };

/// Virtualized unified diff: only the rows in (and just around) the viewport are
/// mounted, so even a 168k-line file scrolls smoothly. Rows are fixed-height and
/// the scroll height is faked with top/bottom padding spacers.
export default function DiffViewer({ diff, onLoadFull }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  const rows = useMemo<Row[]>(() => {
    if (!diff) return [];
    const out: Row[] = [];
    for (const h of diff.hunks) {
      if (h.header) out.push({ hunk: h.header });
      for (const l of h.lines) out.push({ line: l });
    }
    return out;
  }, [diff]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => setScrollTop(el.scrollTop);
    el.addEventListener("scroll", onScroll);
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, []);

  // Jump back to the top whenever a different file is shown.
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
    setScrollTop(0);
  }, [diff?.path]);

  if (!diff) return <div className="empty-hint">Select a file to view its diff.</div>;
  if (diff.binary) return <div className="empty-hint">Binary file - no text diff.</div>;
  if (rows.length === 0) return <div className="empty-hint">No changes in {diff.path}.</div>;

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);

  return (
    <div className="diff">
      <div className="diff-path">
        <span className="diff-path-name">{diff.path}</span>
        {diff.truncated && onLoadFull && (
          <button className="mini-btn" onClick={onLoadFull} title="Load the entire file">
            Load full file
          </button>
        )}
      </div>
      <div className="diff-scroll" ref={ref}>
        <div style={{ paddingTop: start * ROW_H, paddingBottom: (rows.length - end) * ROW_H }}>
          {rows.slice(start, end).map((row, i) =>
            "hunk" in row ? (
              <div key={start + i} className="diff-hunk-header">
                {row.hunk}
              </div>
            ) : (
              <DiffRow key={start + i} line={row.line} />
            )
          )}
        </div>
      </div>
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
  const cls = line.origin === "+" ? "add" : line.origin === "-" ? "del" : "ctx";
  return (
    <div className={`diff-line ${cls}`}>
      <span className="ln">{line.old_lineno ?? ""}</span>
      <span className="ln">{line.new_lineno ?? ""}</span>
      <span className="sign">{line.origin === " " ? "" : line.origin}</span>
      <span className="code">{line.content || " "}</span>
    </div>
  );
}
