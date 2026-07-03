// Persistent strip naming the last history-moving operation, with a one-click
// Undo (a hard reset back to the snapshot HEAD taken before the op). Rendered in
// the same slot as SequencerBanner and only when no operation is mid-flight, so
// the two never stack. Purely presentational - the reset lives in the parent.
interface Props {
  label: string; // e.g. "rebase onto main"
  busy: boolean;
  onUndo: () => void;
  onDismiss: () => void;
}

export default function UndoBar({ label, busy, onUndo, onDismiss }: Props) {
  return (
    <div className="undo-bar">
      <span className="undo-bar-label">
        Last: <strong>{label}</strong>
      </span>
      <div className="undo-bar-actions">
        <button
          className="mini-btn"
          disabled={busy}
          onClick={onUndo}
          title="Reset to before this operation"
        >
          Undo
        </button>
        <button
          className="mini-btn undo-bar-dismiss"
          onClick={onDismiss}
          title="Dismiss"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}
