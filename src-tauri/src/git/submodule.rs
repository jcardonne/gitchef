use super::{literal, run_git, short_oid, workdir};
use crate::error::AppResult;
use git2::{Repository, SubmoduleIgnore, SubmoduleStatus};
use serde::Serialize;

#[derive(Serialize)]
pub struct SubmoduleInfo {
    pub name: String,
    /// Path relative to the superproject root.
    pub path: String,
    pub url: Option<String>,
    /// Commit the superproject records for this submodule (the gitlink) - what it
    /// expects to be checked out.
    pub head_sha: Option<String>,
    /// Commit actually checked out in the submodule's working dir. Differs from
    /// `head_sha` when the submodule is out of date.
    pub workdir_sha: Option<String>,
    /// Cloned + checked out (not an empty, never-`update --init`ed directory).
    pub initialized: bool,
    /// Has staged/unstaged/untracked changes inside the submodule's working tree
    /// (not the commit-pointer difference, which is head_sha vs workdir_sha).
    pub dirty: bool,
}

/// List every submodule with its recorded vs checked-out commit and state, via
/// libgit2 (a pure local read). Status is queried with `SubmoduleIgnore::None`
/// (not `Unspecified`) so a `submodule.<name>.ignore = all/dirty` config can't
/// suppress the flags we rely on - under `ignore = all` libgit2 skips
/// `WD_UNINITIALIZED`, which would make an empty, never-cloned dir look
/// initialized, and hides real dirt.
pub fn list_submodules(repo: &Repository) -> AppResult<Vec<SubmoduleInfo>> {
    let mut out = Vec::new();
    for sm in repo.submodules()? {
        let name = sm.name().unwrap_or_default().to_string();
        let status = repo
            .submodule_status(&name, SubmoduleIgnore::None)
            .unwrap_or(SubmoduleStatus::empty());
        out.push(SubmoduleInfo {
            name,
            path: sm.path().to_string_lossy().into_owned(),
            url: sm.url().map(str::to_string),
            head_sha: sm.head_id().map(short_oid),
            workdir_sha: sm.workdir_id().map(short_oid),
            // WD_UNINITIALIZED = the workdir holds an empty, never-populated dir.
            initialized: status.is_in_wd() && !status.is_wd_uninitialized(),
            // Content changes inside the submodule; WD_MODIFIED (commit-pointer
            // drift) is excluded - that's surfaced via head_sha vs workdir_sha.
            dirty: status.intersects(
                SubmoduleStatus::WD_INDEX_MODIFIED
                    | SubmoduleStatus::WD_WD_MODIFIED
                    | SubmoduleStatus::WD_UNTRACKED,
            ),
        });
    }
    Ok(out)
}

/// Update submodules via the git CLI - it needs fetch/clone + auth, which this
/// build's libgit2 (no ssh/https transport) can't do, exactly like push/pull.
/// `--init` populates uninitialized ones, `--recursive` handles nesting; `remote`
/// adds `--remote` (check out the tracked branch's latest instead of the recorded
/// commit); `path` scopes to one submodule (None = all).
pub fn update_submodules(repo: &Repository, path: Option<&str>, remote: bool) -> AppResult<String> {
    let mut args = vec!["submodule", "update", "--init", "--recursive"];
    if remote {
        args.push("--remote");
    }
    let spec;
    if let Some(p) = path {
        spec = literal(p);
        args.push("--");
        args.push(&spec);
    }
    run_git(workdir(repo)?, &args)
}

#[cfg(test)]
mod tests {
    use super::{list_submodules, update_submodules};
    use crate::git::run_git;
    use git2::Repository;
    use std::path::Path;

    fn init_repo(dir: &Path) {
        Repository::init(dir).unwrap();
        run_git(dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(dir, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("f.txt"), "base\n").unwrap();
        run_git(dir, &["add", "f.txt"]).unwrap();
        run_git(dir, &["commit", "-m", "init"]).unwrap();
    }

    #[test]
    fn lists_status_and_reinits_after_deinit() {
        let base = std::env::temp_dir().join(format!("gitchef-sm-{}", std::process::id()));
        let upstream = base.join("upstream");
        let sup = base.join("super");
        std::fs::create_dir_all(&upstream).unwrap();
        std::fs::create_dir_all(&sup).unwrap();
        init_repo(&upstream);
        init_repo(&sup);

        // file:// submodules are blocked by default on modern git (CVE-2022-39253),
        // so allow the file protocol explicitly for this local-only test.
        let url = format!("file://{}", upstream.to_str().unwrap());
        run_git(&sup, &["-c", "protocol.file.allow=always", "submodule", "add", &url, "sub"]).unwrap();
        run_git(&sup, &["commit", "-m", "add sub"]).unwrap();

        let subs = list_submodules(&Repository::open(&sup).unwrap()).unwrap();
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].path, "sub");
        assert!(subs[0].initialized, "freshly added submodule is initialized");
        assert!(!subs[0].dirty);
        assert!(subs[0].head_sha.is_some());
        assert_eq!(subs[0].head_sha, subs[0].workdir_sha, "just added -> recorded == checked out");

        let sub_dir = sup.join("sub");
        // A dirty working tree inside the submodule is reported dirty.
        std::fs::write(sub_dir.join("wip.txt"), "x\n").unwrap();
        let subs = list_submodules(&Repository::open(&sup).unwrap()).unwrap();
        assert!(subs[0].dirty, "untracked file inside the submodule -> dirty");
        std::fs::remove_file(sub_dir.join("wip.txt")).unwrap();

        // Advancing the submodule's own HEAD (without bumping the superproject's
        // gitlink) drifts the checked-out commit from the recorded one.
        run_git(&sub_dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(&sub_dir, &["config", "user.name", "t"]).unwrap();
        run_git(&sub_dir, &["commit", "--allow-empty", "-m", "drift"]).unwrap();
        let subs = list_submodules(&Repository::open(&sup).unwrap()).unwrap();
        assert!(!subs[0].dirty, "clean again after removing the untracked file");
        assert_ne!(subs[0].head_sha, subs[0].workdir_sha, "sub HEAD drifted from the recorded gitlink");

        // Deinit empties the working dir -> uninitialized, no checked-out commit.
        run_git(&sup, &["submodule", "deinit", "-f", "sub"]).unwrap();
        let subs = list_submodules(&Repository::open(&sup).unwrap()).unwrap();
        assert!(!subs[0].initialized, "deinit -> uninitialized");
        assert!(subs[0].workdir_sha.is_none(), "no checkout after deinit");

        // `update --init` repopulates it - deinit keeps .git/modules, so this
        // re-checks-out from the retained gitdir with no re-clone (no network).
        update_submodules(&Repository::open(&sup).unwrap(), Some("sub"), false).unwrap();
        let subs = list_submodules(&Repository::open(&sup).unwrap()).unwrap();
        assert!(subs[0].initialized, "update --init repopulated the submodule");

        std::fs::remove_dir_all(&base).ok();
    }
}
