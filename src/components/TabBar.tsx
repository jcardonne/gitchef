import { useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import { Image } from "@tauri-apps/api/image";
import { TAB_COLORS, type Tab, type TabColor } from "../types";
import * as api from "../api";
import { getTheme, nextTheme, resolvedTheme, setTheme, type Theme } from "../theme";

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

/// Monochrome SVG theme icons (no emoji). `currentColor` -> follows text color.
function ThemeIcon({ theme }: { theme: Theme }) {
  const svg = {
    width: 15,
    height: 15,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;
  if (theme === "light") {
    return (
      <svg {...svg}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  if (theme === "dark") {
    return (
      <svg {...svg}>
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
    );
  }
  return (
    <svg {...svg}>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
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
  onSetColor: (path: string, color: TabColor | null) => void;
}

/// GitKraken-style repo tabs: a persistent Home tab, one chip per open repo
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
  onSetColor,
}: Props) {
  const dragFrom = useRef<number | null>(null);
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const cycleTheme = () => {
    const next = nextTheme(theme);
    setTheme(next);
    setThemeState(next);
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

      <div
        className="theme-btn"
        onClick={cycleTheme}
        title={`Theme: ${theme} (click to cycle light / dark / system)`}
      >
        <ThemeIcon theme={theme} />
      </div>

      <div
        className={`tab home${activePath === null ? " active" : ""}`}
        onClick={() => onActivate(null)}
        title="Home"
      >
        ⌂
      </div>

      {tabs.map((t, i) => (
        <div
          key={t.path}
          className={`tab${t.path === activePath ? " active" : ""}`}
          data-tab-color={t.color}
          draggable
          onDragStart={() => (dragFrom.current = i)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => {
            if (dragFrom.current !== null && dragFrom.current !== i) {
              onReorder(dragFrom.current, i);
            }
            dragFrom.current = null;
          }}
          onClick={() => onActivate(t.path)}
          onContextMenu={(e) => {
            e.preventDefault();
            void showTabMenu(t, i);
          }}
          title={t.path}
        >
          <span className="tab-name">{t.name}</span>
          <span
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation();
              onClose(t.path);
            }}
          >
            ✕
          </span>
        </div>
      ))}

      <div className="tab-add" onClick={onOpen} title="Open a repository">
        +
      </div>

      <div
        className="tabbar-drag-region"
        onMouseDown={(e) => {
          if (e.button === 0) void appWindow.startDragging();
        }}
        onDoubleClick={() => void appWindow.toggleMaximize()}
      />

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
