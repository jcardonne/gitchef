import { useEffect, useMemo, useRef, useState } from "react";

/// One entry in the palette. `run` fires the action (handlers already wrap
/// themselves in RepoView's `run` bus, so there's nothing to await here).
export interface PaletteCommand {
  title: string;
  run: () => void;
}

/// A Cmd+K command palette: type to fuzzy-filter, arrows to move, Enter to run,
/// Esc / backdrop-click to close. Purely presentational - the command list and
/// its actions come from RepoView, where the state and handlers already live.
export default function CommandPalette({
  commands,
  onClose,
}: {
  commands: PaletteCommand[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return commands;
    return commands.filter((c) => {
      const hay = c.title.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }, [commands, query]);

  // Reset the highlight to the top whenever the filter changes.
  useEffect(() => setActive(0), [query]);
  // Keep the highlighted row in view during arrow navigation.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".palette-item.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const fire = (cmd: PaletteCommand | undefined) => {
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      fire(filtered[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          autoFocus
          placeholder="Type a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="palette-empty">No matching command</div>
          ) : (
            filtered.map((cmd, i) => (
              <div
                key={cmd.title}
                className={"palette-item" + (i === active ? " active" : "")}
                onMouseMove={() => setActive(i)}
                onClick={() => fire(cmd)}
              >
                {cmd.title}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
