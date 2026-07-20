// Intra-line (word-level) diff for the unified diff viewer: given a removed line
// and the added line it was replaced by, find which segments actually changed so
// the viewer can highlight just those characters instead of the whole line.

export interface Segment {
  text: string;
  changed: boolean;
}

// Skip the O(n*m) LCS on pathologically long lines (e.g. minified bundles) -
// the caller falls back to a plain, whole-line highlight.
const MAX_LEN = 400;

/// Word-level diff of a replaced line pair. Returns per-side segments with a
/// `changed` flag, or null when either side is too long to diff cheaply.
export function wordDiff(oldText: string, newText: string): { del: Segment[]; add: Segment[] } | null {
  if (oldText.length > MAX_LEN || newText.length > MAX_LEN) return null;
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const aCommon = new Array<boolean>(a.length).fill(false);
  const bCommon = new Array<boolean>(b.length).fill(false);
  markCommon(a, b, aCommon, bCommon);
  return { del: toSegments(a, aCommon), add: toSegments(b, bCommon) };
}

// Split into runs of whitespace, identifier characters, and single punctuation,
// so highlighting lands on word boundaries rather than individual characters.
// Unicode-aware (`u`): without it the punctuation branch matches one UTF-16
// code unit, so an emoji is split across two tokens and a segment can end on a
// lone surrogate - which renders as a replacement char. `\P{M}\p{M}*` keeps a
// code point together with its combining marks, and `\p{L}\p{N}` keeps accented
// words whole instead of breaking them at the accent.
function tokenize(s: string): string[] {
  return s.match(/\s+|[\p{L}\p{N}_]+|\P{M}\p{M}*/gu) ?? [];
}

// LCS over tokens, then backtrack to flag the longest common subsequence as
// unchanged on both sides; everything else is a change.
function markCommon(a: string[], b: string[], aCommon: boolean[], bCommon: boolean[]): void {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      aCommon[i] = true;
      bCommon[j] = true;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
}

// Coalesce adjacent tokens of the same changed-ness into render segments.
function toSegments(tokens: string[], common: boolean[]): Segment[] {
  const segs: Segment[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const changed = !common[i];
    const last = segs[segs.length - 1];
    if (last && last.changed === changed) last.text += tokens[i];
    else segs.push({ text: tokens[i], changed });
  }
  return segs;
}
