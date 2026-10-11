import { useEffect } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/// App-wide focus management for every `[role="dialog"][aria-modal="true"]`:
/// moves focus into a dialog when it opens (unless something inside already has
/// it, e.g. an autofocused input), keeps Tab / Shift+Tab inside the topmost one,
/// and returns focus to the element that opened it once it closes. One observer
/// here replaces per-modal wiring, so new dialogs get it by declaring the role.
export function useModalFocus() {
  useEffect(() => {
    const stack: { el: HTMLElement; prev: HTMLElement | null }[] = [];

    // The element that had focus before any dialog opened. Read live at scan time
    // it would already be the dialog's autofocused input (React focuses it during
    // the same commit, before the observer runs), so track it as focus and clicks
    // happen. mousedown is tracked too because WebKit does not focus buttons on click.
    let lastOutside: HTMLElement | null = null;
    const inDialog = (el: Element | null) => !!el?.closest('[role="dialog"][aria-modal="true"]');
    const remember = (el: Element | null) => {
      if (el instanceof HTMLElement && !inDialog(el) && el !== document.body) lastOutside = el;
    };
    const onFocusIn = (e: FocusEvent) => remember(e.target as Element | null);
    const onMouseDown = (e: MouseEvent) => remember((e.target as Element | null)?.closest(FOCUSABLE) ?? null);

    const focusables = (root: HTMLElement) =>
      Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((e) => e.getClientRects().length > 0);

    const scan = () => {
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'));
      for (const d of dialogs) {
        if (stack.some((s) => s.el === d)) continue;
        stack.push({ el: d, prev: lastOutside });
        if (!d.contains(document.activeElement)) {
          if (!d.hasAttribute("tabindex")) d.setAttribute("tabindex", "-1");
          (focusables(d)[0] ?? d).focus();
        }
      }
      for (let i = stack.length - 1; i >= 0; i--) {
        if (dialogs.includes(stack[i].el)) continue;
        const [gone] = stack.splice(i, 1);
        // Only hand focus back once no dialog is left; when one dialog replaces
        // another in the same pass, focus belongs to the new one.
        if (stack.length > 0) continue;
        if (gone.prev?.isConnected) gone.prev.focus();
        else document.querySelector<HTMLElement>(".graph, .staging")?.focus();
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || stack.length === 0) return;
      const top = stack[stack.length - 1].el;
      const items = focusables(top);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!active || !top.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("mousedown", onMouseDown, true);
    remember(document.activeElement);
    scan();
    return () => {
      observer.disconnect();
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("mousedown", onMouseDown, true);
    };
  }, []);
}
