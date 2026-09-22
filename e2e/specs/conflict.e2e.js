import { createConflictRepo } from "../fixtures/repo.js";

// Open a repo that is already paused mid-rebase (one conflicted file) and drive
// the full resolution flow through the UI: banner -> per-block pick -> mark
// resolved -> continue. The conflict is set up with real git in the fixture
// because the rebase trigger lives in a native context menu the webview can't
// click; everything AFTER the pause is what this feature owns and is tested here.
async function openRepo(dir) {
  await browser.execute((d) => {
    localStorage.setItem("gitchef.session", JSON.stringify({ paths: [d], activePath: d }));
    localStorage.setItem("gitchef.changesView", "list");
  }, dir);

  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await browser.execute(() => window.location.reload());
    await browser.pause(1500);
    try {
      await $(".change-list .file-row").waitForExist({ timeout: 30000 });
      // The banner belongs to a COMPLETE load of this fixture (it is always
      // paused mid-rebase), so wait for it here, inside the retry. Waiting in
      // the first it() instead meant a launch that painted the file list but not
      // yet the banner failed the whole spec rather than retrying the reload -
      // and now that the release is gated on ci, an e2e flake silently blocks
      // the release itself.
      await $(".seq-banner").waitForExist({ timeout: 20000 });
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

describe("GitChef conflict resolution", () => {
  before(async () => {
    const repo = createConflictRepo();
    await openRepo(repo.dir);
  });

  it("shows the sequencer banner with a conflict to resolve", async () => {
    // openRepo already waited for the banner to exist; what this owns is its
    // STATE - paused with conflicts, so it's blocking and Continue is disabled
    // until the file is resolved.
    await expect($(".seq-banner.has-conflicts")).toExist();
    const cont = await $(".seq-banner .mini-btn.primary");
    await expect(cont).toHaveAttribute("disabled");
  });

  it("opens the conflict resolver for the conflicted file", async () => {
    // Click the conflicted file in the change list to preview it. The fixture has
    // exactly one conflicted file (file.txt at repo root) and tree-view folders are
    // .tree-folder, so the single .file-row is it (matches the beforeEach wait).
    const row = await $(".change-list .file-row");
    await row.waitForClickable({ timeout: 15000 });
    await row.click();
    await browser.pause(2000);
    const diag = await browser.execute(() => {
      const el = document.querySelector(".change-list .file-row");
      return {
        rowClass: el?.className,
        centerHTML: document.querySelector(".center")?.innerHTML?.slice(0, 600),
        hasConflictBlock: !!document.querySelector(".conflict-block"),
        activeTab: document.querySelector(".tab.active")?.textContent,
        bodyText: document.body.innerText?.slice(0, 400),
      };
    });
    console.error("DEBUG_DIAGNOSTIC:", JSON.stringify(diag));

    if (!diag.hasConflictBlock) {
      await browser.execute(() => {
        const el = document.querySelector(".change-list .file-row");
        if (el) {
          el.focus();
          el.click();
        }
      });
      await browser.keys(["Enter"]);
    }

    await $(".conflict-block").waitForExist({ timeout: 20000 });
    // ours + theirs sides both rendered.
    await expect($(".conflict-head.ours")).toExist();
    await expect($(".conflict-head.theirs")).toExist();
  });

  it("resolves the conflict and enables Continue", async () => {
    // Accept incoming (theirs) for the only block, then mark resolved.
    await $(".conflict-actions .mini-btn").waitForExist({ timeout: 20000 });
    const accept = await $$(".conflict-actions .mini-btn").find(
      async (b) => (await b.getText()) === "Accept incoming"
    );
    await accept.click();
    const markResolved = await $$(".conflict-bar .mini-btn").find(
      async (b) => (await b.getText()) === "Mark resolved"
    );
    await markResolved.waitForClickable({ timeout: 15000 });
    await markResolved.click();

    // Once the last conflict is staged, the banner drops its blocking state and
    // Continue becomes clickable.
    await browser.waitUntil(
      async () => !(await $(".seq-banner.has-conflicts").isExisting()),
      { timeout: 15000, timeoutMsg: "banner stayed blocked after resolving the conflict" }
    );
    await expect($(".seq-banner .mini-btn.primary")).not.toHaveAttribute("disabled");
  });

  it("finishes the rebase on Continue", async () => {
    const cont = await $(".seq-banner .mini-btn.primary");
    await cont.waitForClickable({ timeout: 15000 });
    await cont.click();
    // Rebase completes -> no operation in progress -> banner gone.
    await browser.waitUntil(async () => !(await $(".seq-banner").isExisting()), {
      timeout: 20000,
      timeoutMsg: "sequencer banner never cleared after continuing the rebase",
    });
  });
});

