import type { FileStatusKind } from "./types";

// Single-letter status badge shown next to each changed file.
export const STATUS_GLYPH: Record<FileStatusKind, string> = {
  new: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  typechange: "T",
  conflicted: "!",
};

// Lane colors for the commit graph - cycled by `color` index from the backend.
export const LANE_COLORS = [
  "#22c5a4", // teal (brand)
  "#6ea8fe",
  "#f7768e",
  "#e0af68",
  "#bb9af7",
  "#7dcfff",
  "#9ece6a",
  "#ff9e64",
];

export const laneColor = (i: number) => LANE_COLORS[i % LANE_COLORS.length];

// Gravatar URL for an email (SHA-256 per Gravatar's current scheme), cached so
// each unique committer is hashed once. Falls back to a generated identicon, so
// it always resolves to an image even when the author has no Gravatar.
const avatarCache = new Map<string, string>();

export async function gravatarUrl(email: string): Promise<string> {
  const key = email.trim().toLowerCase();
  const cached = avatarCache.get(key);
  if (cached) return cached;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const hash = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const url = `https://gravatar.com/avatar/${hash}?s=32&d=identicon`;
  avatarCache.set(key, url);
  return url;
}

export function relativeTime(unixSeconds: number): string {
  const diff = Date.now() / 1000 - unixSeconds;
  if (diff < 60) return "just now";
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}
