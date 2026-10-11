import { describe, it, expect } from "vitest";
import { nextZoom, parseZoom, zoomAction, zoomLabel, ZOOM_STEPS } from "./zoom";

const key = (k: string, extra: Record<string, unknown> = {}) => ({ key: k, code: "", metaKey: true, ctrlKey: false, altKey: false, ...extra });

describe("nextZoom", () => {
  it("steps up and down through the fixed steps", () => {
    expect(nextZoom(1, 1)).toBe(1.1);
    expect(nextZoom(1, -1)).toBe(0.9);
  });

  it("clamps at both ends", () => {
    expect(nextZoom(2, 1)).toBe(2);
    expect(nextZoom(0.7, -1)).toBe(0.7);
  });

  it("moves an off-step value to the nearest step in that direction", () => {
    expect(nextZoom(1.05, 1)).toBe(1.1);
    expect(nextZoom(1.05, -1)).toBe(1);
  });

  it("ends up on a listed step", () => {
    expect(ZOOM_STEPS).toContain(nextZoom(1.3, 1));
  });
});

describe("parseZoom", () => {
  it("falls back to 1 for missing, garbage or out-of-range values", () => {
    expect(parseZoom(null)).toBe(1);
    expect(parseZoom("abc")).toBe(1);
    expect(parseZoom("5")).toBe(1);
    expect(parseZoom("0.1")).toBe(1);
  });

  it("keeps a valid stored value", () => {
    expect(parseZoom("1.2")).toBe(1.2);
  });
});

describe("zoomAction", () => {
  it("recognizes in, out and reset with Cmd or Ctrl", () => {
    expect(zoomAction(key("="))).toBe("in");
    expect(zoomAction(key("+", { metaKey: false, ctrlKey: true }))).toBe("in");
    expect(zoomAction(key("-"))).toBe("out");
    expect(zoomAction(key("0"))).toBe("reset");
  });

  it("accepts the numpad keys", () => {
    expect(zoomAction(key("Add", { code: "NumpadAdd" }))).toBe("in");
    expect(zoomAction(key("Subtract", { code: "NumpadSubtract" }))).toBe("out");
  });

  it("ignores plain keys and Alt combos", () => {
    expect(zoomAction(key("=", { metaKey: false }))).toBeNull();
    expect(zoomAction(key("=", { altKey: true }))).toBeNull();
    expect(zoomAction(key("a"))).toBeNull();
  });
});

describe("zoomLabel", () => {
  it("shows the percentage", () => {
    expect(zoomLabel(1.2)).toBe("Zoom 120%");
  });

  it("marks the default and both limits so a no-op keypress still explains itself", () => {
    expect(zoomLabel(1)).toBe("Zoom 100% (default)");
    expect(zoomLabel(2)).toBe("Zoom 200% (maximum)");
    expect(zoomLabel(0.7)).toBe("Zoom 70% (minimum)");
  });
});
