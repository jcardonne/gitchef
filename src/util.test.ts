import { describe, it, expect } from "vitest";
import { hasUncommittedChange } from "./util";
import type { FileStatus, StatusResult } from "./types";

const entry = (path: string, staged: boolean): FileStatus => ({ path, status: "modified", staged });
const status = (staged: string[], unstaged: string[]): StatusResult => ({
  staged: staged.map((p) => entry(p, true)),
  unstaged: unstaged.map((p) => entry(p, false)),
});

describe("hasUncommittedChange", () => {
  it("is true when the path is staged", () => {
    expect(hasUncommittedChange(status(["a.ts"], []), "a.ts")).toBe(true);
  });

  it("is true when the path is unstaged", () => {
    expect(hasUncommittedChange(status([], ["a.ts"]), "a.ts")).toBe(true);
  });

  // A partially-staged file keeps an unstaged remainder after a commit, so its
  // preview must NOT close - this is why onCommit checks the post-commit status
  // rather than just "was it staged".
  it("is true for a file that is both staged and unstaged", () => {
    expect(hasUncommittedChange(status(["a.ts"], ["a.ts"]), "a.ts")).toBe(true);
  });

  // The case that drives the feature: a previewed file fully absorbed by a
  // commit drops out of the status, so the stale diff preview should close.
  it("is false when the path is absent from the changes", () => {
    expect(hasUncommittedChange(status(["b.ts"], ["c.ts"]), "a.ts")).toBe(false);
  });

  it("is false for an empty status", () => {
    expect(hasUncommittedChange(status([], []), "a.ts")).toBe(false);
  });
});
