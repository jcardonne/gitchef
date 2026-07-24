import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { Image } from "@tauri-apps/api/image";
import { TAB_COLORS, type Tab, type TabColor } from "../types";
import * as api from "../api";
import { resolvedTheme } from "../theme";
import type { RecentRepo } from "../storage";

const appWindow = getCurrentWindow();
const isMac = navigator.platform.toLowerCase().includes("mac");

/// Parse a `#rrggbb` CSS color into an [r,g,b] triple, or null when unrecognized.
function parseHex(value: string): [number, number, number] | null {
  const m = value.trim().match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/// Memoized swatch builder: a right-click must not regenerate the same dot (or
/// re-allocate a native image resource for it) on every menu open. The hue
/// depends on the theme, so the cache is keyed by color + selected + theme.
const swatchCache = new Map<string, Promise<Image | undefined>>();

function colorSwatch(color: TabColor | null, selected: boolean): Promise<Image | undefined> {
  const key = `${color ?? "none"}:${selected ? 1 : 0}:${resolvedTheme()}`;
  let swatch = swatchCache.get(key);
  if (!swatch) {
    swatch = buildSwatch(color, selected);
    swatchCache.set(key, swatch);
  }
  return swatch;
}

/// Build a small RGBA dot icon for the Tab Color menu. The hue is read live from
/// the `--tab-<id>` CSS variable so it tracks the active theme; `selected` draws
/// an anti-aliased outer ring to mark the current choice, and a `null` color
/// renders a hollow "no color" ring (the None entry). Returns undefined if the
/// platform refuses to build the image, so the item degrades to text only.
async function buildSwatch(color: TabColor | null, selected: boolean): Promise<Image | undefined> {
  const size = 36;
  const center = (size - 1) / 2;
  const rFill = 10;
  const rRingInner = 12.5;
  const rRingOuter = 15.5;
  const css = getComputedStyle(document.documentElement);
  const fill = color ? parseHex(css.getPropertyValue(`--tab-${color}`)) : null;
  const ring = parseHex(css.getPropertyValue("--text")) ?? [201, 209, 217];
  const hollow = parseHex(css.getPropertyValue("--text-dim")) ?? [139, 148, 158];
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dist = Math.hypot(x - center, y - center);
      let rgb: [number, number, number] | null = null;
      let alpha = 0;
      if (fill) {
        alpha = clamp(rFill - dist + 0.5);
        if (alpha > 0) rgb = fill;
      } else {
        const a = clamp(dist - (rFill - 2) + 0.5) * clamp(rFill - dist + 0.5);
        if (a > 0) {
          rgb = hollow;
          alpha = a;
        }
      }
      if (selected) {
        const a = clamp(dist - rRingInner + 0.5) * clamp(rRingOuter - dist + 0.5);
        if (a > 0) {
          rgb = ring;
          alpha = a;
        }
      }
      if (rgb) {
        const i = (y * size + x) * 4;
        data[i] = rgb[0];
        data[i + 1] = rgb[1];
        data[i + 2] = rgb[2];
        data[i + 3] = Math.round(alpha * 255);
      }
    }
  }
  try {
    return await Image.new(data, size, size);
  } catch {
    return undefined;
  }
}

interface Props {
  tabs: Tab[];
  activePath: string | null; // null = Home
  onActivate: (path: string | null) => void;
  onClose: (path: string) => void;
  onReorder: (from: number, to: number) => void;
  onCloseOthers: (path: string) => void;
  onCloseToRight: (path: string) => void;
  onOpen: () => void;
  onClone: () => void;
  onOpenRecent: (path: string) => void;
  recents: RecentRepo[];
  onSetColor: (path: string, color: TabColor | null) => void;
  onOpenSettings: () => void;
}

/// GitKraken-style repo tabs: a persistent Home button, one chip per open repo
/// (draggable to reorder, ✕ to close), and a + to open another repository.
export default function TabBar({
  tabs,
  activePath,
  onActivate,
  onClose,
  onReorder,
  onCloseOthers,
  onCloseToRight,
  onOpen,
  onClone,
  onOpenRecent,
  recents,
  onSetColor,
  onOpenSettings,
}: Props) {

  // The + opens a small menu: recent repos, clone, or open a local folder.
  const showAddMenu = async () => {
    const recentItems = recents.length
      ? await Promise.all(
          recents.slice(0, 8).map((r) => MenuItem.new({ text: r.name, action: () => onOpenRecent(r.path) }))
        )
      : [await MenuItem.new({ text: "No recent repositories", enabled: false })];
    const items = await Promise.all([
      Submenu.new({ text: "Open recent", items: recentItems }),
      PredefinedMenuItem.new({ item: "Separator" }),
      MenuItem.new({ text: "Clone a repository…", action: onClone }),
      MenuItem.new({ text: "Open local repository…", action: onOpen }),
    ]);
    await (await Menu.new({ items })).popup();
  };
  // Reorder state. `dragging` = index of the tab being dragged (lifts/styles
  // the source); `dropIdx` = the slot it would land in, an insertion index in
  // 0..tabs.length so the gaps and the bar's end count as targets, not just
  // landing exactly on another tab.
  const [dragging, setDragging] = useState<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  // FLIP animation: tabs glide to their new positions after a reorder.
  // `tabEls` maps repo path -> DOM node; `flipFrom` holds each tab's screen
  // rect captured the instant before the reorder, so the layout effect can
  // invert the delta and transition it away.
  const tabEls = useRef<Map<string, HTMLDivElement>>(new Map());
  const flipFrom = useRef<Map<string, DOMRect>>(new Map());

  useLayoutEffect(() => {
    const from = flipFrom.current;
    if (from.size === 0) return; // only runs after a real reorder
    flipFrom.current = new Map();
    tabEls.current.forEach((el, path) => {
      const before = from.get(path);
      if (!before) return;
      const dx = before.left - el.getBoundingClientRect().left;
      if (!dx) return;
      el.style.transform = `translateX(${dx}px)`;
      void el.offsetWidth; // force reflow so the cleared transform animates
      el.classList.add("flipping");
      el.style.transform = "";
      const done = (ev: TransitionEvent) => {
        if (ev.propertyName !== "transform") return;
        el.classList.remove("flipping");
        el.removeEventListener("transitionend", done);
      };
      el.addEventListener("transitionend", done);
    });
  });

  // Live drag bookkeeping. Kept in a ref (not state) so pointer moves don't
  // each trigger a React render - the dragged tab is translated imperatively.
  const drag = useRef<{
    from: number;
    el: HTMLDivElement;
    startX: number;
    minDx: number; // clamp so the tab can't slide past the first/last slot,
    maxDx: number; // i.e. it stays inside the tab strip and never the window
    centers: number[]; // original tab midpoints, for the insertion slot
    step: number; // dragged tab's footprint (width + gap); how far neighbours part
    active: boolean; // true only once the pointer crosses the move threshold
    slot: number;
  } | null>(null);

  const onTabPointerDown = (e: ReactPointerEvent<HTMLDivElement>, i: number) => {
    if (e.button !== 0) return; // left button only; right opens the menu
    const el = e.currentTarget;
    const rects = tabs.map((t) => tabEls.current.get(t.path)!.getBoundingClientRect());
    const self = rects[i];
    // Gap between adjacent tabs (the flex `gap`), measured from a real neighbour.
    const gap =
      rects.length < 2 ? 0 : i < rects.length - 1 ? rects[i + 1].left - rects[i].right : rects[i].left - rects[i - 1].right;
    el.setPointerCapture(e.pointerId); // keep receiving moves even off-window
    drag.current = {
      from: i,
      el,
      startX: e.clientX,
      minDx: rects[0].left - self.left,
      maxDx: rects[rects.length - 1].right - self.right,
      centers: rects.map((r) => r.left + r.width / 2),
      step: self.width + gap,
      active: false,
      slot: i,
    };
  };

  const onTabPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const raw = e.clientX - d.startX;
    if (!d.active) {
      if (Math.abs(raw) < 4) return; // tolerate jitter so a click stays a click
      d.active = true;
      setDragging(d.from);
    }
    // Move the real element, clamped to the strip - this is what keeps the tab
    // in the bar instead of floating off as an OS drag image.
    d.el.style.transform = `translateX(${Math.max(d.minDx, Math.min(d.maxDx, raw))}px)`;
    let slot = tabs.length;
    for (let k = 0; k < d.centers.length; k++) {
      if (e.clientX < d.centers[k]) {
        slot = k;
        break;
      }
    }
    if (slot !== d.slot) {
      d.slot = slot;
      setDropIdx(slot);
    }
  };

  const onTabPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (d.el.hasPointerCapture(e.pointerId)) d.el.releasePointerCapture(e.pointerId);
    drag.current = null;
    if (d.active) commitDrop(d);
    else onActivate(tabs[d.from].path); // no real drag -> treat as a click
    setDragging(null);
    setDropIdx(null);
  };

  const onTabPointerCancel = () => {
    const d = drag.current;
    if (!d) return;
    d.el.style.transform = "";
    drag.current = null;
    setDragging(null);
    setDropIdx(null);
  };

  const commitDrop = (d: { from: number; el: HTMLDivElement; slot: number }) => {
    // slot indexes the original array; once the dragged tab is spliced out,
    // every slot after it shifts left by one.
    const to = d.slot > d.from ? d.slot - 1 : d.slot;
    // Arm the FLIP: capture rects now, while the dragged tab still carries its
    // drop-position transform, so it glides from where it was dropped.
    const rects = new Map<string, DOMRect>();
    tabEls.current.forEach((el, path) => rects.set(path, el.getBoundingClientRect()));
    flipFrom.current = rects;
    d.el.style.transform = ""; // hand the offset over to the FLIP animation
    if (to !== d.from) onReorder(d.from, to);
  };

  // How far tab `j` should slide to open a gap for the dragged tab. Every tab
  // between the source and the current target shifts by one footprint toward
  // the source; tabs outside that range stay put.
  const neighborShift = (j: number): number => {
    const d = drag.current;
    if (d === null || dropIdx === null || !d.active || j === d.from) return 0;
    const to = dropIdx > d.from ? dropIdx - 1 : dropIdx;
    if (to > d.from) return j > d.from && j <= to ? -d.step : 0; // dragged right
    if (to < d.from) return j >= to && j < d.from ? d.step : 0; // dragged left
    return 0;
  };

  const showTabMenu = async (t: Tab, i: number) => {
    const items = await Promise.all([
      MenuItem.new({ text: "Close Tab", action: () => onClose(t.path) }),
      MenuItem.new({ text: "Close Others", enabled: tabs.length > 1, action: () => onCloseOthers(t.path) }),
      MenuItem.new({
        text: "Close to the Right",
        enabled: i < tabs.length - 1,
        action: () => onCloseToRight(t.path),
      }),
      PredefinedMenuItem.new({ item: "Separator" }),
      Submenu.new({
        text: "Tab Color",
        items: await Promise.all([
          ...TAB_COLORS.map(async (c) =>
            IconMenuItem.new({
              text: c.label,
              icon: await colorSwatch(c.id, t.color === c.id),
              action: () => onSetColor(t.path, c.id),
            })
          ),
          PredefinedMenuItem.new({ item: "Separator" }),
          IconMenuItem.new({
            text: "None",
            icon: await colorSwatch(null, !t.color),
            action: () => onSetColor(t.path, null),
          }),
        ]),
      }),
      PredefinedMenuItem.new({ item: "Separator" }),
      MenuItem.new({ text: "Copy Repo Path", action: () => void api.copyText(t.path).catch(console.error) }),
      MenuItem.new({ text: "Reveal in Finder", action: () => void api.revealPath(t.path).catch(console.error) }),
      MenuItem.new({ text: "Open in Terminal", action: () => void api.openTerminal(t.path).catch(console.error) }),
    ]);
    await (await Menu.new({ items })).popup();
  };

  return (
    <div className={`tabbar${isMac ? " platform-mac" : " platform-windows"}`}>
      {isMac && <WindowControls platform="mac" />}
      <div className="tabbar-brand">
        <img className="brand-mark" src="/logo.png" alt="" /> GitChef
      </div>

      <button
        className={`home-btn${activePath === null ? " active" : ""}`}
        onClick={() => onActivate(null)}
        title="Home"
        aria-label="Home"
        aria-current={activePath === null ? "page" : undefined}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M3 10.5 12 3l9 7.5" />
          <path d="M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5" />
          <path d="M9.5 21v-6h5v6" />
        </svg>
      </button>

      <div className="tabbar-sep" aria-hidden="true" />

      {tabs.map((t, i) => (
        <div
          key={t.path}
          ref={(el) => {
            if (el) tabEls.current.set(t.path, el);
            else tabEls.current.delete(t.path);
          }}
          className={
            `tab${t.path === activePath ? " active" : ""}` +
            `${dragging === i ? " dragging" : ""}` +
            // Neighbours animate as they part to open the landing gap.
            `${dragging !== null && dragging !== i ? " shifting" : ""}`
          }
          // Dragged tab is moved imperatively (lag-free); neighbours are shifted
          // here via React so they slide to make room.
          style={dragging !== null && dragging !== i ? { transform: `translateX(${neighborShift(i)}px)` } : undefined}
          data-tab-color={t.color}
          onPointerDown={(e) => onTabPointerDown(e, i)}
          onPointerMove={onTabPointerMove}
          onPointerUp={onTabPointerUp}
          onPointerCancel={onTabPointerCancel}
          onContextMenu={(e) => {
            e.preventDefault();
            void showTabMenu(t, i);
          }}
          title={t.path}
        >
          <span className="tab-name">{t.name}</span>
          <button
            type="button"
            className="tab-close"
            aria-label="Close tab"
            // Swallow pointerdown so clicking ✕ never arms a drag.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onClose(t.path);
            }}
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
        </div>
      ))}

      <div className="tab-add" onClick={() => void showAddMenu()} title="Open or clone a repository">
        +
      </div>

      <div
        className="tabbar-drag-region"
        onMouseDown={(e) => {
          if (e.button === 0) void appWindow.startDragging();
        }}
        onDoubleClick={() => void appWindow.toggleMaximize()}
      />

      <button
        className="settings-btn"
        onClick={onOpenSettings}
        title="Settings (Cmd/Ctrl+,)"
        aria-label="Settings"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {!isMac && <WindowControls platform="windows" />}
    </div>
  );
}

function WindowControls({ platform }: { platform: "mac" | "windows" }) {
  return (
    <div className={`window-controls ${platform}`}>
      <button
        className="window-control close"
        onClick={() => void appWindow.close()}
        title="Close"
        aria-label="Close"
      >
        {platform === "windows" && (
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 2l6 6M8 2 2 8" />
          </svg>
        )}
      </button>
      <button
        className="window-control minimize"
        onClick={() => void appWindow.minimize()}
        title="Minimize"
        aria-label="Minimize"
      >
        {platform === "windows" && (
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 5h6" />
          </svg>
        )}
      </button>
      <button
        className="window-control maximize"
        onClick={() => void appWindow.toggleMaximize()}
        title="Maximize"
        aria-label="Maximize"
      >
        {platform === "windows" && (
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2.5 2.5h5v5h-5z" />
          </svg>
        )}
      </button>
    </div>
  );
}
