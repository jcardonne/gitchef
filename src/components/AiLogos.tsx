interface LogoProps {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

/// Official Alibaba Qwen crystalline hex-prism logo
export function QwenLogo({ size = 20, className, style }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0, ...style }}
    >
      <defs>
        <linearGradient id="qwen-grad-outer" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="50%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#d946ef" />
        </linearGradient>
        <linearGradient id="qwen-grad-inner" x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#38bdf8" />
          <stop offset="100%" stopColor="#6366f1" />
        </linearGradient>
      </defs>
      <path
        d="M16 2L28 9V23L16 30L4 23V9L16 2Z"
        fill="url(#qwen-grad-outer)"
      />
      <path
        d="M16 6.5L24 11.2V20.8L16 25.5L8 20.8V11.2L16 6.5Z"
        fill="#0f172a"
        opacity="0.9"
      />
      <path
        d="M16 9.5L21.5 12.7V19.3L16 22.5L10.5 19.3V12.7L16 9.5Z"
        fill="url(#qwen-grad-inner)"
      />
      <path
        d="M16 12.8L19.2 14.7V17.3L16 19.2L12.8 17.3V14.7L16 12.8Z"
        fill="#ffffff"
      />
    </svg>
  );
}

/// Official Ollama cute llama mascot silhouette
export function OllamaLogo({ size = 20, className, style }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0, ...style }}
    >
      <path d="M8 2.2c-.7 0-1.2.5-1.2 1.2v3.1c-.5.3-.8.8-.8 1.4v4.5c0 .7.5 1.2 1.2 1.2h.8v4.2c0 .7.5 1.2 1.2 1.2h1.6c.7 0 1.2-.5 1.2-1.2V16h1v1.8c0 .7.5 1.2 1.2 1.2h1.6c.7 0 1.2-.5 1.2-1.2V11.5c0-.9-.7-1.6-1.6-1.6h-1.4V7.5c0-.7-.5-1.2-1.2-1.2H11V3.4c0-.7-.5-1.2-1.2-1.2H8zm.6 1.8h1v3h-1V4zm.6 4.5h2v2h-2v-2zm5.8 4.2h1.6v3.8H15v-3.8z" />
    </svg>
  );
}

/// Official OpenAI circular geometric rosette
export function OpenAiLogo({ size = 20, className, style }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0, ...style }}
    >
      <path d="M22.28 9.82a5.98 5.98 0 0 0-.51-4.91 6.05 6.05 0 0 0-6.51-2.9 6.06 6.06 0 0 0-4.28 2.17A5.98 5.98 0 0 0 7 7.08a6.05 6.05 0 0 0 .74 7.1 5.98 5.98 0 0 0 .51 4.91 6.05 6.05 0 0 0 6.51 2.9A5.98 5.98 0 0 0 19 20.8a6.05 6.05 0 0 0 3.28-7.1v-.08a5.98 5.98 0 0 0 0-3.8zM13.26 22.43a4.5 4.5 0 0 1-2.88-1.04l.14-.08 4.78-2.76a.8.8 0 0 0 .39-.68V11.13l2.02 1.17c.02.01.04.03.04.05v5.59a4.5 4.5 0 0 1-4.49 4.49zm-9.66-4.13a4.47 4.47 0 0 1-.53-3.01l.14.08 4.78 2.76a.77.77 0 0 0 .78 0l5.84-3.37v2.33a.08.08 0 0 1-.03.06L9.74 19.95a4.5 4.5 0 0 1-6.14-1.65zM2.34 7.9a4.48 4.48 0 0 1 2.37-1.97v5.67a.77.77 0 0 0 .39.68l5.81 3.35-2.02 1.17a.08.08 0 0 1-.07 0L3.99 14.01A4.5 4.5 0 0 1 2.34 7.9zm16.6 3.86l-5.84-3.37 2.02-1.16a.08.08 0 0 1 .07 0l4.83 2.79a4.49 4.49 0 0 1-.68 8.1v-5.68a.79.79 0 0 0-.4-.68zm2.01-3.02l-.14-.09-4.77-2.78a.78.78 0 0 0-.79 0L9.41 9.23V6.9a.07.07 0 0 1 .03-.06l4.83-2.79a4.5 4.5 0 0 1 6.68 4.67zM8.31 4.61a4.5 4.5 0 0 1 3.54 0l-.14.08-4.78 2.76a.77.77 0 0 0-.39.68v6.74L4.52 13.7a.07.07 0 0 1-.04-.05V7.87a4.48 4.48 0 0 1 3.25-3.27zm1.13 4.9l2.73-1.57 2.73 1.57v3.15l-2.73 1.58-2.73-1.58V9.51z" />
    </svg>
  );
}

/// Official Meta Llama infinity symbol
export function MetaLogo({ size = 20, className, style }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0, ...style }}
    >
      <path d="M12 8.7c-1.9 0-3.4 1.3-4.2 2.9-.7 1.4-1.8 3.5-3 3.5-.9 0-1.6-.7-1.6-1.6 0-1.7 1.4-3.9 3.6-3.9 1.4 0 2.5.7 3.2 1.7.7-1 1.8-1.7 3.2-1.7 2.2 0 3.6 2.2 3.6 3.9 0 .9-.7 1.6-1.6 1.6-1.2 0-2.3-2.1-3-3.5-.8-1.6-2.3-2.9-4.2-2.9zm0 6.6c1.9 0 3.4-1.3 4.2-2.9.7-1.4 1.8-3.5 3-3.5.9 0 1.6.7 1.6 1.6 0 1.7-1.4 3.9-3.6 3.9-1.4 0-2.5-.7-3.2-1.7-.7 1-1.8 1.7-3.2 1.7-2.2 0-3.6-2.2-3.6-3.9 0-.9.7-1.6 1.6-1.6 1.2 0 2.3 2.1 3 3.5.8 1.6 2.3 2.9 4.2 2.9z" />
    </svg>
  );
}

/// Apple Metal / Hardware acceleration lightning bolt
export function MetalGpuIcon({ size = 16, className, style }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0, ...style }}
    >
      <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  );
}

/// RAM / Memory chip icon
export function RamIcon({ size = 16, className, style }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0, ...style }}
    >
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 6V3M11 6V3M15 6V3M7 21v-3M11 21v-3M15 21v-3M7 10h10M7 14h10" />
    </svg>
  );
}

/// Offline / Security shield lock icon
export function ShieldLockIcon({ size = 16, className, style }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0, ...style }}
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

/// Speed / Latency gauge icon
export function SpeedIcon({ size = 16, className, style }: LogoProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ display: "inline-block", verticalAlign: "middle", flexShrink: 0, ...style }}
    >
      <path d="M12 14l3-3" />
      <path d="M3.34 19a10 10 0 1 1 17.32 0" />
    </svg>
  );
}
