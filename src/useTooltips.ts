import { useEffect } from "react";

// A single delegated tooltip for the whole app. It reads existing `title`
// attributes (no markup changes), and suppresses the native tooltip while ours
// is shown by blanking `title` on hover and restoring it on leave - so screen
// readers (which don't pointer-hover) keep the accessible name.

export function useTooltips(): void {
  useEffect(() => {
    const tip = document.createElement("div");
    tip.className = "tooltip";
    tip.setAttribute("role", "tooltip");
    document.body.appendChild(tip);

    let timer: number | undefined;
    let current: HTMLElement | null = null;
    let stashed: string | null = null;

    const hide = () => {
      clearTimeout(timer);
      tip.classList.remove("show");
      if (current && stashed !== null) current.title = stashed;
      current = null;
      stashed = null;
    };

    const show = (el: HTMLElement, text: string) => {
      tip.textContent = text;
      tip.classList.add("show");
      const r = el.getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      const left = Math.max(6, Math.min(r.left + r.width / 2 - t.width / 2, window.innerWidth - t.width - 6));
      const above = r.top - t.height - 7;
      tip.style.left = `${Math.round(left)}px`;
      tip.style.top = `${Math.round(above < 6 ? r.bottom + 7 : above)}px`;
    };

    const over = (e: PointerEvent) => {
      if (!(e.target instanceof Element)) return;
      const el = e.target.closest<HTMLElement>("[title]");
      if (!el || el === current) return;
      hide();
      const text = el.getAttribute("title");
      if (!text) return;
      current = el;
      stashed = text;
      el.title = ""; // suppress the native tooltip while ours is in play
      timer = window.setTimeout(() => show(el, text), 450);
    };

    const out = (e: PointerEvent) => {
      if (current && !(e.relatedTarget instanceof Node && current.contains(e.relatedTarget))) hide();
    };

    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("keydown", hide, true);
    return () => {
      hide();
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("keydown", hide, true);
      tip.remove();
    };
  }, []);
}
