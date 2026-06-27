import { useEffect } from "react";
import { SHORTCUT_SECTIONS, keyLabel, type KeyToken } from "../shortcuts";
import { useKeycapPresses } from "../useKeycapPresses";

function Keycap({ token }: { token: KeyToken }) {
  return <kbd className="keycap" data-key={token}>{keyLabel(token)}</kbd>;
}

/// Discord-style keyboard cheat-sheet. Opened with Cmd/Ctrl+/, closed on Esc,
/// backdrop click, or the close button. Content is rendered from the shared
/// keymap (src/shortcuts.ts) so it never drifts from the real bindings.
export default function ShortcutsModal({ onClose }: { onClose: () => void }) {
  useKeycapPresses(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="shortcuts-modal" onClick={(e) => e.stopPropagation()}>
        <div className="shortcuts-head">
          <h2>
            Keyboard Combos
            <span className="shortcuts-open-hint">
              <Keycap token="mod" />
              <Keycap token="/" />
            </span>
          </h2>
          <button className="shortcuts-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>
        <p className="shortcuts-sub">Drive GitChef without leaving the keyboard.</p>
        <div className="shortcuts-sections">
          {SHORTCUT_SECTIONS.map((sec) => (
            <div key={sec.title} className="shortcuts-section">
              <h3>{sec.title}</h3>
              <div className="shortcuts-grid">
                {sec.items.map((s) => (
                  <div key={s.label} className="shortcut-card">
                    <span className="shortcut-label">{s.label}</span>
                    <span className="shortcut-keys">
                      {s.combo.map((t, i) => (
                        <Keycap key={i} token={t} />
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
