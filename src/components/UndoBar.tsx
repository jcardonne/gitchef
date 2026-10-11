import { CloseIcon } from "../icons";

// Persistent strip naming the last history-moving operation, with a one-click
// Undo (a hard reset back to the snapshot HEAD taken before the op). Rendered in
// the same slot as SequencerBanner and only when no operation is mid-flight, so
// the two never stack. Purely presentational - the reset lives in the parent.
interface Props {
  label: string; // e.g. "rebase onto main"
  lead?: string; // text before the label, default "Last:"
  actionLabel?: string; // default "Undo"
  actionTitle?: string;
  busy: boolean;
  onUndo: () => void;
  onDismiss: () => void;
}

export default function UndoBar({
  label,
  lead = "Last:",
  actionLabel = "Undo",
  actionTitle = "Reset to before this operation",
  busy,
  onUndo,
  onDismiss,
}: Props) {
  return (
    <div className="undo-bar">
      <span className="undo-bar-label">
        {lead} <strong>{label}</strong>
      </span>
      <div className="undo-bar-actions">
        <button
          className="mini-btn"
          disabled={busy}
          onClick={onUndo}
          title={actionTitle}
        >
          {actionLabel}
        </button>
        <button
          className="mini-btn undo-bar-dismiss"
          onClick={onDismiss}
          title="Dismiss"
          aria-label="Dismiss"
        >
          <CloseIcon size={12} />
        </button>
      </div>
    </div>
  );
}
