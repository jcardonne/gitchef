import { useEffect } from "react";
import { SHORTCUT_SECTIONS, keyLabel, type KeyToken } from "../shortcuts";

function Keycap({ token }: { token: KeyToken }) {
  return <kbd className="keycap">{keyLabel(token)}</kbd>;
}

/// Discord-style keyboard cheat-sheet. Opened with Cmd/Ctrl+/, closed on Esc,
/// backdrop click, or the close button. Content is rendered from the shared
/// keymap (src/shortcuts.ts) so it never drifts from the real bindings.
export default function ShortcutsModal({ onClose }: { onClose: () => void }) {
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
            ✕
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
