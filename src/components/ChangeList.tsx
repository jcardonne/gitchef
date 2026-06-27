import { useEffect, useMemo, useRef, useState } from "react";
import type { FileStatus, FileStatusKind } from "../types";
import type { ChangesView } from "../storage";
import { buildTree, filesIn, flattenVisible, type TreeFile, type TreeFolder, type TreeNode } from "../fileTree";
import { nextIndex, rangeKeys } from "../changeNav";
import { useVirtual } from "../useVirtual";

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
  recentlyMoved?: Set<string>;
}

const INDENT = 14;
const BASE_PAD = 12;
const ROW_H = 24; // must match the .file-row / .tree-folder height in CSS
const EMPTY_TREE: TreeNode[] = []; // stable ref so list view never builds a tree

// One flat, fixed-height row model shared by BOTH views, so a single windowing
// pass drives the list and the tree alike.
type Row =
  | { kind: "file"; file: FileStatus; depth: number; label: string }
  | { kind: "folder"; node: TreeFolder; depth: number };

/// Renders one section's files as a flat list or a collapsible folder tree, with
/// click / Cmd+click / Shift+click selection and per-row context + quick action.
function ChangeList({
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
  recentlyMoved,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Shift-range anchor stored as the file itself (not an index), so collapsing a
  // folder between clicks can't make the anchor point at the wrong row.
  const anchor = useRef<FileStatus | null>(null);
  const pendingFocus = useRef<number | null>(null);

  // List view never needs the folder tree, so skip building it (buildTree is
  // O(N) and used to run on every render even in list view).
  const tree = useMemo(() => (view === "tree" ? buildTree(files) : EMPTY_TREE), [view, files]);
  const visible = useMemo(
    () => (view === "tree" ? flattenVisible(tree, collapsed) : []),
    [view, tree, collapsed]
  );

  // Files in current display order - the basis for Shift+click ranges.
  const orderedFiles = useMemo(
    () => (view === "list" ? files : visibleFiles(visible)),
    [view, files, visible]
  );
  const indexOf = useMemo(() => {
    const m = new Map<FileStatus, number>();
    orderedFiles.forEach((f, i) => m.set(f, i));
    return m;
  }, [orderedFiles]);

  // Both views feed ONE flat fixed-height array; the window math is identical to
  // FileView. Folders carry their depth so the tree renders at the right indent.
  const rows = useMemo<Row[]>(
    () =>
      view === "list"
        ? files.map((f) => ({ kind: "file", file: f, depth: 0, label: f.path }))
        : visible.map(({ node, depth }) =>
            node.type === "folder"
              ? { kind: "folder", node, depth }
              : {
                  kind: "file",
                  file: node.file,
                  depth,
                  label: node.file.path.split("/").pop() ?? node.file.path,
                }
          ),
    [view, files, visible]
  );
  // A file's position in the MIXED rows array (folders shift offsets in tree
  // view) - lets keyboard nav scroll the correct row into view.
  const rowIndexOf = useMemo(() => {
    const m = new Map<FileStatus, number>();
    rows.forEach((r, i) => {
      if (r.kind === "file") m.set(r.file, i);
    });
    return m;
  }, [rows]);

  // Fixed-row windowing shared with FileView/DiffViewer. No resetKey: the list
  // keeps its scroll position as rows are staged in/out.
  const { ref: listRef, start, end, scrollTop, padTop, padBottom } = useVirtual(rows.length, ROW_H);

  // Virtualization unmounts off-screen rows, so positional focus no longer
  // works. Scroll the target row into the window, then focus it once it mounts
  // (the effect below re-tries after the scroll-driven re-render).
  const flushFocus = () => {
    const t = pendingFocus.current;
    if (t == null) return;
    const node = listRef.current?.querySelector<HTMLElement>(`.file-row[data-idx="${t}"]`);
    if (node) {
      node.focus();
      pendingFocus.current = null;
    }
  };
  const focusFile = (target: number) => {
    pendingFocus.current = target;
    const el = listRef.current;
    if (el) {
      const top = (rowIndexOf.get(orderedFiles[target]) ?? target) * ROW_H;
      let want = el.scrollTop;
      if (top < el.scrollTop) want = top;
      else if (top + ROW_H > el.scrollTop + el.clientHeight) want = top + ROW_H - el.clientHeight;
      if (want !== el.scrollTop) el.scrollTop = want;
    }
    flushFocus();
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(flushFocus, [scrollTop, rows]);

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

  // Keyboard nav (rows are focusable): arrows move + select, Shift extends from
  // the anchor, Space stages/unstages, Enter opens the diff, Cmd/Ctrl+A selects
  // all. Arrows stay in this section; Tab crosses to the next one natively.
  const handleKey = (f: FileStatus, index: number, e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const target = nextIndex(index, e.key === "ArrowDown" ? 1 : -1, orderedFiles.length);
      if (target < 0) return;
      focusFile(target);
      if (e.shiftKey) {
        const base = (anchor.current ? indexOf.get(anchor.current) : index) ?? index;
        onSelectionChange(new Set([...selected, ...rangeKeys(orderedFiles, keyOf, base, target)]));
      } else {
        const tf = orderedFiles[target];
        onSelectionChange(new Set([keyOf(tf)]));
        anchor.current = tf;
        onShowDiff(tf); // mirror the commit-file list: arrow nav updates the preview
      }
    } else if (e.key === " ") {
      e.preventDefault();
      onQuickToggle(f);
    } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      onSelectionChange(new Set([keyOf(f)]));
      anchor.current = f;
      onShowDiff(f);
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      onSelectionChange(new Set(orderedFiles.map(keyOf)));
    }
  };

  const toggleFolder = (path: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  const fileRow = (f: FileStatus, depth: number, label: string) => {
    const index = indexOf.get(f) ?? 0;
    const oldBase = f.old_path ? f.old_path.split("/").pop() ?? f.old_path : null;
    // Tree view shows basenames, but a same-name move (a/x.ts -> b/x.ts) would
    // read "x.ts -> x.ts"; fall back to the full old path in that case.
    const renameFrom = !f.old_path
      ? null
      : view === "tree"
        ? oldBase === label
          ? f.old_path
          : oldBase
        : f.old_path;
    return (
      <div
        key={keyOf(f)}
        className={`file-row${selected.has(keyOf(f)) ? " selected" : ""}${recentlyMoved?.has(f.path) ? " just-moved" : ""}`}
        style={{ paddingLeft: BASE_PAD + depth * INDENT }}
        data-idx={index}
        title={f.old_path ? `${f.old_path} → ${f.path}` : undefined}
        onClick={(e) => handleClick(f, index, e)}
        tabIndex={0}
        onKeyDown={(e) => handleKey(f, index, e)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!selected.has(keyOf(f))) onSelectionChange(new Set([keyOf(f)]));
          onContext(f);
        }}
      >
        <StatusIcon status={f.status} />
        <span className="file-path">
          {renameFrom && <span className="rename-from">{renameFrom} → </span>}
          {label}
        </span>
        <button
          className={`mini-btn row-action${staged ? "" : " row-stage"}`}
          tabIndex={-1}
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

  // Always render the .change-list scroll container (even when empty) so the
  // scroll/resize listener stays attached across empty <-> non-empty changes.
  return (
    <div className="change-list" ref={listRef}>
      {rows.length === 0 ? (
        <div className="empty-hint small">No files</div>
      ) : (
        <div style={{ paddingTop: padTop, paddingBottom: padBottom }}>
          {rows.slice(start, end).map((r) =>
            r.kind === "folder" ? (
              <div
                key={`d-${r.node.path}`}
                className="tree-folder"
                style={{ paddingLeft: BASE_PAD + r.depth * INDENT }}
                onClick={() => toggleFolder(r.node.path)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onFolderContext(filesIn(r.node), r.node.path);
                }}
              >
                <span className={`chevron${collapsed.has(r.node.path) ? "" : " open"}`}>▸</span>
                <span className="folder-name">{r.node.name}</span>
              </div>
            ) : (
              fileRow(r.file, r.depth, r.label)
            )
          )}
        </div>
      )}
    </div>
  );
}

function visibleFiles(visible: { node: { type: string } }[]): FileStatus[] {
  return visible
    .filter((v) => v.node.type === "file")
    .map((v) => (v.node as TreeFile).file);
}

export function StatusIcon({ status }: { status: FileStatusKind }) {
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

export default ChangeList;
