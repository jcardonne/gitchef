// Appearance manager: persists two orthogonal axes and applies them to <html>.
//   - mode  -> `data-theme`   (light / dark / system), drives neutrals + contrast
//   - palette -> `data-palette` (accent + surface temperature)
// "system" tracks the OS appearance and live-updates when it flips. The default
// palette ("classic") sets no attribute, so :root in styles.css stays the source
// of truth and existing snapshots/tests are unaffected.
import { notifyPrefs } from "./storage";

export type Theme = "light" | "dark" | "system";
export type Palette = "classic" | "copper" | "slate" | "carbon" | "basil" | "ube";
export type Density = "comfortable" | "compact";

const KEY = "gitchef.theme";
const PALETTE_KEY = "gitchef.palette";
const DENSITY_KEY = "gitchef.density";
const media = window.matchMedia("(prefers-color-scheme: dark)");

export interface PaletteInfo {
  id: Palette;
  name: string;
  tagline: string;
  /// Mini-preview swatch (bg, surface, accent, add, del) shown in Settings.
  swatch: [string, string, string, string, string];
}

/// Single source of truth for the palette picker. Swatches mirror the dark
/// token values defined in styles.css so the cards preview the real thing.
export const PALETTES: PaletteInfo[] = [
  { id: "classic", name: "Classic", tagline: "GitHub-style, the default", swatch: ["#0d1117", "#161c26", "#22c5a4", "#2ea043", "#f7768e"] },
  { id: "copper", name: "Mise en place", tagline: "Warm carbon + copper", swatch: ["#15130f", "#231e17", "#e08a4b", "#7fb069", "#e5708a"] },
  { id: "slate", name: "Slate & Teal", tagline: "Cool, off-GitHub", swatch: ["#0e1416", "#1a2326", "#22c5a4", "#35b36b", "#f2667e"] },
  { id: "carbon", name: "Carbon", tagline: "Neutral carbon + indigo", swatch: ["#0b0c0e", "#191b1f", "#5b8def", "#4fb477", "#e86a7e"] },
  { id: "basil", name: "Basil", tagline: "Earthy + herb green", swatch: ["#0e130f", "#19231b", "#5bbd6e", "#3fa35a", "#ef6f7a"] },
  { id: "ube", name: "Ube", tagline: "Dark + soft violet", swatch: ["#110e16", "#1e1827", "#b08cf0", "#5cb98a", "#ef6f9a"] },
];

export function getTheme(): Theme {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function getPalette(): Palette {
  const v = localStorage.getItem(PALETTE_KEY);
  return v === "copper" || v === "slate" || v === "carbon" || v === "basil" || v === "ube" ? v : "classic";
}

export function resolvedTheme(): "light" | "dark" {
  const t = getTheme();
  return t === "system" ? (media.matches ? "dark" : "light") : t;
}

/// Write both axes onto <html> from the persisted prefs. Classic clears the
/// palette attribute so :root remains the default.
function applyAppearance(): void {
  document.documentElement.dataset.theme = resolvedTheme();
  const palette = getPalette();
  if (palette === "classic") delete document.documentElement.dataset.palette;
  else document.documentElement.dataset.palette = palette;
  const density = getDensity();
  if (density === "comfortable") delete document.documentElement.dataset.density;
  else document.documentElement.dataset.density = density;
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(KEY, theme);
  applyAppearance();
}

export function setPalette(palette: Palette): void {
  localStorage.setItem(PALETTE_KEY, palette);
  applyAppearance();
}

export function getDensity(): Density {
  return localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
}

/// Density changes a CSS var consumed by virtualized lists; the `gitchef:prefs`
/// event lets already-mounted views re-read it live.
export function setDensity(density: Density): void {
  localStorage.setItem(DENSITY_KEY, density);
  applyAppearance();
  notifyPrefs();
}

/// Cycle order for the TabBar button: light -> dark -> system -> light.
export function nextTheme(t: Theme): Theme {
  return t === "light" ? "dark" : t === "dark" ? "system" : "light";
}

/// Apply on boot and keep "system" in sync with the OS.
export function initTheme(): void {
  applyAppearance();
  media.addEventListener("change", () => {
    if (getTheme() === "system") applyAppearance();
  });
}
