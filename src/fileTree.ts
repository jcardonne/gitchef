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

  for (const file of files) {
    const parts = file.path.split("/");
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      const path = cur.path ? `${cur.path}/${seg}` : seg;
      let next = cur.children.find(
        (c): c is TreeFolder => c.type === "folder" && c.name === seg
      );
      if (!next) {
        next = { type: "folder", name: seg, path, children: [] };
        cur.children.push(next);
      }
      cur = next;
    }
    cur.children.push({ type: "file", file });
  }

  sort(root);
  return root.children;
}

function sort(folder: TreeFolder): void {
  folder.children.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    const an = a.type === "folder" ? a.name : a.file.path;
    const bn = b.type === "folder" ? b.name : b.file.path;
    return an.localeCompare(bn);
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
