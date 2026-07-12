//! Filesystem watching for open repos. Watching the `.git` dir lets the UI react
//! the instant git state changes underneath it - a commit/checkout/stash from the
//! terminal, a rebase by another tool, a branch deleted by a script - without the
//! user hitting refresh. It is purely local: no network, so it never touches a
//! remote or a rate limit. Remote changes still need an explicit/auto fetch.
//!
//! We watch the git dir, NOT the working tree: refs/HEAD/index there are the
//! high-signal, low-noise surface (a whole `node_modules` under the workdir would
//! be the opposite). Working-tree edits still refresh on window focus.
//!
//! ponytail: workdir file-watch skipped - focus-refresh already covers external
//! editor saves; add a (gitignore-filtered) workdir watch only if instant WIP
//! updates become worth the event noise.

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use notify_debouncer_mini::{
    new_debouncer,
    notify::{RecommendedWatcher, RecursiveMode},
    DebounceEventResult, Debouncer,
};
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};

/// Event name the frontend listens on; payload is the repo path that changed.
pub const REPO_CHANGED: &str = "repo-changed";

/// One live debouncer per watched repo path. Dropping the debouncer stops its
/// watch, so `unwatch` is just a map removal. Not "active-repo" state - a set of
/// independent per-tab watchers, keyed by path, that never race.
#[derive(Default)]
pub struct Watchers(Mutex<HashMap<String, Debouncer<RecommendedWatcher>>>);

/// The git op that fires a burst of writes (lock files, ref updates, new objects)
/// should collapse to one refresh: wait this long after the last write.
const DEBOUNCE: Duration = Duration::from_millis(400);

/// The git dir(s) whose changes matter for `repo`. A linked worktree keeps
/// HEAD/index in its own git dir (`path()`) but shares refs/packed-refs in the
/// common dir, so both are watched; they're equal for a normal repo (one entry).
fn git_dirs(repo: &str) -> AppResult<Vec<PathBuf>> {
    let git = git2::Repository::open(repo)?;
    let mut dirs = vec![git.path().to_path_buf()];
    let common = git.commondir().to_path_buf();
    if common != git.path() {
        dirs.push(common);
    }
    Ok(dirs)
}

/// Start watching `repo`'s git dir(s), calling `on_change` after each debounced
/// change batch. Idempotent: a second call for an already-watched path is a no-op
/// (so re-activating a tab doesn't stack watchers). The tauri command wraps this
/// with an event emit; the split keeps the file-watch mechanism testable without
/// an AppHandle.
fn watch_with(
    state: &Watchers,
    repo: &str,
    on_change: impl Fn() + Send + 'static,
) -> AppResult<()> {
    let mut map = state.0.lock();
    if map.contains_key(repo) {
        return Ok(());
    }
    let dirs = git_dirs(repo)?;
    let mut debouncer = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| {
        // A watch error (e.g. the dir vanished) just means no event this round;
        // the next real change re-fires. Only a successful batch pings the UI.
        if res.is_ok() {
            on_change();
        }
    })
    .map_err(|e| AppError::Msg(format!("watch init: {e}")))?;

    for dir in &dirs {
        debouncer
            .watcher()
            .watch(dir, RecursiveMode::Recursive)
            .map_err(|e| AppError::Msg(format!("watch {}: {e}", dir.display())))?;
    }
    map.insert(repo.to_string(), debouncer);
    Ok(())
}

/// Start watching `repo`, emitting `REPO_CHANGED { repo }` on each change batch.
pub fn watch(app: &AppHandle, state: &Watchers, repo: &str) -> AppResult<()> {
    let app = app.clone();
    let repo_owned = repo.to_string();
    watch_with(state, repo, move || {
        let _ = app.emit(REPO_CHANGED, repo_owned.clone());
    })
}

/// Stop watching `repo` (dropping the debouncer). Safe to call for a path that
/// was never watched.
pub fn unwatch(state: &Watchers, repo: &str) {
    state.0.lock().remove(repo);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::thread::sleep;

    /// An external write inside `.git` fires the change callback, and the watcher
    /// is idempotent (a second watch of the same path doesn't stack). Exercises the
    /// real notify+debouncer chain against a real repo on disk.
    #[test]
    fn git_write_fires_change_and_watch_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("gitchef-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let repo = git2::Repository::init(&dir).unwrap();
        drop(repo);
        let path = dir.to_str().unwrap().to_string();

        let hits = Arc::new(AtomicUsize::new(0));
        let h = hits.clone();
        let state = Watchers::default();
        watch_with(&state, &path, move || {
            h.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        // Idempotent: the second call must not start a second watcher (which would
        // double every event).
        watch_with(&state, &path, || panic!("second watch should be a no-op")).unwrap();

        // Simulate an external ref update (what a branch create/commit writes).
        sleep(Duration::from_millis(100)); // let the watcher arm
        std::fs::write(dir.join(".git/refs/heads/feature"), "0\n").unwrap();

        // Debounce is 400ms; poll up to ~2s for the batch.
        for _ in 0..20 {
            sleep(Duration::from_millis(100));
            if hits.load(Ordering::SeqCst) > 0 {
                break;
            }
        }
        unwatch(&state, &path);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(hits.load(Ordering::SeqCst) > 0, "a .git write should fire on_change");
    }
}
