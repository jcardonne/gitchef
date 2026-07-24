import type { FileStatus, FileStatusKind, StatusResult } from "./types";

// Single-letter status badge shown next to each changed file.
export const STATUS_GLYPH: Record<FileStatusKind, string> = {
  new: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  typechange: "T",
  conflicted: "!",
};

// Image types we can preview inline as a data-URL <img>. Value = MIME; a path
// whose extension isn't here is not previewable (null).
const IMAGE_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif",
};
export function imageMime(path: string): string | null {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  return (ext && IMAGE_MIME[ext]) || null;
}

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

/// SVG path for an orthogonal (GitKraken-style) graph edge from a child node
/// (x1,y1) to a parent node (x2,y2): straight along the child's lane, a small
/// rounded 90° corner, then across into the parent's lane. Same lane → a plain
/// vertical segment. Reads clearer than a bezier because the eye follows the
/// verticals. `y2` is normally below `y1` (newest-first); handles either order.
export function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const dir = x2 > x1 ? 1 : -1;
  const vdir = y2 > y1 ? 1 : -1;
  const r = Math.min(8, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2);
  return `M ${x1} ${y1} L ${x1} ${y2 - vdir * r} Q ${x1} ${y2} ${x1 + dir * r} ${y2} L ${x2} ${y2}`;
}

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
  // www., not the apex: the CSP img-src allows `*.gravatar.com`, which a bare
  // `gravatar.com` host does not match (the wildcard needs a subdomain label).
  return `https://www.gravatar.com/avatar/${hash}?s=${AVATAR_SIZE}&d=identicon`;
}

export function relativeTime(unixSeconds: number): string {
  // A missing/legacy persisted timestamp arrives as NaN, and every comparison
  // below is false for NaN - so it would fall through to the last line and
  // render a literal "NaN y ago" on the Home screen.
  if (!Number.isFinite(unixSeconds)) return "";
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

/// Does this git / gh / glab error look like a provider rate-limit (primary,
/// secondary/abuse, or a 429 throttle)? We match the text GitHub and GitLab
/// surface because the CLI path gives us no structured headers - only stderr.
/// Deliberately NOT matching a bare 403 (that's usually auth, not throttling).
export function isRateLimited(msg: string): boolean {
  return /rate limit|secondary rate|abuse detection|too many requests|\b429\b/i.test(msg);
}

/// How long to pause background network after a rate-limit error. Honours an
/// explicit "retry after <n>s" / "try again in <n> seconds" hint when the
/// provider gives one (clamped to 30s..1h), else a conservative default.
export function rateLimitBackoffMs(msg: string, fallbackMs = 15 * 60_000): number {
  const m = msg.match(/retry[\s-]?after[\s:]+(\d+)/i) || msg.match(/try again in (\d+)\s*second/i);
  if (m) return Math.min(60 * 60_000, Math.max(30_000, Number(m[1]) * 1000));
  return fallbackMs;
}

/// The git paths a stage/unstage/discard must touch for these files. A renamed
/// file needs BOTH its new path and its rename source (`old_path`) so the old
/// name's deletion and the new name's addition always move together.
export function affectedPaths(files: FileStatus[]): string[] {
  const paths = new Set<string>();
  for (const f of files) {
    paths.add(f.path);
    if (f.old_path) paths.add(f.old_path);
  }
  return [...paths];
}
