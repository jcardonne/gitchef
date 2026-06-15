import { useEffect, useRef, useState } from "react";

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
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  // Track the scroll viewport so only the rows in/around it stay mounted.
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

  // Jump back to the top when the underlying content changes. With no resetKey
  // this runs only on mount (a no-op), preserving scroll across updates.
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
    setScrollTop(0);
  }, [resetKey]);

  const start = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + viewportH) / rowH) + OVERSCAN);
  return { ref, start, end, scrollTop, padTop: start * rowH, padBottom: (total - end) * rowH };
}
