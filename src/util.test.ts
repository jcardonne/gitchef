import { describe, it, expect } from "vitest";
import { affectedPaths, avatarUrl, edgePath, isRateLimited, noreplyAvatarUrl, rateLimitBackoffMs, relativeTime } from "./util";
import type { FileStatus } from "./types";

describe("noreplyAvatarUrl", () => {
  it("derives a GitHub avatar from the modern id-form no-reply", () => {
    expect(noreplyAvatarUrl("123456+octocat@users.noreply.github.com")).toBe(
      "https://avatars.githubusercontent.com/u/123456?s=32"
    );
  });

  it("derives a GitHub avatar from the legacy no-reply via the .png redirect", () => {
    expect(noreplyAvatarUrl("octocat@users.noreply.github.com")).toBe(
      "https://github.com/octocat.png?size=32"
    );
  });

  it("does not let the id-form fall through to the legacy username branch", () => {
    // "99+ada@..." must resolve by id, not be read as the username "99+ada".
    expect(noreplyAvatarUrl("99+ada@users.noreply.github.com")).toBe(
      "https://avatars.githubusercontent.com/u/99?s=32"
    );
  });

  it("derives a gitlab.com avatar from the no-reply id + host", () => {
    expect(noreplyAvatarUrl("42-jane@users.noreply.gitlab.com")).toBe(
      "https://gitlab.com/uploads/-/system/user/avatar/42/avatar.png?width=32"
    );
  });

  it("splits the GitLab id from a hyphenated username", () => {
    expect(noreplyAvatarUrl("123-foo-bar@users.noreply.gitlab.com")).toBe(
      "https://gitlab.com/uploads/-/system/user/avatar/123/avatar.png?width=32"
    );
  });

  it("uses the instance host for a self-hosted GitLab no-reply", () => {
    expect(noreplyAvatarUrl("7-bob@users.noreply.git.example.com")).toBe(
      "https://git.example.com/uploads/-/system/user/avatar/7/avatar.png?width=32"
    );
  });

  it("honors a custom size on each provider", () => {
    expect(noreplyAvatarUrl("1+a@users.noreply.github.com", 64)).toBe(
      "https://avatars.githubusercontent.com/u/1?s=64"
    );
    expect(noreplyAvatarUrl("1-a@users.noreply.gitlab.com", 64)).toBe(
      "https://gitlab.com/uploads/-/system/user/avatar/1/avatar.png?width=64"
    );
  });

  it("returns null for emails that are not provider no-replies", () => {
    expect(noreplyAvatarUrl("jane@example.com")).toBeNull();
    expect(noreplyAvatarUrl("jane@users.noreply.bitbucket.org")).toBeNull();
    expect(noreplyAvatarUrl("not-an-email")).toBeNull();
  });
});

describe("avatarUrl precedence", () => {
  it("prefers the backend-resolved account avatar over everything", async () => {
    const accounts = new Map([["dev@corp.com", "https://provider/avatar/42.png"]]);
    expect(await avatarUrl("dev@corp.com", { accounts })).toBe("https://provider/avatar/42.png");
  });

  it("matches the account map case-insensitively on the normalized email", async () => {
    const accounts = new Map([["dev@corp.com", "https://provider/a.png"]]);
    expect(await avatarUrl("  Dev@Corp.com ", { accounts })).toBe("https://provider/a.png");
  });

  it("falls back to no-reply derivation when no account matches", async () => {
    expect(await avatarUrl("500+gh@users.noreply.github.com", { accounts: new Map() })).toBe(
      "https://avatars.githubusercontent.com/u/500?s=32"
    );
  });

  it("gravatar fallback uses www. so it matches the *.gravatar.com CSP allowlist", async () => {
    // A bare `gravatar.com` host is blocked by img-src `*.gravatar.com` (the
    // wildcard needs a subdomain label), which surfaces as a broken avatar.
    const url = await avatarUrl("nobody@nowhere.test", { accounts: new Map() });
    expect(url.startsWith("https://www.gravatar.com/avatar/")).toBe(true);
  });
});

describe("edgePath", () => {
  it("draws a plain vertical when child and parent share a lane", () => {
    expect(edgePath(10, 0, 10, 48)).toBe("M 10 0 L 10 48");
  });

  it("elbows into the parent lane with a rounded corner when lanes differ", () => {
    const d = edgePath(10, 0, 26, 48); // one lane right, one row down
    expect(d.startsWith("M 10 0")).toBe(true); // leaves the child node
    expect(d).toContain("Q "); // has a rounded corner
    expect(d.endsWith("L 26 48")).toBe(true); // arrives at the parent node
  });

  it("keeps the corner on the approach side when the parent is above (oldest-first)", () => {
    // y2 < y1: the vertical run must head up toward the parent, not overshoot down.
    expect(edgePath(10, 48, 26, 0)).toBe("M 10 48 L 10 8 Q 10 0 18 0 L 26 0");
  });
});

const fs = (path: string, old_path: string | null = null): FileStatus => ({
  path,
  old_path,
  status: old_path ? "renamed" : "modified",
  staged: false,
});

describe("affectedPaths", () => {
  it("includes a rename's source alongside its new path", () => {
    expect(affectedPaths([fs("new.txt", "old.txt")]).sort()).toEqual(["new.txt", "old.txt"]);
  });

  it("returns only the path for non-renames and dedupes repeats", () => {
    expect(affectedPaths([fs("a.ts"), fs("a.ts")])).toEqual(["a.ts"]);
  });
});

describe("isRateLimited", () => {
  // These are the verbatim strings GitHub (gh), GitLab (glab) and git surface -
  // the regex is only useful if it matches what providers actually emit.
  it("matches real GitHub primary / secondary + GitLab / git 429 output", () => {
    expect(isRateLimited("GitHub API rate limit exceeded. Please wait a minute and try again.")).toBe(true);
    expect(isRateLimited("GraphQL: API rate limit exceeded for user ID 123")).toBe(true);
    expect(isRateLimited("HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.")).toBe(true);
    expect(isRateLimited("You have triggered an abuse detection mechanism")).toBe(true);
    expect(isRateLimited("429 Too Many Requests")).toBe(true);
    expect(isRateLimited("error: RPC failed; HTTP 429 curl 22")).toBe(true);
  });
  it("does not treat plain auth 403 / network errors as rate limits", () => {
    expect(isRateLimited("HTTP 403: Bad credentials")).toBe(false);
    expect(isRateLimited("could not resolve host github.com")).toBe(false);
    expect(isRateLimited("fatal: Authentication failed")).toBe(false);
  });
  it("word-boundaries 429 so it doesn't fire on embedded digits", () => {
    expect(isRateLimited("commit 1429ab wrote 4290 objects")).toBe(false);
  });
});

describe("rateLimitBackoffMs", () => {
  it("honours an explicit retry-after hint, clamped", () => {
    expect(rateLimitBackoffMs("secondary rate limit; retry after 90")).toBe(90_000);
    expect(rateLimitBackoffMs("retry-after: 5")).toBe(30_000); // clamped up to 30s min
    expect(rateLimitBackoffMs("retry after 99999")).toBe(60 * 60_000); // clamped to 1h max
  });
  it("falls back to the default when no hint is present", () => {
    expect(rateLimitBackoffMs("API rate limit exceeded")).toBe(15 * 60_000);
  });
});

describe("relativeTime", () => {
  const now = () => Date.now() / 1000;

  it("formats each bucket", () => {
    expect(relativeTime(now() - 5)).toBe("just now");
    expect(relativeTime(now() - 5 * 60)).toBe("5m ago");
    expect(relativeTime(now() - 3 * 3600)).toBe("3h ago");
    expect(relativeTime(now() - 4 * 86400)).toBe("4d ago");
    expect(relativeTime(now() - 90 * 86400)).toBe("3mo ago");
    expect(relativeTime(now() - 800 * 86400)).toBe("2y ago");
  });

  // A recents entry written by an older schema deserializes to undefined ->
  // NaN, which used to fall through every comparison and render "NaN y ago".
  it("renders nothing for a non-finite timestamp", () => {
    expect(relativeTime(NaN)).toBe("");
    expect(relativeTime(undefined as unknown as number)).toBe("");
  });

  // Clock skew / a rewritten author date puts the stamp in the future.
  it("treats a future timestamp as just now, never a negative age", () => {
    expect(relativeTime(now() + 3600)).toBe("just now");
  });
});
