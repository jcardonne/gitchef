import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// Progress reported to the UI while an update is being applied. `null` means
// "nothing happening" (no update, or finished/failed) - the toast hides.
export type UpdateStatus =
  | { phase: "downloading"; version: string; pct: number | null }
  | { phase: "installing"; version: string };

// Shared by the silent and manual flows: download, report progress, install,
// relaunch. Never swallows errors itself - callers decide what "failed" means
// for their own UI.
async function applyUpdate(update: Update, onStatus: (status: UpdateStatus | null) => void): Promise<void> {
  const version = update.version;
  let total = 0;
  let received = 0;

  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? 0;
        onStatus({ phase: "downloading", version, pct: total ? 0 : null });
        break;
      case "Progress":
        received += event.data.chunkLength;
        onStatus({
          phase: "downloading",
          version,
          pct: total ? Math.min(100, Math.round((received / total) * 100)) : null,
        });
        break;
      case "Finished":
        onStatus({ phase: "installing", version });
        break;
    }
  });

  // Relaunch tears down the page; no need to clear the toast first.
  await relaunch();
}

// Silent auto-update. On launch we ask Cloudflare for the latest manifest; if a
// newer signed build exists we download + install it in the background, then
// relaunch into the new version. Every failure path (offline, bad endpoint,
// signature mismatch) is swallowed so a missed update never blocks the app.
//
// `onStatus` drives an optional unobtrusive toast; it is always called with
// `null` once the flow settles (so the toast can hide), except when a relaunch
// is imminent and tears the page down anyway.
//
// Guarded to production: `tauri dev` ships no updater artifacts and points at a
// placeholder endpoint, so checking there would only ever error.
let started = false;

export async function runSilentUpdate(
  onStatus: (status: UpdateStatus | null) => void = () => {}
): Promise<void> {
  if (!import.meta.env.PROD || started) return;
  started = true;

  try {
    const update = await check();
    if (!update) return;
    await applyUpdate(update, onStatus);
  } catch (err) {
    // Non-fatal: log for the dev console, keep running the current version.
    console.warn("auto-update skipped:", err);
    onStatus(null);
  }
}

// User-initiated check, from Settings > About. Unlike runSilentUpdate this has
// no single-flight guard (each click is a fresh check) and never swallows the
// result - the caller renders "up to date" / "update available" / an error
// instead of the update just silently not happening.
export type ManualCheckResult =
  | { state: "unsupported" } // dev build: no updater artifacts, no real endpoint
  | { state: "up-to-date" }
  | { state: "available"; version: string; install: () => Promise<void> }
  | { state: "error" };

export async function checkForUpdates(
  onStatus: (status: UpdateStatus | null) => void = () => {}
): Promise<ManualCheckResult> {
  if (!import.meta.env.PROD) return { state: "unsupported" };

  try {
    const update = await check();
    if (!update) return { state: "up-to-date" };
    return {
      state: "available",
      version: update.version,
      install: () => applyUpdate(update, onStatus),
    };
  } catch (err) {
    console.warn("update check failed:", err);
    return { state: "error" };
  }
}
