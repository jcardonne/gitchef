import { useEffect, useRef, useState } from "react";
import type { FileContent } from "../types";

const ROW_H = 18; // must match .diff-line height in CSS
const OVERSCAN = 20;

interface Props {
  content: FileContent | null;
}

/// Virtualized whole-file view - the counterpart to DiffViewer for the "File"
/// preview tab. Same fixed-row virtualization (only the rows in/around the
/// viewport are mounted), so a huge file still scrolls smoothly. Plain content:
/// one line-number gutter, no +/- signs, no selection or hunk menus.
export default function FileView({ content }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  // Reset scroll whenever the shown file (or its loaded content) changes.
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
    setScrollTop(0);
  }, [content]);

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

  if (!content) return <div className="empty-hint">Select a file to view it.</div>;
  if (content.binary) return <div className="empty-hint">Binary file - no preview.</div>;
  if (content.lines.length === 0) return <div className="empty-hint">Empty file.</div>;

  const lines = content.lines;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(lines.length, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);

  return (
    <div className="diff fileview">
      <div className="diff-scroll" ref={ref}>
        <div style={{ paddingTop: start * ROW_H, paddingBottom: (lines.length - end) * ROW_H }}>
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
