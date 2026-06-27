import { createFixtureRepo } from "../fixtures/repo.js";

// RGB channels of --tab-blue in the dark theme (styles.css), matched as a
// substring so it holds for either `rgb(...)` or `rgba(...)` serialization. We
// pin the theme below so the hue is deterministic regardless of the CI host.
const BLUE = "110, 168, 254";

// Seed a persisted session + a tab color for the fixture repo, force the dark
// theme for a deterministic palette, then reload until the repo view has
// painted. Mirrors openFixtureRepo in virtualization.e2e.js; the async repo
// load occasionally stalls under CI load, so we retry the reload.
async function openColoredRepo(dir, color) {
  await browser.execute(
    (d, c) => {
      localStorage.setItem("gitchef.session", JSON.stringify({ paths: [d], activePath: d }));
      localStorage.setItem("gitchef.changesView", "list");
      localStorage.setItem("gitchef.theme", "dark");
      localStorage.setItem("gitchef.tabColors", JSON.stringify({ [d]: c }));
    },
    dir,
    color
  );

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await browser.execute(() => window.location.reload());
    await browser.pause(1500);
    try {
      await $(".change-list .file-row").waitForExist({ timeout: 30000 });
      await $(".commit-row:not(.wip-row)").waitForExist({ timeout: 30000 });
      await $(".tab[data-tab-color]").waitForExist({ timeout: 30000 });
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

describe("GitChef tab colors", () => {
  before(async () => {
    const repo = createFixtureRepo();
    await openColoredRepo(repo.dir, "blue");
  });

  it("restores the persisted color onto the active tab chip", async () => {
    const color = await browser.execute(
      () => document.querySelector(".tab[data-tab-color]")?.getAttribute("data-tab-color")
    );
    expect(color).toBe("blue");
  });

  it("paints the color as a top stripe (::before) in the active theme hue", async () => {
    const stripe = await browser.execute(() => {
      const el = document.querySelector(".tab[data-tab-color]");
      return getComputedStyle(el, "::before").backgroundColor;
    });
    expect(stripe).toContain(BLUE);
  });

  it("mirrors the color as a stripe on the open repo's header", async () => {
    const shadow = await browser.execute(() => {
      const el = document.querySelector(".repo-host[data-tab-color] .toolbar");
      return el ? getComputedStyle(el).boxShadow : "";
    });
    expect(shadow).toContain(BLUE);
  });
});
