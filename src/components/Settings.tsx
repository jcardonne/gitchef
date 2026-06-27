import { useEffect, useState, type ReactNode } from "react";
import { PALETTES, getDensity, setDensity, type Palette, type Theme, type Density } from "../theme";
import { getPullDefault, setPullDefault, getSortAsc, setSortAsc, getGraphColumnVisibility, setGraphColumnVisibility, notifyPrefs, type PullAction, type GraphColumnVisibility } from "../storage";
import { SHORTCUT_SECTIONS, comboHint, keyLabel } from "../shortcuts";
import { useKeycapPresses } from "../useKeycapPresses";

interface Props {
  theme: Theme;
  palette: Palette;
  onChangeTheme: (theme: Theme) => void;
  onChangePalette: (palette: Palette) => void;
  onClose: () => void;
}

type Section = "appearance" | "general" | "keyboard";

/// 24-grid stroke glyph used before field titles and option labels.
const gi = (path: ReactNode) => (
  <svg className="opt-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {path}
  </svg>
);

// Field-title glyphs.
const TITLE = {
  mode: gi(<><circle cx="12" cy="12" r="9" /><path d="M12 3v18a9 9 0 0 0 0-18z" fill="currentColor" stroke="none" /></>),
  theme: gi(<><path d="M12 3a9 9 0 1 0 1 17.9c1 .1 1.3-1.3.6-1.9-.6-.6-.2-1.6.7-1.6H17a4 4 0 0 0 4-4 9 9 0 0 0-9-10.4z" /><circle cx="8" cy="11" r="1" /><circle cx="12" cy="8" r="1" /><circle cx="16" cy="11" r="1" /></>),
  density: gi(<path d="M3 6h18M3 12h18M3 18h18" />),
  pull: gi(<path d="M12 3v12M7 10l5 5 5-5M5 21h14" />),
  sort: gi(<path d="M7 4v16M4 7l3-3 3 3M13 8h7M13 12h5M13 16h3" />),
  columns: gi(<><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="5" height="16" rx="1" /><rect x="17" y="4" width="4" height="16" rx="1" /></>),
} as const;

const MODES: { id: Theme; label: string; icon: ReactNode }[] = [
  { id: "light", label: "Light", icon: gi(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>) },
  { id: "dark", label: "Dark", icon: gi(<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />) },
  { id: "system", label: "System", icon: gi(<><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></>) },
];

const DENSITIES: { id: Density; label: string; icon: ReactNode }[] = [
  { id: "comfortable", label: "Comfortable", icon: gi(<><rect x="3" y="4" width="18" height="7" rx="1.5" /><rect x="3" y="13" width="18" height="7" rx="1.5" /></>) },
  { id: "compact", label: "Compact", icon: gi(<><rect x="3" y="4" width="18" height="4" rx="1" /><rect x="3" y="10" width="18" height="4" rx="1" /><rect x="3" y="16" width="18" height="4" rx="1" /></>) },
];

const PULLS: { id: PullAction; label: string; icon: ReactNode }[] = [
  { id: "fetch", label: "Fetch", icon: gi(<><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v4h-4" /></>) },
  { id: "ff", label: "Merge", icon: gi(<><circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 21V9a9 9 0 0 0 9 9" /></>) },
  { id: "ff-only", label: "FF-only", icon: gi(<path d="M13 19l9-7-9-7zM2 19l9-7-9-7z" />) },
  { id: "rebase", label: "Rebase", icon: gi(<><path d="M21 3v5h-5M3 21v-5h5" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 12a9 9 0 0 1-15 6.7L3 16" /></>) },
];

const SORTS: { label: string; asc: boolean; icon: ReactNode }[] = [
  { label: "Newest first", asc: false, icon: gi(<path d="M12 5v14M6 13l6 6 6-6" />) },
  { label: "Oldest first", asc: true, icon: gi(<path d="M12 19V5M6 11l6-6 6 6" />) },
];

const COLUMNS: { key: keyof GraphColumnVisibility; label: string; icon: ReactNode }[] = [
  { key: "graph", label: "Group", icon: gi(<><line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></>) },
  { key: "message", label: "Message", icon: gi(<path d="M4 7h16M4 12h16M4 17h9" />) },
  { key: "author", label: "Author", icon: gi(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>) },
  { key: "sha", label: "SHA", icon: gi(<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />) },
  { key: "date", label: "Date", icon: gi(<><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /></>) },
];

const icon = (path: ReactNode) => (
  <svg className="settings-nav-icon" width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {path}
  </svg>
);

const SECTIONS: { id: Section; label: string; icon: ReactNode }[] = [
  { id: "general", label: "General", icon: icon(<><path d="M2 4.5h6M11.5 4.5h2.5M2 11.5h2.5M8 11.5h6" /><circle cx="9.5" cy="4.5" r="1.8" /><circle cx="5" cy="11.5" r="1.8" /></>) },
  { id: "appearance", label: "Appearance", icon: icon(<path d="M8 2.5C5.5 5.5 4 7.3 4 9.3a4 4 0 0 0 8 0c0-2-1.5-3.8-4-6.8z" />) },
  { id: "keyboard", label: "Keyboard", icon: icon(<><rect x="1.5" y="4" width="13" height="8" rx="1.5" /><path d="M4 7h0M7 7h0M10 7h0M12.5 7h0M5.5 9.5h5" /></>) },
];

/// Full-page Settings view (rendered over the repo content, not a modal). Esc or
/// the close button returns to the workspace. Behavior prefs persist to storage
/// and broadcast `gitchef:prefs` so already-mounted views update live.
export default function Settings({ theme, palette, onChangeTheme, onChangePalette, onClose }: Props) {
  const [section, setSection] = useState<Section>("general");
  const [density, setDensityState] = useState(getDensity);
  const [pullDefault, setPullState] = useState(getPullDefault);
  const [sortAsc, setSortState] = useState(getSortAsc);
  const [cols, setColsState] = useState(getGraphColumnVisibility);
  useKeycapPresses(section === "keyboard");

  const changeDensity = (d: Density) => {
    setDensity(d);
    setDensityState(d);
  };
  const changePull = (p: PullAction) => {
    setPullDefault(p);
    setPullState(p);
  };
  const changeSort = (asc: boolean) => {
    setSortAsc(asc);
    setSortState(asc);
  };
  const toggleCol = (key: keyof GraphColumnVisibility) => {
    const visible = Object.values(cols).filter(Boolean).length;
    if (cols[key] && visible <= 1) return; // always keep at least one column
    const next = { ...cols, [key]: !cols[key] };
    setGraphColumnVisibility(next);
    notifyPrefs();
    setColsState(next);
  };

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
    <div className="settings-page">
      <div className="settings-head">
        <h2>Settings</h2>
        <span className="settings-hint">{comboHint(["mod", ","])}</span>
        <button className="settings-close" onClick={onClose} title="Close (Esc)" aria-label="Close">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>

      <div className="settings-body">
        <nav className="settings-nav">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              className={section === s.id ? "active" : ""}
              onClick={() => setSection(s.id)}
            >
              {s.icon}
              {s.label}
            </button>
          ))}
        </nav>

        <div className="settings-panel">
          {section === "appearance" && (
            <>
              <div className="settings-field">
                <div className="settings-field-label">{TITLE.mode}<span>Mode</span></div>
                <div className="settings-field-hint">Light, dark, or follow the system appearance.</div>
                <div className="mode-seg">
                  {MODES.map((m) => (
                    <button key={m.id} className={theme === m.id ? "active" : ""} onClick={() => onChangeTheme(m.id)}>
                      {m.icon}<span>{m.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings-field">
                <div className="settings-field-label">{TITLE.theme}<span>Theme</span></div>
                <div className="settings-field-hint">Accent color and surface temperature. Applies live.</div>
                <div className="palette-grid">
                  {PALETTES.map((p) => (
                    <button
                      key={p.id}
                      className={`palette-card${palette === p.id ? " active" : ""}`}
                      onClick={() => onChangePalette(p.id)}
                      aria-pressed={palette === p.id}
                    >
                      <div className="palette-swatch">
                        {p.swatch.map((c, i) => (
                          <span key={i} style={{ background: c }} />
                        ))}
                      </div>
                      <div className="palette-card-body">
                        <span className="palette-card-name">{p.name}</span>
                        {palette === p.id && (
                          <svg className="palette-card-check" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M3.5 8.5l3 3 6-6.5" />
                          </svg>
                        )}
                        <span className="palette-card-tag">{p.tagline}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings-field">
                <div className="settings-field-label">{TITLE.density}<span>Density</span></div>
                <div className="settings-field-hint">Row height of the commit graph.</div>
                <div className="mode-seg">
                  {DENSITIES.map((d) => (
                    <button key={d.id} className={density === d.id ? "active" : ""} onClick={() => changeDensity(d.id)}>
                      {d.icon}<span>{d.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {section === "general" && (
            <>
              <div className="settings-field">
                <div className="settings-field-label">{TITLE.pull}<span>Default pull action</span></div>
                <div className="settings-field-hint">What the Pull button does by default.</div>
                <div className="mode-seg">
                  {PULLS.map((o) => (
                    <button key={o.id} className={pullDefault === o.id ? "active" : ""} onClick={() => changePull(o.id)}>
                      {o.icon}<span>{o.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings-field">
                <div className="settings-field-label">{TITLE.sort}<span>Commit graph order</span></div>
                <div className="settings-field-hint">Sort history by commit date.</div>
                <div className="mode-seg">
                  {SORTS.map((o) => (
                    <button key={o.label} className={sortAsc === o.asc ? "active" : ""} onClick={() => changeSort(o.asc)}>
                      {o.icon}<span>{o.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings-field">
                <div className="settings-field-label">{TITLE.columns}<span>Graph columns</span></div>
                <div className="settings-field-hint">Show or hide commit graph columns.</div>
                <div className="settings-toggles">
                  {COLUMNS.map((c) => (
                    <button
                      key={c.key}
                      className={`settings-toggle${cols[c.key] ? " on" : ""}`}
                      onClick={() => toggleCol(c.key)}
                    >
                      {c.icon}<span>{c.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {section === "keyboard" && (
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
                            <kbd key={i} className="keycap" data-key={t}>{keyLabel(t)}</kbd>
                          ))}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
