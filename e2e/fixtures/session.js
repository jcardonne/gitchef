// Restore the app straight into `dir` (no native folder picker) and wait for
// `ready`. The seed and the reload run in ONE script, re-seeded on every
// attempt: seeded separately, the app's own session-save effect (App.tsx) could
// write the previous spec's repo back first, so every reload - retries included -
// restored the wrong repo. The activePath check makes a wrong restore retry
// instead of passing on another repo's look-alike rows.
export async function openSession(dir, ready, extra = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await browser.execute(
      (d, kv) => {
        localStorage.setItem("gitchef.session", JSON.stringify({ paths: [d], activePath: d }));
        localStorage.setItem("gitchef.changesView", "list");
        for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
        window.location.reload();
      },
      dir,
      extra
    );
    await browser.pause(1500);
    try {
      await browser.waitUntil(
        async () =>
          (await browser.execute(
            () => JSON.parse(localStorage.getItem("gitchef.session") || "{}").activePath
          )) === dir,
        { timeout: 10000, timeoutMsg: `app restored a different repo than ${dir}` }
      );
      await ready();
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}
