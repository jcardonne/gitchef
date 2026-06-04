import { useState } from "react";
import type { FileStatus, StatusResult } from "../types";

interface Props {
  status: StatusResult;
  selectedPath: string | null;
  onSelectFile: (path: string, staged: boolean) => void;
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
  onStageAll: () => void;
  onUnstageAll: () => void;
  onCommit: (message: string) => void;
  busy: boolean;
}

const STATUS_GLYPH: Record<string, string> = {
  new: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  typechange: "T",
  conflicted: "!",
};

function FileRow({
  file,
  selected,
  onSelect,
  actionLabel,
  onAction,
}: {
  file: FileStatus;
  selected: boolean;
  onSelect: () => void;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className={`file-row${selected ? " selected" : ""}`} onClick={onSelect}>
      <span className={`status-glyph s-${file.status}`}>
        {STATUS_GLYPH[file.status] ?? "?"}
      </span>
      <span className="file-path">{file.path}</span>
      <button
        className="mini-btn"
        onClick={(e) => {
          e.stopPropagation();
          onAction();
        }}
      >
        {actionLabel}
      </button>
    </div>
  );
}

/// The commit composer: unstaged changes up top, staged below, message + commit
/// at the bottom. This is the everyday loop GitKraken lives in.
export default function StagingPanel({
  status,
  selectedPath,
  onSelectFile,
  onStage,
  onUnstage,
  onStageAll,
  onUnstageAll,
  onCommit,
  busy,
}: Props) {
  const [message, setMessage] = useState("");

  const handleCommit = () => {
    if (!message.trim() || status.staged.length === 0) return;
    onCommit(message);
    setMessage("");
  };

  return (
    <div className="staging">
      <div className="staging-section">
        <div className="section-head">
          <span>Unstaged ({status.unstaged.length})</span>
          <button className="mini-btn" disabled={!status.unstaged.length} onClick={onStageAll}>
            Stage all
          </button>
        </div>
        <div className="file-list">
          {status.unstaged.map((f) => (
            <FileRow
              key={`u-${f.path}`}
              file={f}
              selected={selectedPath === f.path}
              onSelect={() => onSelectFile(f.path, false)}
              actionLabel="Stage"
              onAction={() => onStage(f.path)}
            />
          ))}
        </div>
      </div>

      <div className="staging-section">
        <div className="section-head">
          <span>Staged ({status.staged.length})</span>
          <button className="mini-btn" disabled={!status.staged.length} onClick={onUnstageAll}>
            Unstage all
          </button>
        </div>
        <div className="file-list">
          {status.staged.map((f) => (
            <FileRow
              key={`s-${f.path}`}
              file={f}
              selected={selectedPath === f.path}
              onSelect={() => onSelectFile(f.path, true)}
              actionLabel="Unstage"
              onAction={() => onUnstage(f.path)}
            />
          ))}
        </div>
      </div>

      <div className="commit-box">
        <textarea
          placeholder="Commit message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <button
          className="primary-btn"
          disabled={busy || !message.trim() || status.staged.length === 0}
          onClick={handleCommit}
        >
          Commit {status.staged.length ? `(${status.staged.length})` : ""}
        </button>
      </div>
    </div>
  );
}
