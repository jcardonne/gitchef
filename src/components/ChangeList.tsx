import { useMemo, useRef, useState } from "react";
import type { FileStatus, FileStatusKind } from "../types";
import type { ChangesView } from "../storage";
import { buildTree, filesIn, flattenVisible, type TreeFile } from "../fileTree";

interface Props {
  files: FileStatus[];
  staged: boolean;
  view: ChangesView;
  selected: Set<string>;
  keyOf: (f: FileStatus) => string;
  onSelectionChange: (next: Set<string>) => void;
  onShowDiff: (f: FileStatus) => void;
  onContext: (f: FileStatus) => void;
  onFolderContext: (files: FileStatus[], folderPath: string) => void;
  onQuickToggle: (f: FileStatus) => void;
}

const INDENT = 14;
const BASE_PAD = 12;

/// Renders one section's files as a flat list or a collapsible folder tree, with
/// click / Cmd+click / Shift+click selection and per-row context + quick action.
export default function ChangeList({
  files,
  staged,
  view,
  selected,
  keyOf,
  onSelectionChange,
  onShowDiff,
  onContext,
  onFolderContext,
  onQuickToggle,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Shift-range anchor stored as the file itself (not an index), so collapsing a
  // folder between clicks can't make the anchor point at the wrong row.
  const anchor = useRef<FileStatus | null>(null);

  const tree = useMemo(() => buildTree(files), [files]);
  const visible = useMemo(() => flattenVisible(tree, collapsed), [tree, collapsed]);

  // Files in current display order - the basis for Shift+click ranges.
  const orderedFiles = view === "list" ? files : visibleFiles(visible);
  const indexOf = useMemo(() => {
    const m = new Map<FileStatus, number>();
    orderedFiles.forEach((f, i) => m.set(f, i));
    return m;
  }, [orderedFiles]);

  const handleClick = (f: FileStatus, index: number, e: React.MouseEvent) => {
    const k = keyOf(f);
    const anchorIdx = anchor.current ? indexOf.get(anchor.current) : undefined;
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(selected);
      next.has(k) ? next.delete(k) : next.add(k);
      onSelectionChange(next);
      anchor.current = f;
    } else if (e.shiftKey && anchorIdx !== undefined) {
      const [a, b] = [anchorIdx, index].sort((x, y) => x - y);
      const next = new Set(selected);
      for (let i = a; i <= b; i++) next.add(keyOf(orderedFiles[i]));
      onSelectionChange(next);
    } else {
      onSelectionChange(new Set([k]));
      anchor.current = f;
    }
    onShowDiff(f);
  };

  const toggleFolder = (path: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  const fileRow = (f: FileStatus, depth: number, label: string) => {
    const index = indexOf.get(f) ?? 0;
    return (
      <div
        key={keyOf(f)}
        className={`file-row${selected.has(keyOf(f)) ? " selected" : ""}`}
        style={{ paddingLeft: BASE_PAD + depth * INDENT }}
        onClick={(e) => handleClick(f, index, e)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!selected.has(keyOf(f))) onSelectionChange(new Set([keyOf(f)]));
          onContext(f);
        }}
      >
        <StatusIcon status={f.status} />
        <span className="file-path">{label}</span>
        <button
          className={`mini-btn row-action${staged ? "" : " row-stage"}`}
          onClick={(e) => {
            e.stopPropagation();
            onQuickToggle(f);
          }}
        >
          {staged ? "Unstage" : "Stage"}
        </button>
      </div>
    );
  };

  if (files.length === 0) {
    return <div className="empty-hint small">No files</div>;
  }

  if (view === "list") {
    return <div className="change-list">{files.map((f) => fileRow(f, 0, f.path))}</div>;
  }

  return (
    <div className="change-list">
      {visible.map(({ node, depth }) =>
        node.type === "folder" ? (
          <div
            key={`d-${node.path}`}
            className="tree-folder"
            style={{ paddingLeft: BASE_PAD + depth * INDENT }}
            onClick={() => toggleFolder(node.path)}
            onContextMenu={(e) => {
              e.preventDefault();
              onFolderContext(filesIn(node), node.path);
            }}
          >
            <span className={`chevron${collapsed.has(node.path) ? "" : " open"}`}>▸</span>
            <span className="folder-name">{node.name}</span>
          </div>
        ) : (
          fileRow(node.file, depth, node.file.path.split("/").pop() ?? node.file.path)
        )
      )}
    </div>
  );
}

function visibleFiles(visible: { node: { type: string } }[]): FileStatus[] {
  return visible
    .filter((v) => v.node.type === "file")
    .map((v) => (v.node as TreeFile).file);
}

function StatusIcon({ status }: { status: FileStatusKind }) {
  const label = STATUS_LABEL[status];
  return (
    <span className={`status-glyph s-${status}`} title={label} aria-label={label}>
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        {status === "new" && (
          <>
            <path d="M8 3v10" />
            <path d="M3 8h10" />
          </>
        )}
        {status === "modified" && (
          <>
            <path d="M4 12l2.8-.6 5.6-5.6-2.2-2.2-5.6 5.6L4 12z" />
            <path d="M9.4 4.4l2.2 2.2" />
          </>
        )}
        {status === "deleted" && (
          <>
            <path d="M3.5 4.5h9" />
            <path d="M6 4.5V3.2h4v1.3" />
            <path d="M5 6.5l.5 6h5l.5-6" />
            <path d="M7 7.5v3.5" />
            <path d="M9.5 7.5v3.5" />
          </>
        )}
        {status === "renamed" && (
          <>
            <path d="M3 5h8" />
            <path d="M8.5 2.5 11 5 8.5 7.5" />
            <path d="M13 11H5" />
            <path d="M7.5 8.5 5 11l2.5 2.5" />
          </>
        )}
        {status === "typechange" && (
          <>
            <path d="M4 3.5h5l3 3v6H4z" />
            <path d="M9 3.5v3h3" />
            <path d="M6 9.5h4" />
          </>
        )}
        {status === "conflicted" && (
          <>
            <path d="M4.5 4.5l7 7" />
            <path d="M11.5 4.5l-7 7" />
          </>
        )}
      </svg>
    </span>
  );
}

const STATUS_LABEL: Record<FileStatusKind, string> = {
  new: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  typechange: "Type changed",
  conflicted: "Conflicted",
};
