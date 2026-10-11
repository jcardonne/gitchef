import { useEffect, useRef } from "react";
import { createEscapeStack } from "./escapeStack";

const stack = createEscapeStack();

/// Closes an overlay when the user presses Escape anywhere in the window. Shared
/// by every modal. With several overlays open (e.g. a modal launched from
/// Settings) only the one opened last reacts, so one Escape closes one layer.
export function useEscape(onClose: () => void): void {
  // Latest callback without re-registering, so a parent re-render cannot move
  // this overlay's position in the stack.
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    const id = {};
    stack.push(id);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && stack.isTop(id)) latest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      stack.remove(id);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
}
