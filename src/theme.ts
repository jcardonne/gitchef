// Theme manager: persists a light/dark/system preference and applies the
// resolved theme as `data-theme` on <html>. System tracks the OS appearance and
// live-updates when it flips.

export type Theme = "light" | "dark" | "system";

const KEY = "gitchef.theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

export function getTheme(): Theme {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function resolvedTheme(): "light" | "dark" {
  const t = getTheme();
  return t === "system" ? (media.matches ? "dark" : "light") : t;
}

function applyTheme(): void {
  document.documentElement.dataset.theme = resolvedTheme();
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(KEY, theme);
  applyTheme();
}

/// Cycle order for the TabBar button: light -> dark -> system -> light.
export function nextTheme(t: Theme): Theme {
  return t === "light" ? "dark" : t === "dark" ? "system" : "light";
}

/// Apply on boot and keep "system" in sync with the OS.
export function initTheme(): void {
  applyTheme();
  media.addEventListener("change", () => {
    if (getTheme() === "system") applyTheme();
  });
}
