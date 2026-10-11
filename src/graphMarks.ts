import type { CommitNode } from "./types";

/// Pure helpers behind the graph's status encoding: which commits belong to old,
/// already-merged branches (they recede), whether ownership is worth showing, and
/// where the published line sits. Kept free of React so they can be tested.

const DAY = 86400;

/// Commits that belong to a branch which is already merged into HEAD and whose tip
/// is older than `days`. Walks each such tip's first-parent chain until it joins
/// HEAD's own mainline, so only the branch's private commits are returned.
export function staleCommitIds(nodes: CommitNode[], headId: string | null, nowSec: number, days = 30): Set<string> {
  const out = new Set<string>();
  if (!headId) return out;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // everything reachable from HEAD through any parent: "already merged"
  const merged = new Set<string>();
  const stack = [headId];
  while (stack.length) {
    const id = stack.pop()!;
    if (merged.has(id)) continue;
    merged.add(id);
    for (const p of byId.get(id)?.parents ?? []) stack.push(p);
  }
  // HEAD's own first-parent mainline
  const mainline = new Set<string>();
  for (let cur = byId.get(headId); cur && !mainline.has(cur.id); cur = byId.get(cur.parents[0] ?? "")) {
    mainline.add(cur.id);
  }
  const cutoff = nowSec - days * DAY;
  for (const tip of nodes) {
    if (tip.id === headId || mainline.has(tip.id) || !merged.has(tip.id) || tip.time >= cutoff) continue;
    if (!tip.refs.some((r) => r.kind === "branch" || r.kind === "remote")) continue;
    for (let cur: CommitNode | undefined = tip; cur && !mainline.has(cur.id) && !out.has(cur.id); cur = byId.get(cur.parents[0] ?? "")) {
      out.add(cur.id);
    }
  }
  return out;
}

/// Ownership only means something when more than one person committed.
export function isMultiAuthor(nodes: CommitNode[]): boolean {
  const emails = new Set<string>();
  for (const n of nodes) {
    if (n.email) emails.add(n.email.toLowerCase());
    if (emails.size > 1) return true;
  }
  return false;
}

export function isMine(node: CommitNode, userEmail: string | null): boolean {
  return !!userEmail && node.email.toLowerCase() === userEmail.toLowerCase();
}

/// Where HEAD's history stops being shared. Walks HEAD's first-parent line while
/// commits are unpushed and returns the oldest of them (`id`) plus how many unpushed
/// commits HEAD reaches in total (`count`). Built from the per-commit `unpushed`
/// flag rather than a ref's position, so it stays correct when history is diverged,
/// when the upstream tip is not loaded, and when HEAD is detached. Null when HEAD
/// itself is already pushed. `ids` is every unpushed commit HEAD reaches: exactly what
/// pushing this branch would publish, and the only commits the graph marks.
export function publishedBoundary(nodes: CommitNode[], headId: string | null): { id: string; count: number; ids: Set<string> } | null {
  if (!headId) return null;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const head = byId.get(headId);
  if (!head?.unpushed) return null;
  let last = head;
  const line = new Set<string>();
  for (let cur: CommitNode | undefined = head; cur && cur.unpushed && !line.has(cur.id); cur = byId.get(cur.parents[0] ?? "")) {
    line.add(cur.id);
    last = cur;
  }
  // Ancestors of a pushed commit are pushed, so only unpushed commits need visiting.
  const seen = new Set<string>();
  const stack = [head.id];
  while (stack.length) {
    const n = byId.get(stack.pop()!);
    if (!n || !n.unpushed || seen.has(n.id)) continue;
    seen.add(n.id);
    for (const p of n.parents) stack.push(p);
  }
  return { id: last.id, count: seen.size, ids: seen };
}
