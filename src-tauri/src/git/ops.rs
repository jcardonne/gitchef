use super::{run_git, workdir};
use crate::error::{AppError, AppResult};
use git2::{BranchType, Repository};

pub fn commit(repo: &Repository, message: &str) -> AppResult<String> {
    if message.trim().is_empty() {
        return Err(AppError::Msg("commit message is empty".into()));
    }
    let mut index = repo.index()?;
    let tree = repo.find_tree(index.write_tree()?)?;
    let sig = repo
        .signature()
        .map_err(|_| AppError::Msg("set git user.name and user.email before committing".into()))?;
    let parents: Vec<git2::Commit> =
        match repo.head().ok().and_then(|h| h.peel_to_commit().ok()) {
            Some(c) => vec![c],
            None => vec![],
        };
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let oid = repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parent_refs)?;
    Ok(oid.to_string())
}

// Network + merge operations go through the git CLI (credentials, hooks, refs).

/// Push the current branch. On its first push (no upstream tracking ref yet)
/// fall back to `push -u origin <branch>` so the branch gets published instead
/// of git erroring with "has no upstream branch".
pub fn push(repo: &Repository) -> AppResult<String> {
    let dir = workdir(repo)?;
    let head = repo.head()?;
    if !head.is_branch() {
        return run_git(dir, &["push"]); // detached HEAD: let git decide
    }
    let branch_name = head.shorthand().unwrap_or("HEAD").to_string();
    // Push to the existing upstream only when it has the SAME name. Otherwise
    // (no upstream, or one pointing at a differently-named branch) publish the
    // current branch to origin/<name> and set tracking - this sidesteps the
    // push.default=simple "upstream does not match the name" failure.
    let same_name_upstream = repo
        .find_branch(&branch_name, BranchType::Local)
        .ok()
        .and_then(|b| b.upstream().ok())
        .and_then(|u| u.get().name().map(str::to_string))
        .and_then(|full| full.strip_prefix("refs/remotes/").map(str::to_string))
        .and_then(|short| short.split_once('/').map(|(_remote, b)| b.to_string()))
        .map(|up_branch| up_branch == branch_name)
        .unwrap_or(false);
    if same_name_upstream {
        run_git(dir, &["push"])
    } else {
        run_git(dir, &["push", "-u", "origin", "HEAD"])
    }
}
pub fn pull(repo: &Repository, mode: &str) -> AppResult<String> {
    let arg = match mode {
        "ff" => "--ff",
        "ff-only" => "--ff-only",
        "rebase" => "--rebase",
        other => return Err(AppError::Msg(format!("unknown pull mode: {other}"))),
    };
    run_git(workdir(repo)?, &["pull", arg])
}
pub fn fetch(repo: &Repository) -> AppResult<String> {
    run_git(workdir(repo)?, &["fetch", "--all", "--prune"])
}
pub fn merge(repo: &Repository, branch: &str) -> AppResult<String> {
    run_git(workdir(repo)?, &["merge", branch])
}

pub fn fast_forward_to(repo: &Repository, branch: &str) -> AppResult<String> {
    run_git(workdir(repo)?, &["merge", "--ff-only", branch])
}

pub fn rebase_onto(repo: &Repository, branch: &str) -> AppResult<String> {
    run_git(workdir(repo)?, &["rebase", branch])
}

/// Stash every change (tracked + untracked) off the working tree.
pub fn stash_all(repo: &Repository) -> AppResult<String> {
    run_git(workdir(repo)?, &["stash", "push", "--include-untracked"])
}

// --- commit-centric operations (via git CLI for conflict/working-tree safety) ---

pub fn cherry_pick(repo: &Repository, sha: &str) -> AppResult<String> {
    run_git(workdir(repo)?, &["cherry-pick", sha])
}

pub fn revert_commit(repo: &Repository, sha: &str) -> AppResult<String> {
    run_git(workdir(repo)?, &["revert", "--no-edit", sha])
}

pub fn reset_to(repo: &Repository, sha: &str, mode: &str) -> AppResult<String> {
    let flag = match mode {
        "soft" => "--soft",
        "mixed" => "--mixed",
        "hard" => "--hard",
        other => return Err(AppError::Msg(format!("unknown reset mode: {other}"))),
    };
    run_git(workdir(repo)?, &["reset", flag, sha])
}

/// Write the commit as a mailbox patch (`git format-patch -1`) to `dest`.
pub fn save_commit_patch(repo: &Repository, sha: &str, dest: &str) -> AppResult<()> {
    let patch = run_git(workdir(repo)?, &["format-patch", "-1", "--stdout", sha])?;
    std::fs::write(dest, patch)?;
    Ok(())
}

/// Write the diff a commit introduced for a single file to `dest`. `diff-tree`
/// handles the root commit (no parent) by diffing against the empty tree.
pub fn save_commit_file_patch(repo: &Repository, sha: &str, path: &str, dest: &str) -> AppResult<()> {
    let patch = run_git(
        workdir(repo)?,
        &["diff-tree", "-p", "--no-commit-id", "-r", "--root", sha, "--", path],
    )?;
    std::fs::write(dest, patch)?;
    Ok(())
}

/// Resolve a stash commit oid to its `stash@{N}` index by scanning the stash
/// reflog. The graph only ever surfaces the `refs/stash` tip as a node, but
/// resolving by oid keeps these ops correct if deeper entries are shown later.
fn stash_index(repo: &mut Repository, sha: &str) -> AppResult<usize> {
    let target = git2::Oid::from_str(sha)?;
    let mut found = None;
    repo.stash_foreach(|index, _msg, oid| {
        if *oid == target {
            found = Some(index);
            false // stop walking
        } else {
            true
        }
    })?;
    found.ok_or_else(|| AppError::Msg("stash entry not found".into()))
}

/// Apply a stash to the working tree, keeping it on the stack (`git stash apply`).
pub fn stash_apply(repo: &mut Repository, sha: &str) -> AppResult<String> {
    // Apply by commit id - git accepts a stash commit directly - so a concurrent
    // stash change can't make a resolved index point at the wrong entry.
    run_git(workdir(repo)?, &["stash", "apply", sha])
}

/// Apply a stash and remove it from the stack (`git stash pop`).
pub fn stash_pop(repo: &mut Repository, sha: &str) -> AppResult<String> {
    let n = stash_index(repo, sha)?;
    run_git(workdir(repo)?, &["stash", "pop", &format!("stash@{{{n}}}")])
}

/// Delete a stash without applying it (`git stash drop`).
pub fn stash_drop(repo: &mut Repository, sha: &str) -> AppResult<String> {
    let n = stash_index(repo, sha)?;
    run_git(workdir(repo)?, &["stash", "drop", &format!("stash@{{{n}}}")])
}

/// Rename a stash. Git has no in-place edit, and a stash's message lives in the
/// commit itself (the graph shows `commit.summary()`), so `git stash store -m`
/// alone can't change what GitChef displays - and re-storing the current tip is
/// a no-op that leaves a stale `stash@{n+1}` the old code wrongly dropped (which
/// deleted a *different* stash). Instead rebuild the stash commit with the new
/// message - same tree, parents, author, committer - then store the rewrite and
/// drop the original (storing first so a failed store can't lose the stash).
pub fn stash_edit_message(repo: &mut Repository, sha: &str, message: &str) -> AppResult<String> {
    let n = stash_index(repo, sha)?;
    let stash = repo.find_commit(git2::Oid::from_str(sha)?)?;
    let tree = stash.tree()?;
    let parents = stash
        .parent_ids()
        .map(|pid| repo.find_commit(pid))
        .collect::<Result<Vec<_>, _>>()?;
    let parent_refs: Vec<&git2::Commit> = parents.iter().collect();
    let new_oid = repo.commit(
        None,
        &stash.author(),
        &stash.committer(),
        message,
        &tree,
        &parent_refs,
    )?;
    let dir = workdir(repo)?;
    // Store the rewrite first - it lands at stash@{0}, pushing the original down
    // to stash@{n+1} - then drop the original. Storing first means a failed store
    // can't turn a rename into data loss.
    run_git(dir, &["stash", "store", "-m", message, &new_oid.to_string()])?;
    run_git(dir, &["stash", "drop", &format!("stash@{{{}}}", n + 1)])
}

#[cfg(test)]
mod tests {
    use super::{
        cherry_pick, fast_forward_to, merge, rebase_onto, reset_to, revert_commit, stash_all,
        stash_apply, stash_edit_message,
    };
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

    fn init(dir: &Path) {
        Repository::init(dir).unwrap();
        run_git(dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(dir, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("f.txt"), "base\n").unwrap();
        run_git(dir, &["add", "f.txt"]).unwrap();
        run_git(dir, &["commit", "-m", "init"]).unwrap();
    }

    fn write_commit(dir: &Path, content: &str, msg: &str) {
        std::fs::write(dir.join("f.txt"), content).unwrap();
        run_git(dir, &["add", "f.txt"]).unwrap();
        run_git(dir, &["commit", "-m", msg]).unwrap();
    }

    fn head(dir: &Path) -> String {
        run_git(dir, &["rev-parse", "HEAD"]).unwrap().trim().to_string()
    }

    fn stash_with(dir: &Path, body: &str, message: &str) {
        std::fs::write(dir.join("f.txt"), format!("base\n{body}\n")).unwrap();
        run_git(dir, &["stash", "push", "-m", message]).unwrap();
    }

    fn tip_sha(dir: &Path) -> String {
        run_git(dir, &["rev-parse", "stash@{0}"]).unwrap().trim().to_string()
    }

    #[test]
    fn stash_edit_message_rewrites_the_commit_summary() {
        let dir = tmp("stashedit1");
        init(&dir);
        stash_with(&dir, "WIP", "original");
        let sha = tip_sha(&dir);

        // Old code errored here ("log for 'stash' only has 1 entries").
        stash_edit_message(&mut Repository::open(&dir).unwrap(), &sha, "renamed stash").unwrap();

        // The graph reads commit.summary(), so the COMMIT message must change.
        let summary = run_git(&dir, &["show", "-s", "--format=%s", "stash@{0}"]).unwrap();
        assert_eq!(summary.trim(), "renamed stash");
        assert!(run_git(&dir, &["stash", "list"]).unwrap().contains("renamed stash"));
        // The stash must still apply cleanly afterwards.
        run_git(&dir, &["stash", "pop"]).unwrap();
        assert!(std::fs::read_to_string(dir.join("f.txt")).unwrap().contains("WIP"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stash_edit_message_preserves_other_stashes() {
        let dir = tmp("stashedit2");
        init(&dir);
        stash_with(&dir, "ONE", "stash ONE");
        stash_with(&dir, "TWO", "stash TWO"); // now stash@{0}=TWO, stash@{1}=ONE
        let sha = tip_sha(&dir);

        // Regression guard: the old code dropped stash@{n+1}, destroying "stash ONE".
        stash_edit_message(&mut Repository::open(&dir).unwrap(), &sha, "edited TWO").unwrap();

        let list = run_git(&dir, &["stash", "list"]).unwrap();
        assert!(list.contains("edited TWO"), "top stash renamed: {list}");
        assert!(list.contains("stash ONE"), "other stash must survive: {list}");
        assert_eq!(list.lines().count(), 2, "exactly two stashes remain: {list}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stash_all_clears_tracked_and_untracked() {
        let dir = tmp("stashall");
        init(&dir);
        std::fs::write(dir.join("f.txt"), "base\nchange\n").unwrap(); // tracked change
        std::fs::write(dir.join("untracked.txt"), "x\n").unwrap(); // untracked

        stash_all(&Repository::open(&dir).unwrap()).unwrap();

        assert_eq!(std::fs::read_to_string(dir.join("f.txt")).unwrap(), "base\n", "tracked reverted");
        assert!(!dir.join("untracked.txt").exists(), "untracked stashed too");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn fast_forward_to_advances_head() {
        let dir = tmp("ff");
        init(&dir);
        run_git(&dir, &["checkout", "-b", "feature"]).unwrap();
        write_commit(&dir, "base\nahead\n", "ahead");
        let feat = head(&dir);
        run_git(&dir, &["checkout", "-"]).unwrap(); // default branch, now behind
        fast_forward_to(&Repository::open(&dir).unwrap(), "feature").unwrap();
        assert_eq!(head(&dir), feat, "HEAD fast-forwarded to feature");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn merge_divergent_creates_a_merge_commit() {
        let dir = tmp("merge");
        init(&dir);
        run_git(&dir, &["checkout", "-b", "feature"]).unwrap();
        write_commit(&dir, "base\nfeature\n", "feature work");
        run_git(&dir, &["checkout", "-"]).unwrap();
        // Main diverges by touching a DIFFERENT file, so the merge is clean.
        std::fs::write(dir.join("other.txt"), "x\n").unwrap();
        run_git(&dir, &["add", "."]).unwrap();
        run_git(&dir, &["commit", "-m", "main work"]).unwrap();
        merge(&Repository::open(&dir).unwrap(), "feature").unwrap();
        let parents = run_git(&dir, &["rev-list", "--parents", "-n1", "HEAD"]).unwrap();
        assert_eq!(parents.split_whitespace().count(), 3, "merge commit has two parents: {parents}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rebase_onto_replays_commits_linearly() {
        let dir = tmp("rebase");
        init(&dir);
        run_git(&dir, &["checkout", "-b", "feature"]).unwrap();
        write_commit(&dir, "base\nfeature\n", "feature work");
        run_git(&dir, &["checkout", "-"]).unwrap();
        std::fs::write(dir.join("other.txt"), "x\n").unwrap();
        run_git(&dir, &["add", "."]).unwrap();
        run_git(&dir, &["commit", "-m", "main work"]).unwrap();
        let main_tip = head(&dir);
        run_git(&dir, &["checkout", "feature"]).unwrap();
        rebase_onto(&Repository::open(&dir).unwrap(), &main_tip).unwrap();
        assert_eq!(run_git(&dir, &["rev-parse", "HEAD~1"]).unwrap().trim(), main_tip);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cherry_pick_applies_a_commit() {
        let dir = tmp("cherry");
        init(&dir);
        run_git(&dir, &["checkout", "-b", "src"]).unwrap();
        write_commit(&dir, "base\ncherry\n", "add cherry");
        let pick = head(&dir);
        run_git(&dir, &["checkout", "-"]).unwrap();
        cherry_pick(&Repository::open(&dir).unwrap(), &pick).unwrap();
        assert!(std::fs::read_to_string(dir.join("f.txt")).unwrap().contains("cherry"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn revert_commit_undoes_its_change() {
        let dir = tmp("revert");
        init(&dir);
        write_commit(&dir, "base\nextra\n", "add extra");
        let bad = head(&dir);
        revert_commit(&Repository::open(&dir).unwrap(), &bad).unwrap();
        assert!(!std::fs::read_to_string(dir.join("f.txt")).unwrap().contains("extra"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reset_to_hard_clears_and_mixed_keeps_worktree() {
        let dir = tmp("reset");
        init(&dir);
        let base = head(&dir);
        write_commit(&dir, "base\nsecond\n", "second");
        reset_to(&Repository::open(&dir).unwrap(), &base, "hard").unwrap();
        assert_eq!(head(&dir), base);
        assert_eq!(std::fs::read_to_string(dir.join("f.txt")).unwrap(), "base\n", "hard reset clears worktree");

        write_commit(&dir, "base\nsecond\n", "second again");
        reset_to(&Repository::open(&dir).unwrap(), &base, "mixed").unwrap();
        assert_eq!(head(&dir), base, "mixed reset moves HEAD");
        assert!(
            std::fs::read_to_string(dir.join("f.txt")).unwrap().contains("second"),
            "mixed reset keeps the change in the working tree"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_commit_file_patch_includes_root_commit() {
        let dir = tmp("rootpatch");
        init(&dir); // a single root commit that adds f.txt
        let root = head(&dir);
        let dest = dir.join("out.patch");
        super::save_commit_file_patch(
            &Repository::open(&dir).unwrap(),
            &root,
            "f.txt",
            dest.to_str().unwrap(),
        )
        .unwrap();
        // Without --root, diff-tree emits nothing for the parentless root commit.
        let patch = std::fs::read_to_string(&dest).unwrap();
        assert!(patch.contains("+base"), "root commit patch must include additions: {patch}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reset_to_rejects_unknown_mode() {
        let dir = tmp("resetbad");
        init(&dir);
        let r = reset_to(&Repository::open(&dir).unwrap(), &head(&dir), "bogus");
        assert!(r.is_err(), "an unknown reset mode must error, not silently default");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stash_apply_addresses_by_commit_id() {
        let dir = tmp("stashapply");
        init(&dir);
        stash_with(&dir, "ONE", "stash ONE"); // stash@{0} = ONE
        stash_with(&dir, "TWO", "stash TWO"); // stash@{0} = TWO, stash@{1} = ONE
        let one_sha = run_git(&dir, &["rev-parse", "stash@{1}"]).unwrap().trim().to_string();
        stash_apply(&mut Repository::open(&dir).unwrap(), &one_sha).unwrap();
        let f = std::fs::read_to_string(dir.join("f.txt")).unwrap();
        assert!(f.contains("ONE") && !f.contains("TWO"), "the sha-addressed stash applies: {f}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
