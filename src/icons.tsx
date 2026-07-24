/// Shared ref/section icons, used by BOTH the left sidebar and the graph's branch
/// badges so the two never drift. currentColor + a `size` knob is all they take;
/// color comes from the surrounding text color.
type IconProps = { size?: number };

const base = (size: number) =>
  ({
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  }) as const;

/// Monitor/PC = a *local* branch (matches the sidebar's "Local" section).
export const LocalIcon = ({ size = 13 }: IconProps) => (
  <svg {...base(size)}>
    <rect x="2" y="3" width="12" height="8" rx="1.3" />
    <path d="M8 11v2.5M5.5 13.5h5" />
  </svg>
);
/// Cloud = a remote-tracking branch.
export const RemoteIcon = ({ size = 13 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4.5 12.5a3 3 0 0 1-.3-6A3.6 3.6 0 0 1 11 5.3a2.8 2.8 0 0 1 .4 7.2H4.5z" />
  </svg>
);
export const TagIcon = ({ size = 13 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M2.5 8.3V3.2a.7.7 0 0 1 .7-.7h5.1L14 7.8a1 1 0 0 1 0 1.4l-3.8 3.8a1 1 0 0 1-1.4 0L2.5 8.3z" />
    <circle cx="5.2" cy="5.2" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);
export const StashIcon = ({ size = 13 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M2 5.5 3.2 3h9.6L14 5.5" />
    <rect x="2" y="5.5" width="12" height="7" rx="1" />
    <path d="M6 8.5h4" />
  </svg>
);
/// Detached HEAD marker (a lone commit dot).
export const HeadIcon = ({ size = 13 }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="8" cy="8" r="3.2" />
  </svg>
);
/// Fork = a branch that has an open PR/MR (reserved; not wired up yet).
export const BranchIcon = ({ size = 13 }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="5" cy="4" r="1.6" />
    <circle cx="5" cy="12" r="1.6" />
    <circle cx="11" cy="6.5" r="1.6" />
    <path d="M5 5.6v4.8M5 8h2.5A3 3 0 0 0 10.5 5" />
  </svg>
);
/// Padlock = a locked worktree.
export const LockIcon = ({ size = 13 }: IconProps) => (
  <svg {...base(size)}>
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </svg>
);
export const CloseIcon = ({ size = 13 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);
/// Git pull/merge request glyph - the Pull Requests sidebar section.
export const PullRequestIcon = ({ size = 13 }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="4" cy="4" r="1.6" />
    <circle cx="4" cy="12" r="1.6" />
    <path d="M4 5.6v4.8" />
    <circle cx="12" cy="12" r="1.6" />
    <path d="M12 10.4V6a2 2 0 0 0-2-2H7" />
    <path d="M9 2.5 7 4l2 1.5" />
  </svg>
);
export const CheckIcon = ({ size = 13 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M3.5 8.5l3 3 6-6.5" />
  </svg>
);
/// GitHub mark (filled, currentColor so it tints with the tab state).
export const GithubIcon = ({ size = 14 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path fillRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
  </svg>
);
/// GitLab tanuki (filled silhouette, currentColor). viewBox 36 like the brand asset.
export const GitlabIcon = ({ size = 14 }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 36 36" fill="currentColor" aria-hidden="true">
    <path d="M2 14l9.38 9v-9l-4-12.28c-.205-.632-1.176-.632-1.38 0z" />
    <path d="M34 14l-9.38 9v-9l4-12.28c.205-.632 1.176-.632 1.38 0z" />
    <path d="M18 34.38 3 14 33 14z" />
    <path d="M18 34.38 11.38 14 2 14 6 25z" />
    <path d="M18 34.38 24.62 14 34 14 30 25z" />
    <path d="M2 14 .1 20.16c-.18.565 0 1.2.5 1.56L18 34.38z" />
    <path d="M34 14l1.9 6.16c.18.565 0 1.2-.5 1.56L18 34.38z" />
  </svg>
);
/// Chain link - the "Paste URL" tab.
export const LinkIcon = ({ size = 14 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M6.5 9.5a2.5 2.5 0 0 0 3.5 0l2-2a2.5 2.5 0 0 0-3.5-3.5l-1 1" />
    <path d="M9.5 6.5a2.5 2.5 0 0 0-3.5 0l-2 2a2.5 2.5 0 0 0 3.5 3.5l1-1" />
  </svg>
);
