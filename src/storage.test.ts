import { describe, it, expect } from "vitest";
import * as store from "./storage";

describe("basename", () => {
  it("returns the last segment of a path", () => {
    expect(store.basename("/Users/me/projects/gitchef")).toBe("gitchef");
  });
  it("ignores trailing separators", () => {
    expect(store.basename("/Users/me/repo/")).toBe("repo");
    expect(store.basename("/Users/me/repo///")).toBe("repo");
  });
  it("handles Windows backslash paths", () => {
    expect(store.basename("C:\\Users\\me\\repo")).toBe("repo");
    expect(store.basename("C:\\Users\\me\\repo\\")).toBe("repo");
  });
  it("falls back to the whole string when there is no segment", () => {
    expect(store.basename("/")).toBe("/");
  });
});

describe("recents", () => {
  it("orders most-recent first and dedupes by path", () => {
    store.addRecent({ path: "/a", name: "a" });
    store.addRecent({ path: "/b", name: "b" });
    store.addRecent({ path: "/a", name: "a-renamed" }); // re-open /a

    const recents = store.getRecents();
    expect(recents.map((r) => r.path)).toEqual(["/a", "/b"]); // /a back on top, no duplicate
    expect(recents[0].name).toBe("a-renamed"); // latest metadata wins
  });

  it("caps the list and drops the oldest entries", () => {
    for (let i = 0; i < 25; i++) store.addRecent({ path: `/p${i}`, name: `p${i}` });
    const recents = store.getRecents();

    expect(recents.length).toBeLessThan(25); // capped
    expect(recents[0].path).toBe("/p24"); // newest kept, front
    expect(recents.some((r) => r.path === "/p0")).toBe(false); // oldest evicted
  });

  it("removeRecent drops a single entry", () => {
    store.addRecent({ path: "/a", name: "a" });
    store.addRecent({ path: "/b", name: "b" });
    store.removeRecent("/a");
    expect(store.getRecents().map((r) => r.path)).toEqual(["/b"]);
  });
});

describe("read fallback", () => {
  it("returns the fallback instead of throwing on corrupt JSON", () => {
    localStorage.setItem("gitchef.recents", "{ not valid json");
    expect(store.getRecents()).toEqual([]);
  });
});

describe("graph column visibility merge", () => {
  it("overlays stored values on defaults so newer keys are never undefined", () => {
    // An older session that only persisted some columns (missing the rest).
    localStorage.setItem("gitchef.graphColumnVisibility", JSON.stringify({ message: false }));
    const v = store.getGraphColumnVisibility();

    expect(v.message).toBe(false); // stored override is respected
    // Keys absent from storage are filled from defaults, not left undefined.
    for (const key of ["graph", "author", "sha", "date"] as const) {
      expect(typeof v[key]).toBe("boolean");
    }
  });
});

describe("persistence round-trips", () => {
  it("changes-view round-trips and normalizes unknown values to tree", () => {
    store.setChangesView("list");
    expect(store.getChangesView()).toBe("list");
    localStorage.setItem("gitchef.changesView", "garbage");
    expect(store.getChangesView()).toBe("tree");
  });

  it("encodes sort direction as 1/0", () => {
    store.setSortAsc(true);
    expect(store.getSortAsc()).toBe(true);
    store.setSortAsc(false);
    expect(store.getSortAsc()).toBe(false);
  });

  it("persists the right-panel width", () => {
    store.setRightPanelWidth(612);
    expect(store.getRightPanelWidth()).toBe(612);
  });

  it("round-trips the open-tab session", () => {
    store.saveSession({ paths: ["/x", "/y"], activePath: "/y" });
    expect(store.getSession()).toEqual({ paths: ["/x", "/y"], activePath: "/y" });
  });
});
