import { useEffect } from "react";

/// Closes an overlay when the user presses Escape anywhere in the window.
/// Shared by every modal so the pattern lives in one place.
export function useEscape(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}
