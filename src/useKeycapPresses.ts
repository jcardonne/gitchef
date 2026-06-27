import { useEffect } from "react";

const MOD_KEYS = new Set(["Meta", "Control", "Shift", "Alt"]);

/// Map a live KeyboardEvent.key to the combo token used in shortcuts.ts.
/// Modifiers are handled from the event flags instead, so they return null here.
function tokenForKey(key: string): string | null {
  if (MOD_KEYS.has(key)) return null;
  if (key === " ") return "Space";
  if (key === "Enter" || key === "Tab" || key === "Escape") return key;
  if (key.startsWith("Arrow")) return key;
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/// While `active`, mirror real key presses onto on-screen keycaps: any
/// `<kbd class="keycap" data-key="…">` whose token is currently held gets a
/// `.pressed` class. Purely visual - it never calls preventDefault, so app
/// shortcuts and typing keep working while the shortcut map is on screen.
export function useKeycapPresses(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const held = new Set<string>();
    const setTok = (tok: string, on: boolean) => {
      if (on) held.add(tok);
      else held.delete(tok);
    };
    const paint = () => {
      for (const el of document.querySelectorAll<HTMLElement>(".keycap[data-key]")) {
        const token = el.dataset.key;
        if (token) el.classList.toggle("pressed", held.has(token));
      }
    };
    const sync = (e: KeyboardEvent, down: boolean) => {
      setTok("shift", e.shiftKey);
      setTok("alt", e.altKey);
      setTok("mod", e.metaKey || e.ctrlKey);
      setTok("ctrl", e.ctrlKey);
      const token = tokenForKey(e.key);
      if (token) setTok(token, down);
      paint();
    };
    const onDown = (e: KeyboardEvent) => sync(e, true);
    const onUp = (e: KeyboardEvent) => sync(e, false);
    const clear = () => {
      held.clear();
      paint();
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", clear);
      clear();
    };
  }, [active]);
}
