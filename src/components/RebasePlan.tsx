import { useEffect, useState } from "react";
import * as api from "../api";
import { useRepo } from "../repoContext";
import type { RebaseAction, TodoItem } from "../types";

interface Props {
  base: string; // the base ref/sha the rebase replays onto
  baseLabel: string; // human label for the base (e.g. a branch name), for the title
  onClose: () => void; // close the modal (cancel)
  onStarted: () => void; // call AFTER rebaseInteractive resolves so the parent can refresh
}

// Order matches the dropdown the user expects; "drop" last since it is the
// destructive one. Same set as the RebaseAction union.
const ACTIONS: RebaseAction[] = ["pick", "reword", "squash", "fixup", "edit", "drop"];

/// Interactive-rebase plan editor. Fetches the initial all-"pick" todo list
/// (oldest first), lets the user reorder with up/down buttons and pick a
/// per-commit action, then replays it via rebaseInteractive. The list order IS
/// the new history order: top = applied first = oldest.
export default function RebasePlan({ base, baseLabel, onClose, onStarted }: Props) {
  const { repoPath, busy, run, notify } = useRepo();
  // null = still loading; [] = loaded but nothing to rebase.
  const [plan, setPlan] = useState<TodoItem[] | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .rebasePlan(repoPath, base)
      .then((items) => alive && setPlan(items))
      .catch((e) => {
        if (!alive) return;
        notify(String(e), true);
        onClose();
      });
    return () => {
      alive = false;
    };
  }, [repoPath, base, notify, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Swap a row with its neighbour. dir -1 = up (earlier), +1 = down (later).
  const move = (i: number, dir: -1 | 1) =>
    setPlan((prev) => {
      if (!prev) return prev;
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = prev.slice();
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const setAction = (i: number, action: RebaseAction) =>
    setPlan((prev) =>
      prev?.map((it, k) => {
        if (k !== i) return it;
        // Seed the reword box with the current summary the first time we switch.
        const message = action === "reword" ? it.message ?? it.summary : it.message;
        return { ...it, action, message };
      }) ?? null
    );

  const setMessage = (i: number, message: string) =>
    setPlan((prev) => prev?.map((it, k) => (k === i ? { ...it, message } : it)) ?? null);

  // git refuses to squash/fixup onto nothing, so the first surviving commit must
  // be a "real" one. Also need at least one commit left after drops.
  const firstKept = plan?.find((p) => p.action !== "drop");
  const valid = !!firstKept && firstKept.action !== "squash" && firstKept.action !== "fixup";
  const hint = !firstKept
    ? "Keep at least one commit to rebase."
    : "The first kept commit cannot be squash or fixup.";

  const start = () => {
    if (!plan || !valid) return;
    // Only reword carries a message; everything else sends null.
    const payload = plan.map((it) => ({
      ...it,
      message: it.action === "reword" ? it.message : null,
    }));
    run(async () => {
      await api.rebaseInteractive(repoPath, base, payload);
      onStarted();
      onClose();
    }, "rebase");
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal rebase-plan" onClick={(e) => e.stopPropagation()}>
        <h3>Rebase onto {baseLabel}</h3>

        {plan === null ? (
          <p className="rebase-status">Loading commits...</p>
        ) : plan.length === 0 ? (
          <p className="rebase-status">No commits to rebase.</p>
        ) : (
          <ol className="rebase-list">
            {plan.map((item, i) => (
              <li
                key={item.sha}
                className={"rebase-row" + (item.action === "drop" ? " rebase-drop" : "")}
              >
                <div className="rebase-reorder">
                  <button
                    type="button"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                    aria-label="Move up"
                    title="Move up"
                  >
                    {"↑"}
                  </button>
                  <button
                    type="button"
                    disabled={i === plan.length - 1}
                    onClick={() => move(i, 1)}
                    aria-label="Move down"
                    title="Move down"
                  >
                    {"↓"}
                  </button>
                </div>
                <code className="rebase-sha">{item.sha.slice(0, 7)}</code>
                <span className="rebase-summary">{item.summary}</span>
                <select
                  className="rebase-actions"
                  value={item.action}
                  onChange={(e) => setAction(i, e.target.value as RebaseAction)}
                >
                  {ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
                {item.action === "reword" && (
                  <input
                    className="rebase-reword"
                    value={item.message ?? ""}
                    placeholder="New commit message"
                    onChange={(e) => setMessage(i, e.target.value)}
                  />
                )}
              </li>
            ))}
          </ol>
        )}

        {plan && plan.length > 0 && !valid && <p className="rebase-status rebase-bad">{hint}</p>}

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          {plan && plan.length > 0 && (
            <button className="primary-btn" disabled={!valid || busy} onClick={start}>
              Start rebase
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
