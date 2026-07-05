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
