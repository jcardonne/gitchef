import { useEffect, useState } from "react";

/// Form to open a PR (GitHub) / MR (GitLab) for the current branch via the
/// gh/glab CLI. The source branch is the checked-out one (handled backend-side);
/// here the user sets title, description, and the base branch to target.
export default function CreatePrModal({
  provider,
  baseDefault,
  bases,
  onSubmit,
  onClose,
}: {
  provider: "github" | "gitlab";
  baseDefault: string;
  bases: string[];
  onSubmit: (title: string, body: string, base: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState(baseDefault);
  const label = provider === "gitlab" ? "Merge Request" : "Pull Request";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = () => {
    if (!title.trim() || !base) return;
    onClose();
    onSubmit(title.trim(), body, base);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal pr-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Create {label}</h3>
        <label className="pr-field">
          <span>Title</span>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${label} title`} />
        </label>
        <label className="pr-field">
          <span>Description</span>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} placeholder="Optional description" />
        </label>
        <label className="pr-field">
          <span>Base branch</span>
          <select value={base} onChange={(e) => setBase(e.target.value)}>
            {bases.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary-btn" disabled={!title.trim() || !base} onClick={submit}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
