/// Single source of truth for keyboard shortcuts. Drives the cheat-sheet modal
/// (ShortcutsModal) and the button tooltips, and documents what the handlers in
/// App / RepoView / StagingPanel implement. Keep this list in sync with them.

export const isMac = navigator.platform.toLowerCase().includes("mac");

/// A combo is an ordered list of key tokens:
///   "mod"  -> Cmd on macOS / Ctrl elsewhere
///   "ctrl" -> literal Control (e.g. Ctrl+Tab, even on macOS)
///   "shift" / "alt" -> modifiers
///   named keys ("Enter", "Tab", "Space", "ArrowUp"…) or a printable letter.
export type KeyToken = string;

export interface Shortcut {
  label: string;
  combo: KeyToken[];
}

export interface ShortcutSection {
  title: string;
  items: Shortcut[];
}

export const SHORTCUT_SECTIONS: ShortcutSection[] = [
  {
    title: "Changes & Commit",
    items: [
      { label: "Stage all (or selection)", combo: ["mod", "shift", "S"] },
      { label: "Unstage all (or selection)", combo: ["mod", "shift", "U"] },
      { label: "Commit", combo: ["mod", "Enter"] },
    ],
  },
  {
    title: "Files list (when focused)",
    items: [
      { label: "Move between files", combo: ["ArrowUp", "ArrowDown"] },
      { label: "Extend selection", combo: ["shift", "ArrowUp", "ArrowDown"] },
      { label: "Select all", combo: ["mod", "A"] },
      { label: "Stage / unstage file", combo: ["Space"] },
      { label: "Open file diff", combo: ["Enter"] },
    ],
  },
  {
    title: "Commit graph (when focused)",
    items: [{ label: "Move between commits", combo: ["ArrowUp", "ArrowDown"] }],
  },
  {
    title: "Sync",
    items: [
      { label: "Push", combo: ["mod", "shift", "P"] },
      { label: "Pull", combo: ["mod", "shift", "L"] },
    ],
  },
  {
    title: "Find",
    items: [{ label: "Search commits", combo: ["mod", "F"] }],
  },
  {
    title: "Tabs",
    items: [
      { label: "Open a repository", combo: ["mod", "T"] },
      { label: "Close tab", combo: ["mod", "W"] },
      { label: "Reopen closed tab", combo: ["mod", "shift", "T"] },
      { label: "Next / previous tab", combo: ["ctrl", "Tab"] },
    ],
  },
  {
    title: "General",
    items: [
      { label: "Open Settings", combo: ["mod", ","] },
      { label: "Show keyboard combos", combo: ["mod", "/"] },
    ],
  },
];

const MAC_GLYPH: Record<string, string> = {
  mod: "\u2318", // ⌘
  shift: "\u21E7", // ⇧
  alt: "\u2325", // ⌥
  ctrl: "\u2303", // ⌃
  Enter: "\u21B5", // ↵
  Tab: "\u21E5", // ⇥
  Escape: "Esc",
  Space: "Space",
  ArrowUp: "\u2191",
  ArrowDown: "\u2193",
  ArrowLeft: "\u2190",
  ArrowRight: "\u2192",
};

const PC_LABEL: Record<string, string> = {
  mod: "Ctrl",
  shift: "Shift",
  alt: "Alt",
  ctrl: "Ctrl",
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Esc",
  Space: "Space",
  ArrowUp: "\u2191",
  ArrowDown: "\u2193",
  ArrowLeft: "\u2190",
  ArrowRight: "\u2192",
};

/// Display label for a single token, per platform.
export function keyLabel(token: KeyToken): string {
  const map = isMac ? MAC_GLYPH : PC_LABEL;
  return map[token] ?? token.toUpperCase();
}

/// Compact hint for button tooltips: "\u2318\u21B5" on macOS, "Ctrl+Enter" elsewhere.
export function comboHint(combo: KeyToken[]): string {
  const parts = combo.map(keyLabel);
  return isMac ? parts.join("") : parts.join("+");
}
