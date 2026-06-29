import { useEffect, useState } from "react";
import type { FileDiff } from "../types";
import { getChangesView, setChangesView, type ChangesView } from "../storage";
import { buildTree, flattenVisible } from "../fileTree";
import { StatusIcon } from "./ChangeList";

interface Props {
  files: FileDiff[];
  selectedPath: string | null;
  onSelect: (f: FileDiff) => void;
  onContext: (f: FileDiff) => void;
}

const INDENT = 14;
const BASE_PAD = 12;

/// The selected commit's changed files as a flat list or a collapsible folder
/// tree - the same List/Tree system as the working-changes panel (and the same
/// persisted preference), minus staging: a committed file has nothing to stage,
/// so rows just select + preview.
export default function CommitFiles({ files, selectedPath, onSelect, onContext }: Props) {
  const [view, setView] = useState<ChangesView>(getChangesView);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // New commit -> new file set -> start fully expanded.
  useEffect(() => setCollapsed(new Set()), [files]);

  const changeView = (v: ChangesView) => {
    setView(v);
    setChangesView(v);
  };
  const toggleFolder = (path: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  const fileRow = (f: FileDiff, depth: number, label: string) => {
    const oldBase = f.old_path ? f.old_path.split("/").pop() ?? f.old_path : null;
    // Tree view shows basenames; a same-name move (a/x -> b/x) would read
    // "x -> x", so fall back to the full old path there.
    const renameFrom = !f.old_path
      ? null
      : view === "tree"
        ? oldBase === label
          ? f.old_path
          : oldBase
        : f.old_path;
    return (
      <div
        key={f.path}
        ref={(el) => {
          if (el && selectedPath === f.path) el.scrollIntoView({ block: "nearest" });
        }}
        className={`file-row${selectedPath === f.path ? " selected" : ""}`}
        style={{ paddingLeft: BASE_PAD + depth * INDENT }}
        title={f.old_path ? `${f.old_path} → ${f.path}` : undefined}
        onClick={() => onSelect(f)}
        onContextMenu={(e) => {
          e.preventDefault();
          onContext(f);
        }}
      >
        <StatusIcon status={f.status} />
        <span className="file-path">
          {renameFrom && <span className="rename-from">{renameFrom} → </span>}
          {label}
        </span>
      </div>
    );
  };

  if (files.length === 0) return <div className="empty-hint">No file changes.</div>;

  return (
    <>
      <div className="commit-files-head">
        <div className="view-toggle">
          <button className={view === "list" ? "active" : ""} onClick={() => changeView("list")}>
            List
          </button>
          <button className={view === "tree" ? "active" : ""} onClick={() => changeView("tree")}>
            Tree
          </button>
        </div>
      </div>
      <div className="commit-files">
        {view === "list"
          ? files.map((f) => fileRow(f, 0, f.path))
          : flattenVisible(buildTree(files), collapsed).map(({ node, depth }) =>
              node.type === "folder" ? (
                <div
                  key={`d-${node.path}`}
                  className="tree-folder"
                  style={{ paddingLeft: BASE_PAD + depth * INDENT }}
                  onClick={() => toggleFolder(node.path)}
                >
                  <span className={`chevron${collapsed.has(node.path) ? "" : " open"}`}>▸</span>
                  <span className="folder-name">{node.name}</span>
                </div>
              ) : (
                fileRow(node.file, depth, node.file.path.split("/").pop() ?? node.file.path)
              )
            )}
      </div>
    </>
  );
}
