pub mod client;
pub mod diff_filter;
pub mod embedded;
pub mod prompts;

pub use client::{AiConfig, AiStatus, GeneratedCommit, GeneratedPr};

use crate::error::{AppError, AppResult};
use crate::git::diff;
use git2::{Repository, Sort};
use tauri::AppHandle;

/// Cancels any in-progress Chef AI inference.
pub fn cancel_generation() {
    embedded::cancel_generation();
}

/// Generates a Conventional Commit message from staged changes (or unstaged changes if
/// staged_only is false and nothing is staged). Supports providing current_message to request
/// an alternative phrasing (re-roll).
pub fn generate_commit(
    app: &AppHandle,
    repo: &Repository,
    staged_only: bool,
    config: &AiConfig,
    current_message: Option<&str>,
) -> AppResult<GeneratedCommit> {
    let mut files = diff::staged_diff(repo)?;
    if files.is_empty() {
        if !staged_only {
            // For amend with no staged files, inspect the HEAD commit being amended
            if let Ok(head) = repo.head() {
                if let Ok(commit) = head.peel_to_commit() {
                    files = diff::commit_diff(repo, &commit.id().to_string()).unwrap_or_default();
                }
            }
        }
        if files.is_empty() {
            return Err(AppError::Msg(
                "No staged changes found. Please stage files first to generate a commit message.".into(),
            ));
        }
    }

    let diff_summary = diff_filter::prepare_diff_for_llm(&files);
    let user_prompt = prompts::build_commit_user_prompt(&diff_summary, current_message);
    let system_prompt = prompts::build_commit_system_prompt(config.commit_style.as_deref());

    let mut cfg = config.clone();
    if current_message.is_some() {
        // Slightly bump temperature to encourage alternative wording on re-roll
        cfg.temperature = Some((cfg.temperature.unwrap_or(0.2) + 0.35).min(1.0));
    }

    let raw_response = client::generate_chat(app, &cfg, &system_prompt, &user_prompt)?;
    Ok(client::parse_commit_message(&raw_response))
}

/// Resolves a ref name or commit hash to a git2::Commit.
/// Handles direct hashes/branches, local refs, and remote-tracking branches (e.g. "origin/main").
fn resolve_commit<'a>(repo: &'a Repository, name: &str) -> AppResult<git2::Commit<'a>> {
    // 1. Direct revparse
    if let Ok(obj) = repo.revparse_single(name) {
        if let Ok(commit) = obj.peel_to_commit() {
            return Ok(commit);
        }
    }

    // 2. Try common remote prefixes for short branch names like "main"
    for remote in &["origin", "upstream"] {
        let remote_ref = format!("{remote}/{name}");
        if let Ok(obj) = repo.revparse_single(&remote_ref) {
            if let Ok(commit) = obj.peel_to_commit() {
                return Ok(commit);
            }
        }
        let full_remote_ref = format!("refs/remotes/{remote}/{name}");
        if let Ok(obj) = repo.revparse_single(&full_remote_ref) {
            if let Ok(commit) = obj.peel_to_commit() {
                return Ok(commit);
            }
        }
    }

    // 3. Search all remote branches
    if let Ok(branches) = repo.branches(Some(git2::BranchType::Remote)) {
        for branch in branches.flatten() {
            if let Ok(Some(branch_name)) = branch.0.name() {
                if branch_name.ends_with(&format!("/{name}")) {
                    if let Ok(commit) = branch.0.get().peel_to_commit() {
                        return Ok(commit);
                    }
                }
            }
        }
    }

    Err(AppError::Msg(format!("Could not resolve ref '{name}' to a valid commit")))
}

/// Generates a Pull Request title and description between base and head refs.
pub fn generate_pr(
    app: &AppHandle,
    repo: &Repository,
    base: &str,
    head: &str,
    config: &AiConfig,
) -> AppResult<GeneratedPr> {
    let base_commit = resolve_commit(repo, base)
        .map_err(|e| AppError::Msg(format!("Could not resolve base ref '{base}': {e}")))?;
    let head_commit = resolve_commit(repo, head)
        .map_err(|e| AppError::Msg(format!("Could not resolve head ref '{head}': {e}")))?;

    // Calculate merge base to avoid reversed/polluted diffs when base branch advanced
    let merge_base_oid = match repo.merge_base(base_commit.id(), head_commit.id()) {
        Ok(oid) => oid,
        Err(_) => base_commit.id(),
    };
    let merge_base_commit = repo.find_commit(merge_base_oid)?;

    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
    walk.push(head_commit.id())?;
    let _ = walk.hide(merge_base_oid);

    let mut commit_summaries = Vec::new();
    for oid in walk {
        if let Ok(oid) = oid {
            if let Ok(commit) = repo.find_commit(oid) {
                if let Some(summary) = commit.summary() {
                    commit_summaries.push(summary.to_string());
                }
            }
        }
        if commit_summaries.len() >= 30 {
            break;
        }
    }

    let base_tree = merge_base_commit.tree()?;
    let head_tree = head_commit.tree()?;
    let mut opts = git2::DiffOptions::new();
    let diff = repo.diff_tree_to_tree(Some(&base_tree), Some(&head_tree), Some(&mut opts))?;
    let files = diff::diff_to_files(&diff, 3000)?;

    let diff_summary = diff_filter::prepare_diff_for_llm(&files);
    let user_prompt = prompts::build_pr_user_prompt(base, head, &commit_summaries, &diff_summary);

    let raw_response = client::generate_chat(app, config, prompts::PR_SYSTEM_PROMPT, &user_prompt)?;
    Ok(client::parse_pr_response(&raw_response))
}

/// Explains a merge conflict between ours and theirs.
pub fn explain_conflict(
    app: &AppHandle,
    _repo: &Repository,
    file_path: &str,
    ours: &str,
    theirs: &str,
    config: &AiConfig,
) -> AppResult<String> {
    let user_prompt = prompts::build_conflict_user_prompt(file_path, ours, theirs);
    client::generate_chat(app, config, prompts::CONFLICT_SYSTEM_PROMPT, &user_prompt)
}
