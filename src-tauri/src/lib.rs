mod error;
mod git;

use error::AppResult;
use git::{branch, diff, files, graph, ops, repo};
use git2::Repository;

/// Open a repository by path. The backend holds NO active-repo state: every
/// command receives the repo path it operates on, so multiple tabs can never
/// race over a shared "current repo" (libgit2 open is cheap).
fn open(path: &str) -> AppResult<Repository> {
    Ok(Repository::open(path)?)
}

#[tauri::command]
fn open_repo(path: String) -> AppResult<repo::RepoInfo> {
    repo::info(&open(&path)?)
}

#[tauri::command]
fn repo_status(repo: String) -> AppResult<repo::StatusResult> {
    repo::status(&open(&repo)?)
}

#[tauri::command]
fn work_stats(repo: String) -> AppResult<repo::WorkStats> {
    repo::work_stats(&open(&repo)?)
}

#[tauri::command]
fn commit_graph(repo: String, limit: Option<usize>) -> AppResult<Vec<graph::CommitNode>> {
    graph::commit_graph(&open(&repo)?, limit.unwrap_or(500))
}

#[tauri::command]
fn list_branches(repo: String) -> AppResult<Vec<branch::BranchInfo>> {
    branch::list_branches(&open(&repo)?)
}

#[tauri::command]
fn list_tags(repo: String) -> AppResult<Vec<branch::TagInfo>> {
    branch::list_tags(&open(&repo)?)
}

#[tauri::command]
fn file_diff(repo: String, path: String, staged: bool, full: bool) -> AppResult<diff::FileDiff> {
    diff::file_diff(&open(&repo)?, &path, staged, full)
}

#[tauri::command]
fn commit_diff(repo: String, id: String) -> AppResult<Vec<diff::FileDiff>> {
    diff::commit_diff(&open(&repo)?, &id)
}

#[tauri::command]
fn commit(repo: String, message: String) -> AppResult<String> {
    ops::commit(&open(&repo)?, &message)
}

#[tauri::command]
fn checkout(repo: String, name: String) -> AppResult<()> {
    branch::checkout(&open(&repo)?, &name)
}

#[tauri::command]
fn create_branch(repo: String, name: String, checkout: bool) -> AppResult<()> {
    branch::create_branch(&open(&repo)?, &name, checkout)
}

#[tauri::command]
fn push(repo: String) -> AppResult<String> {
    ops::push(&open(&repo)?)
}

#[tauri::command]
fn pull(repo: String, mode: String) -> AppResult<String> {
    ops::pull(&open(&repo)?, &mode)
}

#[tauri::command]
fn fetch(repo: String) -> AppResult<String> {
    ops::fetch(&open(&repo)?)
}

#[tauri::command]
fn merge(repo: String, branch: String) -> AppResult<String> {
    ops::merge(&open(&repo)?, &branch)
}

// --- commit context-menu actions ---

#[tauri::command]
fn create_branch_at(repo: String, name: String, sha: String, checkout: bool) -> AppResult<()> {
    branch::create_branch_at(&open(&repo)?, &name, &sha, checkout)
}

#[tauri::command]
fn create_tag_at(
    repo: String,
    name: String,
    sha: String,
    annotated: bool,
    message: Option<String>,
) -> AppResult<()> {
    branch::create_tag_at(&open(&repo)?, &name, &sha, annotated, message)
}

#[tauri::command]
fn cherry_pick(repo: String, sha: String) -> AppResult<String> {
    ops::cherry_pick(&open(&repo)?, &sha)
}

#[tauri::command]
fn revert_commit(repo: String, sha: String) -> AppResult<String> {
    ops::revert_commit(&open(&repo)?, &sha)
}

#[tauri::command]
fn reset_to(repo: String, sha: String, mode: String) -> AppResult<String> {
    ops::reset_to(&open(&repo)?, &sha, &mode)
}

#[tauri::command]
fn save_commit_patch(repo: String, sha: String, dest: String) -> AppResult<()> {
    ops::save_commit_patch(&open(&repo)?, &sha, &dest)
}

#[tauri::command]
fn compare_workdir(repo: String, sha: String) -> AppResult<Vec<diff::FileDiff>> {
    diff::compare_workdir(&open(&repo)?, &sha)
}

// --- multi-select + file actions ---

#[tauri::command]
fn stage_paths(repo: String, paths: Vec<String>) -> AppResult<()> {
    files::stage_paths(&open(&repo)?, paths)
}

#[tauri::command]
fn unstage_paths(repo: String, paths: Vec<String>) -> AppResult<()> {
    files::unstage_paths(&open(&repo)?, paths)
}

#[tauri::command]
fn discard_paths(repo: String, paths: Vec<String>) -> AppResult<()> {
    files::discard_paths(&open(&repo)?, paths)
}

#[tauri::command]
fn ignore_path(repo: String, pattern: String) -> AppResult<()> {
    files::ignore_path(&open(&repo)?, &pattern)
}

#[tauri::command]
fn stash_file(repo: String, path: String) -> AppResult<String> {
    files::stash_file(&open(&repo)?, &path)
}

#[tauri::command]
fn save_patch(repo: String, path: String, dest: String) -> AppResult<()> {
    files::save_patch(&open(&repo)?, &path, &dest)
}

#[tauri::command]
fn delete_file(repo: String, path: String) -> AppResult<()> {
    files::delete_file(&open(&repo)?, &path)
}

#[tauri::command]
fn copy_text(text: String) -> AppResult<()> {
    files::copy_text(&text)
}

#[tauri::command]
fn reveal_in_finder(repo: String, path: String) -> AppResult<()> {
    files::reveal_in_finder(&open(&repo)?, &path)
}

#[tauri::command]
fn open_default(repo: String, path: String) -> AppResult<()> {
    files::open_default(&open(&repo)?, &path)
}

#[tauri::command]
fn open_in_editor(repo: String, path: String) -> AppResult<()> {
    files::open_in_editor(&open(&repo)?, &path)
}

#[tauri::command]
fn open_difftool(repo: String, path: String) -> AppResult<()> {
    files::open_difftool(&open(&repo)?, &path)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    // macOS binds Cmd+W to the default Window menu's "Close Window". Replace the
    // menu with just App + Edit (no Window menu) so Cmd+W is free for the JS
    // tab-close shortcut, while keeping Quit and copy/paste/undo working.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(|handle| {
        use tauri::menu::{Menu, PredefinedMenuItem, Submenu};
        let app = Submenu::with_items(handle, "GitChef", true, &[
            &PredefinedMenuItem::quit(handle, None)?,
        ])?;
        let edit = Submenu::with_items(handle, "Edit", true, &[
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
        ])?;
        Menu::with_items(handle, &[&app, &edit])
    });

    builder
        .invoke_handler(tauri::generate_handler![
            open_repo,
            repo_status,
            work_stats,
            commit_graph,
            list_branches,
            list_tags,
            file_diff,
            commit_diff,
            commit,
            checkout,
            create_branch,
            push,
            pull,
            fetch,
            merge,
            create_branch_at,
            create_tag_at,
            cherry_pick,
            revert_commit,
            reset_to,
            save_commit_patch,
            compare_workdir,
            stage_paths,
            unstage_paths,
            discard_paths,
            ignore_path,
            stash_file,
            save_patch,
            delete_file,
            copy_text,
            reveal_in_finder,
            open_default,
            open_in_editor,
            open_difftool,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GitChef");
}
