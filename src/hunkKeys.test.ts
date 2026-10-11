import { describe, it, expect } from "vitest";
import { hunkKeyAction } from "./hunkKeys";

describe("hunkKeyAction", () => {
  it("moves between hunks and clamps at the ends", () => {
    expect(hunkKeyAction("]", 0, 3, false)).toEqual({ type: "jump", to: 1 });
    expect(hunkKeyAction("n", 2, 3, false)).toEqual({ type: "jump", to: 2 });
    expect(hunkKeyAction("[", 0, 3, false)).toEqual({ type: "jump", to: 0 });
    expect(hunkKeyAction("p", 2, 3, false)).toEqual({ type: "jump", to: 1 });
  });

  it("stages on an unstaged diff and unstages on a staged one", () => {
    expect(hunkKeyAction("s", 0, 1, false)).toEqual({ type: "act", action: "stage" });
    expect(hunkKeyAction("s", 0, 1, true)).toEqual({ type: "act", action: "unstage" });
  });

  it("only discards on an unstaged diff", () => {
    expect(hunkKeyAction("d", 0, 1, false)).toEqual({ type: "act", action: "discard" });
    expect(hunkKeyAction("d", 0, 1, true)).toBeNull();
  });

  it("ignores other keys", () => {
    expect(hunkKeyAction("x", 0, 1, false)).toBeNull();
    expect(hunkKeyAction("Enter", 0, 1, false)).toBeNull();
  });
});
