import { useEffect, useRef } from "react";
import { useEscape } from "../useEscape";
import { SHORTCUT_SECTIONS, keyLabel, type KeyToken } from "../shortcuts";
import { useKeycapPresses } from "../useKeycapPresses";

function Keycap({ token }: { token: KeyToken }) {
  return <kbd className="keycap" data-key={token}>{keyLabel(token)}</kbd>;
}

const SAMPLE_W = 56;
const lane = "var(--accent)";

/// One small drawn sample per status mark in the commit graph, so the encodings can
/// be learned without trial and error. Shapes match GraphView's own drawing.
const GRAPH_KEY: { label: string; sample: JSX.Element }[] = [
  {
    label: "Checked out (HEAD)",
    sample: (
      <>
        <circle cx="28" cy="10" r="6" fill={lane} />
        <circle cx="28" cy="10" r="9" fill="none" stroke={lane} strokeWidth="2" />
      </>
    ),
  },
  {
    label: "Not pushed yet (on this branch)",
    sample: (
      <>
        <path d="M8 10H48" stroke={lane} strokeWidth="6" strokeLinecap="round" opacity="0.28" />
        <path d="M8 10H48" stroke={lane} strokeWidth="2" />
        <circle cx="28" cy="10" r="6" fill={lane} />
        <circle cx="28" cy="10" r="9" fill="none" stroke={lane} strokeWidth="1.5" strokeDasharray="4 3" />
      </>
    ),
  },
  {
    label: "Pushed history",
    sample: (
      <>
        <path d="M8 10H48" stroke={lane} strokeWidth="2" />
        <circle cx="28" cy="10" r="6" fill={lane} />
      </>
    ),
  },
  {
    label: "Published line: unpushed on one side",
    sample: <path d="M4 10H52" stroke="var(--text-dim)" strokeWidth="2" />,
  },
  {
    label: "Someone else's commit (grey)",
    sample: (
      <>
        <circle cx="28" cy="10" r="8" fill="var(--text-dim)" />
        <circle cx="28" cy="10" r="9.5" fill="none" stroke={lane} strokeWidth="1.5" />
      </>
    ),
  },
  {
    label: "Old merged branch (thin)",
    sample: (
      <>
        <path d="M8 10H48" stroke={lane} strokeWidth="1.1" />
        <circle cx="28" cy="10" r="8" fill="var(--text-dim)" />
        <circle cx="28" cy="10" r="9.5" fill="none" stroke={lane} strokeWidth="1" />
      </>
    ),
  },
  {
    label: "Merge edge",
    sample: <path d="M8 10H48" stroke={lane} strokeWidth="1.6" strokeDasharray="4 3" />,
  },
  {
    label: "Uncommitted changes",
    sample: <circle cx="28" cy="10" r="6" fill="none" stroke={lane} strokeWidth="2" strokeDasharray="2.5 2" />,
  },
];

/// Discord-style keyboard cheat-sheet. Opened with Cmd/Ctrl+/, closed on Esc,
/// backdrop click, or the close button. Content is rendered from the shared
/// keymap (src/shortcuts.ts) so it never drifts from the real bindings.
export default function ShortcutsModal({ onClose, graphKey }: { onClose: () => void; graphKey?: boolean }) {
  useKeycapPresses(true);
  const keyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (graphKey) keyRef.current?.scrollIntoView({ block: "start" });
  }, [graphKey]);

  useEscape(onClose);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="shortcuts-modal" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={(e) => e.stopPropagation()}>
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
          <div className="shortcuts-section" ref={keyRef}>
            <h3>Commit graph key</h3>
            <div className="shortcuts-grid">
              {GRAPH_KEY.map((g) => (
                <div key={g.label} className="shortcut-card">
                  <span className="shortcut-label">{g.label}</span>
                  <svg width={SAMPLE_W} height="20" viewBox={`0 0 ${SAMPLE_W} 20`} aria-hidden="true">
                    {g.sample}
                  </svg>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
