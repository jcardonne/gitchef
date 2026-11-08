import { GithubIcon } from "../icons";

/// One-time bottom-right nudge, shown after the user's Nth commit in GitChef,
/// asking for a GitHub star. Either button retires it for good.
export default function StarPrompt({ onStar, onDismiss }: { onStar: () => void; onDismiss: () => void }) {
  return (
    <div className="star-prompt" role="status">
      <span className="star-prompt-title">Enjoying GitChef?</span>
      <span className="star-prompt-body">A star on GitHub helps other developers find it.</span>
      <div className="star-prompt-actions">
        <button className="star-prompt-dismiss" onClick={onDismiss}>
          Not now
        </button>
        <button className="star-prompt-star" onClick={onStar}>
          <GithubIcon size={13} />
          Star on GitHub
        </button>
      </div>
    </div>
  );
}
