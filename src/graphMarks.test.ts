import { describe, it, expect } from "vitest";
import { isMine, isMultiAuthor, publishedBoundary, staleCommitIds } from "./graphMarks";
import type { CommitNode } from "./types";

const NOW = 1_000_000_000;
const DAY = 86400;
function node(id: string, parents: string[], extra: Partial<CommitNode> = {}): CommitNode {
  return {
    id,
    short_id: id,
    summary: id,
    message: id,
    author: "a",
    email: "a@x.io",
    time: NOW - DAY,
    parents,
    refs: [],
    lane: 0,
    color: 0,
    unpushed: false,
    ...extra,
  };
}

describe("staleCommitIds", () => {
  // main: m3 -> m2 -> m1.  feature branch f2 -> f1 forked from m1, merged by m3.
  const build = (featureAgeDays: number) => [
    node("m3", ["m2", "f2"], { refs: [{ name: "HEAD", kind: "head" }, { name: "main", kind: "branch" }] }),
    node("m2", ["m1"]),
    node("f2", ["f1"], { time: NOW - featureAgeDays * DAY, refs: [{ name: "origin/feat", kind: "remote" }] }),
    node("f1", ["m1"], { time: NOW - featureAgeDays * DAY }),
    node("m1", []),
  ];

  it("marks an old merged branch's private commits, not the mainline", () => {
    const stale = staleCommitIds(build(60), "m3", NOW);
    expect([...stale].sort()).toEqual(["f1", "f2"]);
  });

  it("leaves a recent merged branch alone", () => {
    expect(staleCommitIds(build(5), "m3", NOW).size).toBe(0);
  });

  it("leaves an unmerged branch alone however old", () => {
    const nodes = [
      node("m1", [], { refs: [{ name: "HEAD", kind: "head" }, { name: "main", kind: "branch" }] }),
      node("x1", [], { time: NOW - 90 * DAY, refs: [{ name: "wip", kind: "branch" }] }),
    ];
    expect(staleCommitIds(nodes, "m1", NOW).size).toBe(0);
  });

  it("returns nothing without a HEAD commit", () => {
    expect(staleCommitIds(build(60), null, NOW).size).toBe(0);
  });
});

describe("ownership", () => {
  it("only reports multi-author when there are two distinct emails", () => {
    expect(isMultiAuthor([node("a", [], { email: "A@x.io" }), node("b", [], { email: "a@x.io" })])).toBe(false);
    expect(isMultiAuthor([node("a", [], { email: "a@x.io" }), node("b", [], { email: "b@x.io" })])).toBe(true);
  });

  it("matches the user's email case-insensitively and fails safe when unset", () => {
    expect(isMine(node("a", [], { email: "Me@X.io" }), "me@x.io")).toBe(true);
    expect(isMine(node("a", [], { email: "me@x.io" }), null)).toBe(false);
  });
});

describe("publishedBoundary", () => {
  it("returns the oldest unpushed commit on HEAD's line and the unpushed count", () => {
    const nodes = [
      node("c3", ["c2"], { unpushed: true }),
      node("c2", ["c1"], { unpushed: true }),
      node("c1", [], { refs: [{ name: "origin/main", kind: "remote" }] }),
    ];
    expect(publishedBoundary(nodes, "c3")).toMatchObject({ id: "c2", count: 2 });
  });

  it("draws nothing when HEAD is already pushed or missing", () => {
    const clean = [node("c2", ["c1"]), node("c1", [])];
    expect(publishedBoundary(clean, "c2")).toBeNull();
    expect(publishedBoundary(clean, null)).toBeNull();
  });

  it("does not depend on where the remote tip is loaded or ordered", () => {
    // diverged: the remote tip r1 is newer in the list than HEAD's own commits
    const nodes = [
      node("r1", ["c1"], { refs: [{ name: "origin/main", kind: "remote" }] }),
      node("l2", ["l1"], { unpushed: true }),
      node("l1", ["c1"], { unpushed: true }),
      node("c1", []),
    ];
    expect(publishedBoundary(nodes, "l2")).toMatchObject({ id: "l1", count: 2 });
  });

  it("counts unpushed commits merged in from another branch", () => {
    const nodes = [
      node("m", ["a", "f"], { unpushed: true }),
      node("a", ["base"], { unpushed: true }),
      node("f", ["base"], { unpushed: true }),
      node("base", []),
    ];
    expect(publishedBoundary(nodes, "m")).toMatchObject({ id: "a", count: 3 });
    expect([...publishedBoundary(nodes, "m")!.ids].sort()).toEqual(["a", "f", "m"]);
  });

  it("ignores unpushed commits on other branches that HEAD does not reach", () => {
    const nodes = [
      node("h2", ["h1"], { unpushed: true }),
      node("other", ["h1"], { unpushed: true }),
      node("h1", []),
    ];
    expect([...publishedBoundary(nodes, "h2")!.ids]).toEqual(["h2"]);
  });

  it("works when HEAD is detached (no branch or upstream needed)", () => {
    const nodes = [node("d2", ["d1"], { unpushed: true, refs: [{ name: "HEAD", kind: "head" }] }), node("d1", [])];
    expect(publishedBoundary(nodes, "d2")).toMatchObject({ id: "d2", count: 1 });
  });
});
