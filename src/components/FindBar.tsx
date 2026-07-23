import type { FindApi } from "../useFind";

/// The find-in-preview bar: query input, match-case toggle, `n/m` counter, and
/// prev/next/close. Floated top-right over the preview (see `.preview-find`).
/// Mirrors the commit-graph search bar so both searches feel identical: Enter /
/// Shift+Enter step, Escape closes. `api` is the shared `useFind` state; `onClose`
/// is owned by the parent (it owns the open flag).
export default function FindBar({ api, onClose }: { api: FindApi; onClose: () => void }) {
  const { query, setQuery, caseSensitive, toggleCase, count, index, step, inputRef } = api;
  return (
    <div className="preview-find">
      <input
        ref={inputRef}
        className="graph-search-input"
        value={query}
        placeholder="Find in file…"
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          } else if (e.key === "Enter") {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className="graph-search-count">{count ? `${index}/${count}` : query ? "0/0" : ""}</span>
      <button
        className={`search-nav text${caseSensitive ? " active" : ""}`}
        onClick={toggleCase}
        title="Match case"
      >
        Aa
      </button>
      <button className="search-nav" disabled={!count} onClick={() => step(-1)} title="Previous (Shift+Enter)">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 10l4-4 4 4" /></svg>
      </button>
      <button className="search-nav" disabled={!count} onClick={() => step(1)} title="Next (Enter)">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6l4 4 4-4" /></svg>
      </button>
      <button className="search-nav" onClick={onClose} title="Close (Esc)">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>
      </button>
    </div>
  );
}
