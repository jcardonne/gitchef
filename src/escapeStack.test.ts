import { describe, it, expect } from "vitest";
import { createEscapeStack } from "./escapeStack";

describe("createEscapeStack", () => {
  it("only the most recently opened overlay is on top", () => {
    const s = createEscapeStack();
    const settings = {};
    const modal = {};
    s.push(settings);
    s.push(modal);
    expect(s.isTop(modal)).toBe(true);
    expect(s.isTop(settings)).toBe(false);
  });

  it("closing the top overlay hands Escape back to the one beneath", () => {
    const s = createEscapeStack();
    const a = {};
    const b = {};
    s.push(a);
    s.push(b);
    s.remove(b);
    expect(s.isTop(a)).toBe(true);
  });

  it("removing an unknown or already removed overlay is harmless", () => {
    const s = createEscapeStack();
    const a = {};
    s.push(a);
    s.remove({});
    s.remove(a);
    s.remove(a);
    expect(s.isTop(a)).toBe(false);
  });
});
