import type { FileStatusKind, StatusResult } from "./types";

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

const AVATAR_SIZE = 32;

/// Backend-resolved provider account avatars for this repo, keyed by lowercased
/// committer email (the GitHub/GitLab profile pictures). Threaded in from
/// RepoView; the remaining resolution (no-reply derivation, Gravatar) is
/// provider-agnostic and needs no context.
export interface AvatarContext {
  accounts: ReadonlyMap<string, string>;
}

// Caches the provider-agnostic fallbacks (no-reply derivation + Gravatar hash)
// per email, so each unique committer is resolved at most once per session.
const avatarCache = new Map<string, string>();

/// Avatar image URL for a committer email. Prefers the provider account avatar
/// the backend resolved (GitHub/GitLab - covers real, non-no-reply emails);
/// otherwise derives it from a no-reply address; otherwise falls back to
/// Gravatar. Always resolves to a real image (Gravatar serves an identicon for
/// unknown emails), so callers never handle a missing avatar.
export async function avatarUrl(email: string, ctx: AvatarContext): Promise<string> {
  const normalized = email.trim().toLowerCase();
  const account = ctx.accounts.get(normalized);
  if (account) return account;
  const cached = avatarCache.get(normalized);
  if (cached) return cached;
  const url = noreplyAvatarUrl(normalized) ?? (await gravatarUrl(normalized));
  avatarCache.set(normalized, url);
  return url;
}

/// Direct avatar URL derived purely from a provider no-reply email, or null when
/// `email` isn't one. These formats embed the user id (and, for GitLab, the
/// instance host), so the result is a plain `<img>` URL - no auth, no API call,
/// no rate limit. Exported for unit testing.
export function noreplyAvatarUrl(email: string, size = AVATAR_SIZE): string | null {
  // GitHub, modern id form: "123456+login@users.noreply.github.com".
  let m = /^(\d+)\+[^@]+@users\.noreply\.github\.com$/i.exec(email);
  if (m) return `https://avatars.githubusercontent.com/u/${m[1]}?s=${size}`;
  // GitHub, legacy form (no id): "login@users.noreply.github.com". The account
  // page's ".png" redirects to the avatar CDN.
  m = /^([^@+]+)@users\.noreply\.github\.com$/i.exec(email);
  if (m) return `https://github.com/${m[1]}.png?size=${size}`;
  // GitLab: "123-login@users.noreply.<host>" (gitlab.com or self-hosted). The
  // host after "users.noreply." is the instance that serves the avatar.
  m = /^(\d+)-[^@]+@users\.noreply\.([a-z0-9.-]+)$/i.exec(email);
  if (m)
    return `https://${m[2].toLowerCase()}/uploads/-/system/user/avatar/${m[1]}/avatar.png?width=${size}`;
  return null;
}

/// Gravatar URL for an email (SHA-256 per Gravatar's current scheme). The
/// `identicon` default means it always resolves to an image, even when the
/// author has no Gravatar account. Expects an already-normalized email.
async function gravatarUrl(email: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(email));
  const hash = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `https://gravatar.com/avatar/${hash}?s=${AVATAR_SIZE}&d=identicon`;
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

/// Whether `path` still has an uncommitted change (staged or unstaged) in the
/// given working-tree status. After a commit, a previewed file that returns
/// false here was absorbed by the commit, so its working-tree diff can close.
export function hasUncommittedChange(status: StatusResult, path: string): boolean {
  return (
    status.staged.some((f) => f.path === path) ||
    status.unstaged.some((f) => f.path === path)
  );
}
