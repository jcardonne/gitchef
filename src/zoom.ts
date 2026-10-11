import { getCurrentWebview } from "@tauri-apps/api/webview";

/// Interface zoom (Cmd/Ctrl + "+", "-", "0"). Steps are fixed so zooming in and
/// out always lands on the same values, and the choice persists across launches.
export const ZOOM_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.5, 1.7, 2];
const KEY = "gitchef.zoom";

/// Next step above (dir 1) or below (dir -1) `current`, clamped to the range. A
/// stored value that is not on a step still moves to the nearest step in `dir`.
export function nextZoom(current: number, dir: 1 | -1): number {
  const eps = 1e-6;
  if (dir === 1) return ZOOM_STEPS.find((s) => s > current + eps) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((s) => s < current - eps) ?? ZOOM_STEPS[0];
}

/// Text for the on-screen indicator. Says so when the limit stops further zooming,
/// so a keypress that changes nothing still gives feedback.
export function zoomLabel(z: number): string {
  const pct = `${Math.round(z * 100)}%`;
  if (z <= ZOOM_STEPS[0]) return `Zoom ${pct} (minimum)`;
  if (z >= ZOOM_STEPS[ZOOM_STEPS.length - 1]) return `Zoom ${pct} (maximum)`;
  return z === 1 ? `Zoom ${pct} (default)` : `Zoom ${pct}`;
}

/// Parse a stored zoom, falling back to 1 for anything missing or out of range.
export function parseZoom(raw: string | null): number {
  const n = raw === null ? NaN : parseFloat(raw);
  return Number.isFinite(n) && n >= ZOOM_STEPS[0] && n <= ZOOM_STEPS[ZOOM_STEPS.length - 1] ? n : 1;
}

export function getZoom(): number {
  return parseZoom(localStorage.getItem(KEY));
}

/// Apply and persist a zoom. Uses the webview's own zoom in the desktop app so
/// layout, hit targets and scroll all scale together; falls back to CSS zoom when
/// the Tauri API is unavailable (browser dev server, tests).
export async function applyZoom(z: number): Promise<void> {
  localStorage.setItem(KEY, String(z));
  // Lets the indicator cancel the zoom so it stays one size on screen.
  document.documentElement.style.setProperty("--zoom", String(z));
  try {
    await getCurrentWebview().setZoom(z);
  } catch {
    (document.documentElement.style as CSSStyleDeclaration & { zoom: string }).zoom = String(z);
  }
}

/// Map a keydown to a zoom action, or null. Handles the shifted "+", the unshifted
/// "=" key that carries it on most layouts, the numpad, and "0" for reset.
export function zoomAction(e: { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): "in" | "out" | "reset" | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  if (e.key === "+" || e.key === "=" || e.code === "Equal" || e.code === "NumpadAdd") return "in";
  if (e.key === "-" || e.key === "_" || e.code === "NumpadSubtract") return "out";
  if (e.key === "0" || e.code === "Digit0" || e.code === "Numpad0") return "reset";
  return null;
}
