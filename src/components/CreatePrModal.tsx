import { useState } from "react";
import { useEscape } from "../useEscape";
import { useChefAi } from "../useChefAi";
import ChefAiDownloadModal from "./ChefAiDownloadModal";

/// Form to open a PR (GitHub) / MR (GitLab) for the current branch via the
/// gh/glab CLI. The source branch is the checked-out one (handled backend-side);
/// here the user sets title, description, and the base branch to target.
export default function CreatePrModal({
  provider,
  baseDefault,
  bases,
  headBranch = "HEAD",
  onSubmit,
  onClose,
}: {
  provider: "github" | "gitlab";
  baseDefault: string;
  bases: string[];
  headBranch?: string;
  onSubmit: (title: string, body: string, base: string) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState(baseDefault);
  const label = provider === "gitlab" ? "Merge Request" : "Pull Request";
  const {
    loading: aiLoading,
    generatePr,
    showDownloadModal,
    setShowDownloadModal,
  } = useChefAi();

  useEscape(onClose);

  const handleGeneratePr = async () => {
    if (aiLoading) return;
    const res = await generatePr(base, headBranch);
    if (!res) return;
    setTitle(res.title);
    setBody(res.body);
  };

  const submit = () => {
    if (!title.trim() || !base) return;
    onClose();
    onSubmit(title.trim(), body, base);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal pr-modal" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>Create {label}</h3>
          <button
            type="button"
            className="chef-ai-btn"
            disabled={aiLoading || !base}
            onClick={handleGeneratePr}
            title="Draft PR title & description using Chef AI"
          >
            {aiLoading ? (
              <svg className="spinner" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <circle cx="8" cy="8" r="6" strokeOpacity={0.3} />
                <path d="M8 2a6 6 0 0 1 6 6" />
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 1.5l1.2 3.8 3.8 1.2-3.8 1.2L8 11.5 6.8 7.7 3 6.5l3.8-1.2L8 1.5z" />
                <path d="M12.5 10.5l.6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6.6-1.9z" />
              </svg>
            )}
            <span>{aiLoading ? "Drafting…" : "Draft with Chef AI"}</span>
          </button>
        </div>

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
        <label className="pr-field">
          <span>Title</span>
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${label} title`} />
        </label>
        <label className="pr-field">
          <span>Description</span>
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} placeholder="Optional description" />
        </label>
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary-btn" disabled={!title.trim() || !base} onClick={submit}>
            Create
          </button>
        </div>
      </div>

      {showDownloadModal && (
        <ChefAiDownloadModal
          onClose={() => setShowDownloadModal(false)}
          onSuccess={handleGeneratePr}
        />
      )}
    </div>
  );
}
