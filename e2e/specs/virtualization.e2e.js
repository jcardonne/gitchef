import { createFixtureRepo } from "../fixtures/repo.js";

const COMMITS = 300;
const FILES = 600;
const GRAPH_ROW_H = 48; // must match ROW_H in GraphView.tsx
const CHANGE_ROW_H = 24; // must match ROW_H in ChangeList.tsx
// Far more rows than fit in the 820px window even with overscan, so a windowed
// list must mount well under this many at once.
const WINDOW_MAX = 160;

// Read from the webview: the commit summaries / file paths actually mounted.
const summaries = () =>
  browser.execute(() =>
    [...document.querySelectorAll(".graph-rows .commit-row .commit-summary")].map(
      (e) => e.textContent
    )
  );
const filePaths = () =>
  browser.execute(() =>
    [...document.querySelectorAll(".change-list .file-row .file-path")].map(
      (e) => e.textContent
    )
  );
const scrollToBottom = (selector) =>
  browser.execute((sel) => {
    const el =
      sel === ".change-list"
        ? document.querySelector(".file-row")?.closest(".change-list")
        : document.querySelector(sel);
    if (el) el.scrollTop = el.scrollHeight;
  }, selector);

describe("GitChef virtualization", () => {
  before(async () => {
    const repo = createFixtureRepo({ commits: COMMITS, files: FILES });
    // Seed the persisted session so launch restores straight into the repo (no
    // native folder picker), and pin list view for a flat change window.
    await browser.execute((dir) => {
      localStorage.setItem(
        "gitchef.session",
        JSON.stringify({ paths: [dir], activePath: dir })
      );
      localStorage.setItem("gitchef.changesView", "list");
    }, repo.dir);
    await browser.execute(() => window.location.reload());
    await browser.pause(1500);

    // Change list + at least the WIP row are quick; the commit history (a real
    // .commit-row that isn't the WIP node) resolves after the status paint.
    await $(".change-list .file-row").waitForExist({ timeout: 90000 });
    await $(".commit-row").waitForExist({ timeout: 90000 });
    await $(".commit-row:not(.wip-row)").waitForExist({ timeout: 90000 });
  });

  it("restores the fixture repo on launch", async () => {
    expect((await summaries()).length).toBeGreaterThan(0);
    expect((await filePaths()).length).toBeGreaterThan(0);
    await expect($(".commit-row.wip-row")).toExist(); // uncommitted files detected
  });

  it("keeps the full graph scroll height while mounting only a window", async () => {
    const svgHeight = await browser.execute(() =>
      Number(document.querySelector(".graph-svg").getAttribute("height"))
    );
    // ~302 rows tall (root + 300 commits + WIP), well beyond what's mounted.
    expect(svgHeight).toBeGreaterThan(200 * GRAPH_ROW_H);

    const rendered = (await summaries()).length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(WINDOW_MAX); // only a window is mounted, not 300+
  });

  it("windows commit rows and culls the top after scrolling down", async () => {
    const before = await summaries();
    expect(before.length).toBeLessThan(WINDOW_MAX);
    expect(before).toContain("Uncommitted changes"); // WIP row sits at the top

    await scrollToBottom(".center-graph");
    // The top (WIP) row must leave the DOM once it scrolls out of the window.
    await browser.waitUntil(
      async () => !(await summaries()).includes("Uncommitted changes"),
      { timeout: 10000, timeoutMsg: "top (WIP) row never culled after scrolling down" }
    );
    const after = await summaries();
    expect(after.length).toBeGreaterThan(0);
    expect(after.length).toBeLessThan(WINDOW_MAX);
    expect(after.some((s) => !before.includes(s))).toBe(true); // new rows windowed in
  });

  it("windows change rows and brings in new rows on scroll", async () => {
    const scrollH = await browser.execute(
      () => document.querySelector(".file-row").closest(".change-list").scrollHeight
    );
    // Near the full virtual height for every file, not just the mounted window.
    expect(scrollH).toBeGreaterThan(FILES * CHANGE_ROW_H * 0.8);

    const before = await filePaths();
    expect(before.length).toBeGreaterThan(0);
    expect(before.length).toBeLessThan(WINDOW_MAX);

    await scrollToBottom(".change-list");
    // Scrolling the windowed list must mount rows that weren't there before.
    await browser.waitUntil(
      async () => (await filePaths()).some((p) => !before.includes(p)),
      { timeout: 10000, timeoutMsg: "change list never windowed in new rows on scroll" }
    );
    const after = await filePaths();
    expect(after.length).toBeLessThan(WINDOW_MAX);
  });
});
