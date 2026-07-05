import { describe, it, expect } from "vitest";
import { affectedPaths, avatarUrl, edgePath, noreplyAvatarUrl } from "./util";
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
