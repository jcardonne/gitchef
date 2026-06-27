import { useEffect, useState } from "react";
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

const MODES: { id: Theme; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "System" },
];

const DENSITIES: { id: Density; label: string }[] = [
  { id: "comfortable", label: "Comfortable" },
  { id: "compact", label: "Compact" },
];

const PULLS: { id: PullAction; label: string }[] = [
  { id: "fetch", label: "Fetch" },
  { id: "ff", label: "Merge" },
  { id: "ff-only", label: "FF-only" },
  { id: "rebase", label: "Rebase" },
];

const SORTS: { label: string; asc: boolean }[] = [
  { label: "Newest first", asc: false },
  { label: "Oldest first", asc: true },
];

const COLUMNS: { key: keyof GraphColumnVisibility; label: string }[] = [
  { key: "graph", label: "Group" },
  { key: "message", label: "Message" },
  { key: "author", label: "Author" },
  { key: "sha", label: "SHA" },
  { key: "date", label: "Date" },
];

const SECTIONS: { id: Section; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "general", label: "General" },
  { id: "keyboard", label: "Keyboard" },
];

/// Full-page Settings view (rendered over the repo content, not a modal). Esc or
/// the close button returns to the workspace. Behavior prefs persist to storage
/// and broadcast `gitchef:prefs` so already-mounted views update live.
export default function Settings({ theme, palette, onChangeTheme, onChangePalette, onClose }: Props) {
  const [section, setSection] = useState<Section>("appearance");
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
              {s.label}
            </button>
          ))}
        </nav>

        <div className="settings-panel">
          {section === "appearance" && (
            <>
              <div className="settings-field">
                <div className="settings-field-label">Mode</div>
                <div className="settings-field-hint">Light, dark, or follow the system appearance.</div>
                <div className="mode-seg">
                  {MODES.map((m) => (
                    <button key={m.id} className={theme === m.id ? "active" : ""} onClick={() => onChangeTheme(m.id)}>
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings-field">
                <div className="settings-field-label">Theme</div>
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
                <div className="settings-field-label">Density</div>
                <div className="settings-field-hint">Row height of the commit graph.</div>
                <div className="mode-seg">
                  {DENSITIES.map((d) => (
                    <button key={d.id} className={density === d.id ? "active" : ""} onClick={() => changeDensity(d.id)}>
                      {d.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          )}

          {section === "general" && (
            <>
              <div className="settings-field">
                <div className="settings-field-label">Default pull action</div>
                <div className="settings-field-hint">What the Pull button does by default.</div>
                <div className="mode-seg">
                  {PULLS.map((o) => (
                    <button key={o.id} className={pullDefault === o.id ? "active" : ""} onClick={() => changePull(o.id)}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings-field">
                <div className="settings-field-label">Commit graph order</div>
                <div className="settings-field-hint">Sort history by commit date.</div>
                <div className="mode-seg">
                  {SORTS.map((o) => (
                    <button key={o.label} className={sortAsc === o.asc ? "active" : ""} onClick={() => changeSort(o.asc)}>
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="settings-field">
                <div className="settings-field-label">Graph columns</div>
                <div className="settings-field-hint">Show or hide commit graph columns.</div>
                <div className="settings-toggles">
                  {COLUMNS.map((c) => (
                    <button
                      key={c.key}
                      className={`settings-toggle${cols[c.key] ? " on" : ""}`}
                      onClick={() => toggleCol(c.key)}
                    >
                      {c.label}
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
