import { describe, it, expect } from "vitest";
import { buildTree, flattenVisible, filesIn, type TreeFolder, type TreeNode } from "./fileTree";
import type { FileStatus } from "./types";

// Fixture + assertion label reused across every block (status is irrelevant here).
const file = (path: string): FileStatus => ({ path, old_path: null, status: "modified", staged: false });
const label = (n: TreeNode): string => (n.type === "folder" ? `d:${n.path}` : `f:${n.file.path}`);

describe("buildTree", () => {
  it("nests files under folders, folders before files, each level sorted", () => {
    const tree = buildTree([
      file("src/b.ts"),
      file("src/a.ts"),
      file("README.md"),
      file("src/sub/x.ts"),
    ]);
    // Top level: the "src" folder sorts before the "README.md" file.
    expect(tree.map(label)).toEqual(["d:src", "f:README.md"]);
    const src = tree[0] as TreeFolder;
    // Inside src: the "sub" folder first, then files alphabetically.
    expect(src.children.map(label)).toEqual(["d:src/sub", "f:src/a.ts", "f:src/b.ts"]);
  });

  it("builds cumulative folder paths", () => {
    const tree = buildTree([file("a/b/c.ts")]);
    const a = tree[0] as TreeFolder;
    const b = a.children[0] as TreeFolder;
    expect(a.path).toBe("a");
    expect(b.path).toBe("a/b");
    expect(b.children.map(label)).toEqual(["f:a/b/c.ts"]);
  });

  it("groups thousands of files in one flat directory without dropping any", () => {
    const n = 2000;
    const tree = buildTree(
      Array.from({ length: n }, (_, i) => file(`assets/flag_${String(i).padStart(4, "0")}.xml`))
    );
    expect(tree.length).toBe(1);
    const assets = tree[0] as TreeFolder;
    expect(assets.path).toBe("assets");
    expect(assets.children.length).toBe(n);
    expect(assets.children.every((c) => c.type === "file")).toBe(true);
  });
});

describe("flattenVisible", () => {
  it("hides the children of collapsed folders", () => {
    const tree = buildTree([file("src/a.ts"), file("README.md")]);
    expect(flattenVisible(tree, new Set()).map((v) => label(v.node))).toEqual([
      "d:src",
      "f:src/a.ts",
      "f:README.md",
    ]);
    // Collapsing "src" drops its descendants but keeps the folder row itself.
    expect(flattenVisible(tree, new Set(["src"])).map((v) => label(v.node))).toEqual([
      "d:src",
      "f:README.md",
    ]);
  });

  it("reports increasing depth down the tree", () => {
    const tree = buildTree([file("a/b/c.ts")]);
    expect(flattenVisible(tree, new Set()).map((v) => v.depth)).toEqual([0, 1, 2]);
  });
});

describe("filesIn", () => {
  it("collects every file in a subtree, regardless of nesting", () => {
    const tree = buildTree([
      file("src/a.ts"),
      file("src/sub/x.ts"),
      file("src/sub/y.ts"),
      file("README.md"),
    ]);
    const src = tree[0] as TreeFolder;
    expect(filesIn(src).map((f) => f.path).sort()).toEqual([
      "src/a.ts",
      "src/sub/x.ts",
      "src/sub/y.ts",
    ]);
  });

  it("returns nothing for an empty folder", () => {
    const empty: TreeFolder = { type: "folder", name: "x", path: "x", children: [] };
    expect(filesIn(empty)).toEqual([]);
  });
});

describe("generic over the file payload", () => {
  it("groups any { path } shape, preserving the original objects (e.g. commit FileDiff)", () => {
    // Minimal FileDiff-like payload: carries fields FileStatus doesn't.
    const diff = (path: string) => ({ path, binary: false, hunks: [] });
    const tree = buildTree([diff("src/a.ts"), diff("src/b.ts"), diff("README.md")]);
    const src = tree[0] as TreeFolder<ReturnType<typeof diff>>;
    expect(src.path).toBe("src");
    // The leaf is the SAME object we put in - hunks/binary survive the grouping.
    expect(src.children[0]).toEqual({ type: "file", file: diff("src/a.ts") });
  });
});
