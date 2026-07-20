import { useCallback, useEffect, useRef, useState } from "react";

const OVERSCAN = 20;

/// Fixed-row windowing shared by the change list, the diff view, and the file
/// preview. Attach the returned `ref` to the scroll container (overflow:auto,
/// uniform `rowH`px rows); render `items.slice(start, end)` inside a wrapper
/// styled with `padTop`/`padBottom` so the scrollbar reflects the full height
/// while only the visible rows (plus an overscan margin) stay mounted.
///
/// `scrollTop` is returned for callers that need the live offset (e.g. keyboard
/// scroll-into-view). Pass `resetKey` to snap back to the top whenever the
/// underlying content changes (a newly selected file/diff); omit it to keep the
/// scroll position across updates (the file list as you stage rows).
export function useVirtual(total: number, rowH: number, resetKey?: unknown) {
  // Callback ref, not a plain object ref: callers render an empty state instead
  // of the scroll container until their content arrives, so on the first render
  // there is no node. An object ref can't announce the node appearing later, and
  // a mount-only effect would leave viewportH at 0 forever - only the overscan
  // rows would render and scrolling would do nothing. React calls this on
  // mount/unmount, which re-runs the effect at the right moment. `el` is exposed
  // for callers that need to read/query the node (see ChangeList).
  const el = useRef<HTMLDivElement | null>(null);
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((n: HTMLDivElement | null) => {
    el.current = n;
    setNode(n);
  }, []);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  // Track the scroll viewport so only the rows in/around it stay mounted.
  useEffect(() => {
    if (!node) return;
    const onScroll = () => setScrollTop(node.scrollTop);
    node.addEventListener("scroll", onScroll);
    const ro = new ResizeObserver(() => setViewportH(node.clientHeight));
    ro.observe(node);
    setViewportH(node.clientHeight);
    return () => {
      node.removeEventListener("scroll", onScroll);
      ro.disconnect();
    };
  }, [node]);

  // Jump back to the top when the underlying content changes. With no resetKey
  // this runs only on mount (a no-op), preserving scroll across updates.
  useEffect(() => {
    if (el.current) el.current.scrollTop = 0;
    setScrollTop(0);
  }, [resetKey]);

  const start = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + viewportH) / rowH) + OVERSCAN);
  return { ref, el, start, end, scrollTop, padTop: start * rowH, padBottom: (total - end) * rowH };
}
