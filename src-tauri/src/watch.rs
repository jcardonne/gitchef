//! Filesystem watching for open repos. Watching the `.git` dir AND the working
//! tree lets the UI react the instant things change underneath it - a
//! commit/checkout/stash/rebase from the terminal, a branch deleted by a script,
//! or a file edited in an external editor - without the user hitting refresh. It
//! is purely local: no network, so it never touches a remote or a rate limit.
//! Remote changes still need an explicit/auto fetch.
//!
//! The working-tree half is gitignore-filtered (`is_relevant_change`): a raw file
//! save refreshes the WIP list, but a build dir churning (node_modules, target,
//! dist) is ignored so it can't spam refreshes.
//!
//! ponytail: recursive-watch a giant workdir is cheap on macOS (one FSEvents
//! stream) but registers a watch per dir on Linux inotify - if a Linux build ships
//! and hits huge `node_modules` trees, cap depth or prune ignored dirs before the
//! watch, and mind `fs.inotify.max_user_watches`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
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

/// Resolve symlinks so a watched dir and the paths notify reports for it compare
/// equal - on macOS a temp/workdir under `/var/...` surfaces as `/private/var/...`.
fn canon(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// The git dir(s) whose changes matter for `repo`. A linked worktree keeps
/// HEAD/index in its own git dir (`path()`) but shares refs/packed-refs in the
/// common dir, so both are watched; they're equal for a normal repo (one entry).
fn git_dirs(repo: &str) -> AppResult<Vec<PathBuf>> {
    let git = git2::Repository::open(repo)?;
    let mut dirs = vec![canon(git.path())];
    let common = canon(git.commondir());
    if !dirs.contains(&common) {
        dirs.push(common);
    }
    Ok(dirs)
}

/// Is this changed path worth a UI refresh? A git-dir write (refs/HEAD/index/new
/// objects) always is. A working-tree write matters only if git doesn't ignore it
/// (otherwise a build dir like node_modules, target or dist churning would spam
/// refreshes). Anything outside both trees is noise.
fn is_relevant_change(
    path: &Path,
    git_dirs: &[PathBuf],
    workdir: Option<&Path>,
    repo: Option<&git2::Repository>,
) -> bool {
    if git_dirs.iter().any(|g| path.starts_with(g)) {
        return true; // git-state change (also covers the in-tree .git)
    }
    match workdir {
        Some(wd) if path.starts_with(wd) => {
            let rel = path.strip_prefix(wd).unwrap_or(path);
            // No repo handle (open failed) -> can't check ignore, treat as relevant.
            repo.is_none_or(|r| !r.is_path_ignored(rel).unwrap_or(false))
        }
        _ => false,
    }
}

/// Start watching `repo`'s git dir(s) AND its working tree, calling `on_change`
/// after each debounced batch that carries a relevant change. Idempotent: a second
/// call for an already-watched path is a no-op (so re-activating a tab doesn't
/// stack watchers). The tauri command wraps this with an event emit; the split
/// keeps the file-watch mechanism testable without an AppHandle.
fn watch_with(
    state: &Watchers,
    repo: &str,
    on_change: impl Fn() + Send + 'static,
) -> AppResult<()> {
    let mut map = state.0.lock();
    if map.contains_key(repo) {
        return Ok(());
    }
    let git_dirs = git_dirs(repo)?;
    let workdir = git2::Repository::open(repo)?.workdir().map(canon);

    let repo_path = repo.to_string();
    let git_dirs_f = git_dirs.clone();
    let workdir_f = workdir.clone();
    let mut debouncer = new_debouncer(DEBOUNCE, move |res: DebounceEventResult| {
        let Ok(events) = res else { return }; // watch error: next real change re-fires
        // Open the repo per batch (cheap) so .gitignore is honoured live; refresh
        // only if some path in the batch is a git-state or non-ignored file change.
        let r = git2::Repository::open(&repo_path).ok();
        let hit = events
            .iter()
            .any(|ev| is_relevant_change(&ev.path, &git_dirs_f, workdir_f.as_deref(), r.as_ref()));
        if hit {
            on_change();
        }
    })
    .map_err(|e| AppError::Msg(format!("watch init: {e}")))?;

    // Watch the git dir(s) - covers a worktree/submodule gitdir that lives OUTSIDE
    // the workdir - plus the workdir for file edits. In a normal repo the .git dir
    // sits inside the workdir (watched twice); the debouncer coalesces the dup
    // events and is_relevant_change classifies them once.
    for dir in &git_dirs {
        debouncer
            .watcher()
            .watch(dir, RecursiveMode::Recursive)
            .map_err(|e| AppError::Msg(format!("watch {}: {e}", dir.display())))?;
    }
    if let Some(wd) = &workdir {
        debouncer
            .watcher()
            .watch(wd, RecursiveMode::Recursive)
            .map_err(|e| AppError::Msg(format!("watch {}: {e}", wd.display())))?;
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

    /// The workdir/gitignore classifier: git-state and non-ignored file changes are
    /// relevant; ignored build dirs and out-of-tree paths are not.
    #[test]
    fn classifies_git_state_workdir_and_ignored_paths() {
        let dir = std::env::temp_dir().join(format!("gitchef-relevant-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let repo = git2::Repository::init(&dir).unwrap();
        std::fs::write(dir.join(".gitignore"), "node_modules/\n").unwrap();
        let wd = canon(repo.workdir().unwrap());
        let gdirs = vec![canon(repo.path())];
        let r = Some(&repo);

        // git-state write (under .git) is always relevant.
        assert!(is_relevant_change(&gdirs[0].join("refs/heads/x"), &gdirs, Some(&wd), r));
        // an ordinary source edit refreshes the WIP list.
        assert!(is_relevant_change(&wd.join("src/main.rs"), &gdirs, Some(&wd), r));
        // a gitignored build dir is noise.
        assert!(!is_relevant_change(&wd.join("node_modules/pkg/index.js"), &gdirs, Some(&wd), r));
        // a path outside the tree is noise.
        assert!(!is_relevant_change(Path::new("/tmp/somewhere-else/x"), &gdirs, Some(&wd), r));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
