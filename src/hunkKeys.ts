export type HunkKeyResult =
  | { type: "jump"; to: number }
  | { type: "act"; action: "stage" | "unstage" | "discard" }
  | null;

/// Maps a key pressed while the diff is focused to a hunk jump or action.
/// `]`/`n` and `[`/`p` move between hunks (clamped), `s` stages or unstages
/// depending on which side is shown, and `d` discards (never on a staged diff).
export function hunkKeyAction(key: string, active: number, hunkCount: number, staged: boolean): HunkKeyResult {
  const clamp = (n: number) => Math.max(0, Math.min(hunkCount - 1, n));
  if (key === "]" || key === "n") return { type: "jump", to: clamp(active + 1) };
  if (key === "[" || key === "p") return { type: "jump", to: clamp(active - 1) };
  if (key === "s") return { type: "act", action: staged ? "unstage" : "stage" };
  if (key === "d" && !staged) return { type: "act", action: "discard" };
  return null;
}
