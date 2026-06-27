import { createFixtureRepo } from "../fixtures/repo.js";

// The FIRST webdriver session in a CI job is cold: the OS page cache hasn't
// loaded the (large, debug) binary + WebKit libs and libgit2's first walk is
// cold, so the very first repo-open can take far longer than a warm one and
// blow the real specs' timeouts (observed: the alphabetically-first spec
// reliably failed its repo-open while later specs passed in seconds).
//
// This throwaway spec runs first (the "00-" prefix sorts it ahead of the rest)
// and absorbs that cost on a tiny repo, so OS/libgit2 caches are warm by the
// time the real specs launch. It never fails the suite - warming is the point,
// not the assertion - and a partial warmup still helps the specs that follow.
describe("warmup", () => {
  it("opens a tiny repo once to warm OS/libgit2 caches", async () => {
    const repo = createFixtureRepo({ commits: 5, files: 3 });
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
