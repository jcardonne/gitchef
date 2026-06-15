import type { FileStatus } from "./types";

export interface TreeFile {
  type: "file";
  file: FileStatus;
}
export interface TreeFolder {
  type: "folder";
  name: string;
  path: string;
  children: TreeNode[];
}
export type TreeNode = TreeFile | TreeFolder;

/// Build a folder hierarchy from flat file paths, folders before files, sorted.
export function buildTree(files: FileStatus[]): TreeNode[] {
  const root: TreeFolder = { type: "folder", name: "", path: "", children: [] };
  // Full-path -> folder map, so finding/creating a parent folder is O(1). The
  // old `children.find` scan made a single flat directory of N files O(N^2).
  const folders = new Map<string, TreeFolder>([["", root]]);

  for (const file of files) {
    const parts = file.path.split("/");
    let cur = root;
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      prefix = prefix ? `${prefix}/${seg}` : seg;
      let next = folders.get(prefix);
      if (!next) {
        next = { type: "folder", name: seg, path: prefix, children: [] };
        cur.children.push(next);
        folders.set(prefix, next);
      }
      cur = next;
    }
    cur.children.push({ type: "file", file });
  }

  sort(root);
  return root.children;
}

// One reused collator (default locale/options, so ordering is identical to the
// old per-call localeCompare). Constructing a collator per comparison was the
// dominant cost when sorting tens of thousands of siblings.
const collator = new Intl.Collator();

function sort(folder: TreeFolder): void {
  folder.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    const an = a.type === "folder" ? a.name : a.file.path;
    const bn = b.type === "folder" ? b.name : b.file.path;
    return collator.compare(an, bn);
  });
  for (const c of folder.children) if (c.type === "folder") sort(c);
}

/// Depth-first list of currently visible nodes, skipping collapsed subtrees.
export function flattenVisible(
  nodes: TreeNode[],
  collapsed: Set<string>,
  depth = 0
): { node: TreeNode; depth: number }[] {
  const out: { node: TreeNode; depth: number }[] = [];
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.type === "folder" && !collapsed.has(node.path)) {
      out.push(...flattenVisible(node.children, collapsed, depth + 1));
    }
  }
  return out;
}

/// Every file in a folder subtree (depth-first) - used for folder bulk actions.
export function filesIn(folder: TreeFolder): FileStatus[] {
  const out: FileStatus[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.type === "file") out.push(n.file);
      else walk(n.children);
    }
  };
  walk(folder.children);
  return out;
}
