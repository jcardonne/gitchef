import { useEffect, useRef, useState } from "react";
import type { FileDiff } from "../types";
import { getChangesView, setChangesView, type ChangesView } from "../storage";
import { buildTree, flattenVisible } from "../fileTree";
import { StatusIcon, renameLabel } from "./ChangeList";

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

  // Scroll the selected row into view only when the selection changes - NOT via
  // an inline ref (which re-fires on every re-render, snapping the list back
  // whenever an unrelated parent state update lands). A row in a collapsed tree
  // folder isn't mounted, so its scroll is simply skipped.
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    if (selectedPath) rowRefs.current.get(selectedPath)?.scrollIntoView({ block: "nearest" });
  }, [selectedPath]);

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
    const renameFrom = renameLabel(f.old_path, label, view);
    return (
      <div
        key={f.path}
        ref={(el) => {
          if (el) rowRefs.current.set(f.path, el);
          else rowRefs.current.delete(f.path);
        }}
        className={`file-row${selectedPath === f.path ? " selected" : ""}`}
        style={{ paddingLeft: BASE_PAD + depth * INDENT }}
        title={f.old_path ? `${f.old_path} → ${f.path}` : f.path}
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
