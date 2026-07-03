use super::repo::{remote_target, RemoteProvider};
use crate::error::{AppError, AppResult};
use git2::Repository;
use std::path::Path;
use std::process::Command;

/// Run a forge CLI (`gh`/`glab`) inside the repo dir and return its stdout. GUI
/// apps launch with a minimal PATH, so the usual install dirs are prepended
/// (mirrors avatars::run_capture). On failure the CLI's stderr is surfaced so
/// the user sees the real reason (not authenticated, branch not pushed, ...).
fn run_cli(dir: &Path, args: &[&str]) -> AppResult<String> {
    let (bin, rest) = args.split_first().ok_or_else(|| AppError::Msg("empty command".into()))?;
    let base = std::env::var("PATH").unwrap_or_default();
    let path = format!("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{base}");
    let out = Command::new(bin)
        .args(rest)
        .current_dir(dir)
        .env("PATH", path)
        .output()
        .map_err(|e| AppError::Msg(format!("failed to run `{bin}` (is it installed?): {e}")))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let msg = if stderr.trim().is_empty() {
            String::from_utf8_lossy(&out.stdout).into_owned()
        } else {
            stderr.into_owned()
        };
        return Err(AppError::Msg(msg.trim().to_string()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// First https URL in CLI output - `gh`/`glab` print the created PR/MR URL.
fn first_url(text: &str) -> Option<String> {
    text.split_whitespace().find(|t| t.starts_with("https://")).map(str::to_string)
}

/// Create a PR (GitHub) / MR (GitLab) for the current branch against `base`,
/// via the user's `gh`/`glab` CLI (no token handled here - the CLI owns auth).
/// The source branch is pushed first (a PR needs it on the remote); the created
/// page is opened and its URL returned.
pub fn create_pr(repo: &Repository, title: &str, body: &str, base: &str) -> AppResult<String> {
    let target = remote_target(repo)
        .ok_or_else(|| AppError::Msg("no GitHub/GitLab remote for this repo".into()))?;
    if repo.head_detached()? {
        return Err(AppError::Msg("check out a branch before creating a pull request".into()));
    }
    let head = repo.head()?;
    let branch = head
        .shorthand()
        .ok_or_else(|| AppError::Msg("cannot resolve the current branch name".into()))?
        .to_string();
    let dir = super::workdir(repo)?;

    // The source branch must exist on the remote for the PR/MR to be openable.
    super::run_git(dir, &["push", "--set-upstream", "origin", &branch])?;

    let out = match target.provider {
        RemoteProvider::Github => run_cli(
            dir,
            &["gh", "pr", "create", "--title", title, "--body", body, "--base", base],
        )?,
        RemoteProvider::Gitlab => run_cli(
            dir,
            &[
                "glab", "mr", "create", "--title", title, "--description", body,
                "--target-branch", base, "--source-branch", &branch, "--yes",
            ],
        )?,
    };
    let url = first_url(&out)
        .ok_or_else(|| AppError::Msg(format!("created, but could not find its URL in the CLI output:\n{out}")))?;
    super::files::open_url(&url)?;
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::first_url;

    #[test]
    fn extracts_the_pr_url_from_cli_output() {
        assert_eq!(
            first_url("Creating pull request...\nhttps://github.com/o/r/pull/42\n").as_deref(),
            Some("https://github.com/o/r/pull/42")
        );
        assert_eq!(first_url("https://gitlab.com/g/p/-/merge_requests/7").as_deref(), Some("https://gitlab.com/g/p/-/merge_requests/7"));
        assert_eq!(first_url("no url here"), None);
    }
}
