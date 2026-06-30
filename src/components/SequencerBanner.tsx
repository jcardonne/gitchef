import type { SequencerState } from "../types";

// Persistent strip shown while a rebase / merge / cherry-pick / revert is paused
// mid-flight. Continue is gated until every conflict is resolved; the parent
// passes how many conflicted files remain. Purely presentational - all the git
// work lives in the parent's handlers.
interface Props {
  state: SequencerState; // caller renders this only when state.kind != null
  conflictCount: number;
  busy: boolean;
  onContinue: () => void;
  onSkip: () => void;
  onAbort: () => void;
}

const VERB: Record<NonNullable<SequencerState["kind"]>, string> = {
  rebase: "Rebasing",
  merge: "Merging",
  cherry_pick: "Cherry-picking",
  revert: "Reverting",
};

export default function SequencerBanner({
  state,
  conflictCount,
  busy,
  onContinue,
  onSkip,
  onAbort,
}: Props) {
  if (!state.kind) return null;
  const blocked = conflictCount > 0;
  // merge has no per-step skip; the others do.
  const canSkip = state.kind !== "merge";

  let detail = VERB[state.kind];
  if (state.kind === "rebase") {
    if (state.interactive) detail += " (interactive)";
    if (state.head_name) detail += ` ${state.head_name}`;
    if (state.onto) detail += ` onto ${state.onto}`;
    if (state.total) detail += ` - step ${state.current}/${state.total}`;
  }

  return (
    <div className={`seq-banner${blocked ? " has-conflicts" : ""}`}>
      <div className="seq-banner-info">
        <span className="seq-banner-title">{detail}</span>
        <span className="seq-banner-status">
          {blocked
            ? `${conflictCount} file${conflictCount > 1 ? "s" : ""} to resolve`
            : "All conflicts resolved"}
        </span>
      </div>
      <div className="seq-banner-actions">
        <button
          className="mini-btn primary"
          disabled={blocked || busy}
          onClick={onContinue}
          title={blocked ? "Resolve every conflict first" : "Continue the operation"}
        >
          Continue
        </button>
        {canSkip && (
          <button className="mini-btn" disabled={busy} onClick={onSkip} title="Skip this step">
            Skip
          </button>
        )}
        <button className="mini-btn danger" disabled={busy} onClick={onAbort} title="Abort and restore">
          Abort
        </button>
      </div>
    </div>
  );
}
