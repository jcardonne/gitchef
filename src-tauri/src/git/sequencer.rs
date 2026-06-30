//! In-progress operation state (rebase / merge / cherry-pick / revert) and its
//! lifecycle controls (continue / skip / abort). git itself owns the sequencer
//! state on disk; we only read it and drive the same CLI a terminal user would.

use super::workdir;
use crate::error::{AppError, AppResult};
use git2::{Repository, RepositoryState};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum SequencerKind {
    Rebase,
    Merge,
    CherryPick,
    Revert,
}

#[derive(Serialize)]
pub struct SequencerState {
    /// None when the working tree is clean (no operation paused mid-flight).
    pub kind: Option<SequencerKind>,
    /// True for `rebase -i`, so the banner can label it "interactive".
    pub interactive: bool,
    /// Step `current` of `total` (rebase only; 0 when unknown).
    pub current: usize,
    pub total: usize,
    /// Short oid the rebase is replaying onto, for display.
    pub onto: Option<String>,
    /// Branch being rebased (short name).
    pub head_name: Option<String>,
}

fn kind_of(state: RepositoryState) -> Option<SequencerKind> {
    match state {
        RepositoryState::Rebase
        | RepositoryState::RebaseInteractive
        | RepositoryState::RebaseMerge => Some(SequencerKind::Rebase),
        RepositoryState::Merge => Some(SequencerKind::Merge),
        RepositoryState::CherryPick | RepositoryState::CherryPickSequence => {
            Some(SequencerKind::CherryPick)
        }
        RepositoryState::Revert | RepositoryState::RevertSequence => Some(SequencerKind::Revert),
        _ => None,
    }
}

/// Read git's on-disk rebase metadata for progress + target display. Modern git
/// uses the `rebase-merge` backend; `rebase-apply` is the legacy am-based one.
fn rebase_meta(gitdir: &Path) -> (bool, usize, usize, Option<String>, Option<String>) {
    let dir = {
        let rm = gitdir.join("rebase-merge");
        let ra = gitdir.join("rebase-apply");
        if rm.is_dir() {
            rm
        } else if ra.is_dir() {
            ra
        } else {
            return (false, 0, 0, None, None);
        }
    };
    let read = |name: &str| {
        std::fs::read_to_string(dir.join(name))
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    let interactive = dir.join("interactive").exists();
    let parse = |v: Option<String>| v.and_then(|s| s.parse::<usize>().ok()).unwrap_or(0);
    let current = parse(read("msgnum").or_else(|| read("next")));
    let total = parse(read("end").or_else(|| read("last")));
    let onto = read("onto").map(|s| s.chars().take(7).collect());
    let head_name = read("head-name").map(|s| {
        s.strip_prefix("refs/heads/")
            .map(str::to_string)
            .unwrap_or(s)
    });
    (interactive, current, total, onto, head_name)
}

pub fn state(repo: &Repository) -> AppResult<SequencerState> {
    let kind = kind_of(repo.state());
    let (interactive, current, total, onto, head_name) = match kind {
        Some(SequencerKind::Rebase) => rebase_meta(repo.path()),
        _ => (false, 0, 0, None, None),
    };
    Ok(SequencerState { kind, interactive, current, total, onto, head_name })
}

/// Run a sequencing git command (rebase / merge / cherry-pick / revert and their
/// --continue/--skip/--abort) that may legitimately STOP with a non-zero exit
/// when it pauses for conflicts or an `edit` stop. A pause leaves the repo in a
/// sequencer state, so treat "non-zero but still mid-operation" as success (the
/// banner takes over); only a non-zero exit that leaves the repo clean is a real
/// error.
pub fn run_step(repo: &Repository, args: &[&str], envs: &[(&str, &str)]) -> AppResult<String> {
    let dir = workdir(repo)?;
    let mut cmd = std::process::Command::new("git");
    cmd.current_dir(dir).args(args);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    let out = cmd.output()?;
    let text = {
        let stdout = String::from_utf8_lossy(&out.stdout);
        let stderr = String::from_utf8_lossy(&out.stderr);
        format!("{stdout}{stderr}").trim().to_string()
    };
    if out.status.success() {
        return Ok(text);
    }
    // re-reads .git from disk, so it reflects the subprocess's mutations
    if kind_of(repo.state()).is_some() {
        return Ok(text); // paused for conflicts / edit - not a failure
    }
    Err(AppError::Msg(format!("git {}: {}", args.join(" "), text)))
}

/// `--continue` / `--skip` / `--abort` dispatched to whichever operation is in
/// progress. `GIT_EDITOR=true` keeps `--continue` from blocking on a commit-msg
/// editor (the reworded message, if any, was already amended via an exec hook).
pub fn act(repo: &Repository, action: &str) -> AppResult<String> {
    if !matches!(action, "--continue" | "--skip" | "--abort") {
        return Err(AppError::Msg(format!("unknown sequencer action: {action}")));
    }
    let cmd = match kind_of(repo.state()) {
        Some(SequencerKind::Rebase) => "rebase",
        Some(SequencerKind::Merge) => "merge",
        Some(SequencerKind::CherryPick) => "cherry-pick",
        Some(SequencerKind::Revert) => "revert",
        None => return Err(AppError::Msg("no operation in progress".into())),
    };
    if cmd == "merge" && action == "--skip" {
        return Err(AppError::Msg("a merge cannot skip a step; resolve or abort it".into()));
    }
    run_step(repo, &[cmd, action], &[("GIT_EDITOR", "true")])
}

#[cfg(test)]
mod tests {
    use super::{act, state, SequencerKind};
    use crate::git::{conflict, ops, run_git};
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

    fn commit(dir: &Path, body: &str, msg: &str) {
        std::fs::write(dir.join("f.txt"), body).unwrap();
        run_git(dir, &["add", "."]).unwrap();
        run_git(dir, &["commit", "-m", msg]).unwrap();
    }

    // The whole backend conflict lifecycle on a real repo: a conflicting rebase
    // PAUSES (not errors), state() reports it, resolve() clears the conflict, and
    // act("--continue") finishes - exactly what the banner drives.
    #[test]
    fn rebase_conflict_pauses_then_resolves_and_continues() {
        let dir = tmp("seq");
        Repository::init(&dir).unwrap();
        run_git(&dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(&dir, &["config", "user.name", "t"]).unwrap();
        commit(&dir, "base\n", "base");
        // Don't assume the default branch name (master vs main): capture it.
        let main = run_git(&dir, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap().trim().to_string();
        run_git(&dir, &["checkout", "-q", "-b", "feature"]).unwrap();
        commit(&dir, "feature\n", "feature edit");
        run_git(&dir, &["checkout", "-q", &main]).unwrap();
        commit(&dir, "main\n", "main edit");
        run_git(&dir, &["checkout", "-q", "feature"]).unwrap();

        let repo = Repository::open(&dir).unwrap();
        // Replaying feature onto the base branch conflicts on f.txt. Must NOT error.
        ops::rebase_onto(&repo, &main).unwrap();

        let st = state(&repo).unwrap();
        assert!(matches!(st.kind, Some(SequencerKind::Rebase)), "paused in a rebase");
        assert!(st.total >= 1, "progress populated: {}/{}", st.current, st.total);

        // Resolve the only conflict block (take one side) and continue.
        conflict::resolve(&repo, "f.txt", &["ours".to_string()]).unwrap();
        act(&repo, "--continue").unwrap();

        assert!(state(&repo).unwrap().kind.is_none(), "rebase finished, tree clean");
        let f = std::fs::read_to_string(dir.join("f.txt")).unwrap();
        assert!(!f.contains("<<<<<<<"), "no conflict markers left: {f:?}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
