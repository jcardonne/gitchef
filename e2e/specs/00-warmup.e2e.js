import { createFixtureRepo } from "../fixtures/repo.js";

// The FIRST webdriver session in a CI job is cold: the OS page cache hasn't
// loaded the (large, debug) binary + WebKit libs and libgit2's first walk is
// cold, so the very first repo-open can take far longer than a warm one and
// blow the real specs' timeouts (observed: the alphabetically-first heavy spec
// reliably failed its repo-open while later ones passed in seconds).
//
// This throwaway spec runs first (the "00-" prefix sorts it ahead of the rest)
// and absorbs that cost. It MUST use the same heavy fixture as the real specs:
// a tiny repo warms the binary/WebKit load but not the heavy commit-graph walk,
// which is exactly the path that stalls. It never fails the suite - warming is
// the point, not the assertion - and a partial warmup still helps what follows.
describe("warmup", () => {
  it("opens a heavy repo once to warm the OS/libgit2/render caches", async () => {
    const repo = createFixtureRepo({ commits: 300, files: 600 });
    await browser.execute((d) => {
      localStorage.setItem(
        "gitchef.session",
        JSON.stringify({ paths: [d], activePath: d })
      );
      localStorage.setItem("gitchef.changesView", "list");
    }, repo.dir);

    for (let attempt = 1; attempt <= 4; attempt++) {
      await browser.execute(() => window.location.reload());
      await browser.pause(2000);
      try {
        await $(".commit-row:not(.wip-row)").waitForExist({ timeout: 45000 });
        break;
      } catch {
        // keep retrying; even a failed load has warmed caches for later specs
      }
    }
    expect(true).toBe(true);
  });
});
