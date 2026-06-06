import type { UpdateStatus } from "../updater";

/// Unobtrusive bottom-right toast shown while a silent update downloads and
/// installs. Disappears on its own when the app relaunches into the new build.
export default function UpdateToast({ status }: { status: UpdateStatus | null }) {
  if (!status) return null;

  const label =
    status.phase === "installing"
      ? `Installation de la v${status.version}…`
      : status.pct === null
        ? `Telechargement de la v${status.version}…`
        : `Telechargement de la v${status.version}… ${status.pct}%`;

  // Determinate bar while downloading with a known size; indeterminate sweep
  // otherwise (unknown length, or during install).
  const pct = status.phase === "downloading" ? status.pct : null;

  return (
    <div className="update-toast" role="status">
      <span className="update-toast-label">{label}</span>
      <div className={`update-toast-bar${pct === null ? " indeterminate" : ""}`}>
        <div className="update-toast-fill" style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
    </div>
  );
}
