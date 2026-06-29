//! Interactive rebase driven from the GUI. We let git's own sequencer execute
//! the plan (it handles squash/fixup/conflict stops natively) and only inject
//! the edited todo list: `GIT_SEQUENCE_EDITOR` points back at our own binary,
//! which overwrites git's todo file with the plan the user built. Reword
//! messages ride along as `exec` lines that amend the just-replayed commit.

use super::sequencer;
use crate::error::AppResult;
use git2::{Repository, Sort};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
pub struct TodoItem {
    /// "pick" | "reword" | "edit" | "squash" | "fixup" | "drop"
    pub action: String,
    pub sha: String,
    pub summary: String,
    /// New commit message, for `reword` only.
    pub message: Option<String>,
}

/// The initial all-`pick` plan: every commit in `base..HEAD`, oldest first (the
/// order git's todo list uses).
pub fn plan(repo: &Repository, base: &str) -> AppResult<Vec<TodoItem>> {
    let base_oid = repo.revparse_single(base)?.peel_to_commit()?.id();
    let mut walk = repo.revwalk()?;
    walk.push_head()?;
    walk.hide(base_oid)?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::REVERSE)?;
    let mut items = Vec::new();
    for oid in walk {
        let oid = oid?;
        let c = repo.find_commit(oid)?;
        items.push(TodoItem {
            action: "pick".into(),
            sha: oid.to_string(),
            summary: c.summary().unwrap_or("").to_string(),
            message: None,
        });
    }
    Ok(items)
}

/// POSIX single-quote a path so it survives the shell git runs the editor /
/// exec commands through.
// ponytail: POSIX quoting only; Windows (git-for-windows ships sh) is the
// upgrade path if/when this app ships there.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub fn run_interactive(repo: &Repository, base: &str, plan: Vec<TodoItem>) -> AppResult<String> {
    // Refuse to start over a paused operation: starting `rebase -i` would fail
    // anyway, and wiping the scratch dir below would destroy reword message
    // files the in-progress rebase still needs. Abort/finish it first.
    if sequencer::state(repo)?.kind.is_some() {
        return Err(crate::error::AppError::Msg(
            "an operation is already in progress; finish or abort it first".into(),
        ));
    }

    let exe = std::env::current_exe()?;
    let exe = exe.to_string_lossy();

    // Stable scratch dir inside .git: reword message files must outlive a
    // conflict pause (the exec runs only when the user later continues), so we
    // can't clean up at the end here - we wipe it at the start of each run.
    let scratch = repo.path().join("gitchef-rebase");
    std::fs::remove_dir_all(&scratch).ok();
    std::fs::create_dir_all(&scratch)?;

    let mut todo = String::new();
    for it in &plan {
        match it.action.as_str() {
            "drop" => continue, // omitting the line drops the commit
            "reword" => {
                todo.push_str(&format!("pick {}\n", it.sha));
                let msg = scratch.join(format!("{}.msg", it.sha));
                std::fs::write(&msg, it.message.clone().unwrap_or_default())?;
                todo.push_str(&format!(
                    "exec {} --gitchef-reword {}\n",
                    sh_quote(&exe),
                    sh_quote(&msg.to_string_lossy())
                ));
            }
            a @ ("pick" | "edit" | "squash" | "fixup") => {
                todo.push_str(&format!("{a} {}\n", it.sha));
            }
            other => {
                return Err(crate::error::AppError::Msg(format!(
                    "unknown rebase action: {other}"
                )))
            }
        }
    }

    let planfile = scratch.join("plan");
    std::fs::write(&planfile, &todo)?;
    let seq_editor = format!(
        "{} --gitchef-apply-todo {}",
        sh_quote(&exe),
        sh_quote(&planfile.to_string_lossy())
    );

    sequencer::run_step(
        repo,
        &["rebase", "-i", "--autostash", base],
        &[("GIT_SEQUENCE_EDITOR", seq_editor.as_str()), ("GIT_EDITOR", "true")],
    )
}

/// Hook invoked when our own binary is re-launched by git as an editor/exec.
/// Returns true when a hook was handled, so the caller skips starting the GUI.
///
/// - `--gitchef-apply-todo <plan> <todofile>`: overwrite git's rebase todo with
///   our pre-built plan (the `GIT_SEQUENCE_EDITOR` injection point).
/// - `--gitchef-reword <msgfile>`: amend the just-replayed commit's message
///   (the `exec` line emitted for a reworded commit). cwd is the repo root.
pub fn run_cli_hook() -> bool {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("--gitchef-apply-todo") => {
            // Exit non-zero if we can't inject the plan, so git stops with
            // "sequence editor failed" instead of silently running the original
            // all-pick todo (a plain rebase the user never asked for).
            let done = match (args.get(2), args.get(3)) {
                (Some(plan), Some(todo)) => std::fs::copy(plan, todo).is_ok(),
                _ => false,
            };
            if !done {
                std::process::exit(1);
            }
            true
        }
        Some("--gitchef-reword") => {
            if let Some(msgfile) = args.get(2) {
                let ok = std::process::Command::new("git")
                    .args(["commit", "--amend", "-F", msgfile])
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
                // Exit non-zero so git's sequencer stops on a failed exec instead
                // of advancing and silently keeping the old commit message.
                if !ok {
                    std::process::exit(1);
                }
            }
            true
        }
        _ => false,
    }
}

// run_interactive() drives the real app binary as git's sequence editor (via
// current_exe), so it can only be exercised end-to-end, not from `cargo test`
// where current_exe is the test runner. plan() is pure and tested here; the
// interactive replay is covered by the e2e suite.
#[cfg(test)]
mod tests {
    use super::plan;
    use crate::git::run_git;
    use git2::Repository;
    use std::path::{Path, PathBuf};

    fn tmp(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let mut p = std::env::temp_dir();
        p.push(format!("gitchef-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn commit(dir: &Path, file: &str, body: &str, msg: &str) {
        std::fs::write(dir.join(file), body).unwrap();
        run_git(dir, &["add", "."]).unwrap();
        run_git(dir, &["commit", "-m", msg]).unwrap();
    }

    fn init(dir: &Path) {
        Repository::init(dir).unwrap();
        run_git(dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(dir, &["config", "user.name", "t"]).unwrap();
        commit(dir, "base.txt", "base\n", "init");
    }

    #[test]
    fn plan_lists_commits_oldest_first() {
        let dir = tmp("plan");
        init(&dir);
        commit(&dir, "a.txt", "a\n", "add a");
        commit(&dir, "b.txt", "b\n", "add b");
        let repo = Repository::open(&dir).unwrap();
        let base = run_git(&dir, &["rev-parse", "HEAD~2"]).unwrap().trim().to_string();
        let items = plan(&repo, &base).unwrap();
        let msgs: Vec<&str> = items.iter().map(|i| i.summary.as_str()).collect();
        assert_eq!(msgs, vec!["add a", "add b"]);
        std::fs::remove_dir_all(&dir).ok();
    }
}
