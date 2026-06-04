mod error;
mod git;

use error::{AppError, AppResult};
use git::{branch, diff, graph, ops, repo};
use git2::Repository;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::State;

/// The whole app state: just the path of the open repo. Every command reopens
/// the `Repository` fresh (cheap with libgit2) which sidesteps holding a
/// non-Sync handle across the Tauri command boundary.
#[derive(Default)]
struct AppState {
    repo_path: Mutex<Option<PathBuf>>,
}

impl AppState {
    fn path(&self) -> AppResult<PathBuf> {
        self.repo_path.lock().unwrap().clone().ok_or(AppError::NoRepo)
    }
    fn open(&self) -> AppResult<Repository> {
        Ok(Repository::open(self.path()?)?)
    }
}

#[tauri::command]
fn open_repo(state: State<AppState>, path: String) -> AppResult<repo::RepoInfo> {
    let r = Repository::open(&path)?;
    let info = repo::info(&r)?;
    *state.repo_path.lock().unwrap() = Some(PathBuf::from(&path));
    Ok(info)
}

#[tauri::command]
fn repo_status(state: State<AppState>) -> AppResult<repo::StatusResult> {
    repo::status(&state.open()?)
}

#[tauri::command]
fn commit_graph(state: State<AppState>, limit: Option<usize>) -> AppResult<Vec<graph::CommitNode>> {
    graph::commit_graph(&state.open()?, limit.unwrap_or(500))
}

#[tauri::command]
fn list_branches(state: State<AppState>) -> AppResult<Vec<branch::BranchInfo>> {
    branch::list_branches(&state.open()?)
}

#[tauri::command]
fn file_diff(state: State<AppState>, path: String, staged: bool) -> AppResult<diff::FileDiff> {
    diff::file_diff(&state.open()?, &path, staged)
}

#[tauri::command]
fn commit_diff(state: State<AppState>, id: String) -> AppResult<Vec<diff::FileDiff>> {
    diff::commit_diff(&state.open()?, &id)
}

#[tauri::command]
fn stage(state: State<AppState>, path: String) -> AppResult<()> {
    ops::stage(&state.open()?, &path)
}

#[tauri::command]
fn unstage(state: State<AppState>, path: String) -> AppResult<()> {
    ops::unstage(&state.open()?, &path)
}

#[tauri::command]
fn stage_all(state: State<AppState>) -> AppResult<()> {
    ops::stage_all(&state.open()?)
}

#[tauri::command]
fn unstage_all(state: State<AppState>) -> AppResult<()> {
    ops::unstage_all(&state.open()?)
}

#[tauri::command]
fn discard(state: State<AppState>, path: String) -> AppResult<()> {
    ops::discard(&state.open()?, &path)
}

#[tauri::command]
fn commit(state: State<AppState>, message: String) -> AppResult<String> {
    ops::commit(&state.open()?, &message)
}

#[tauri::command]
fn checkout(state: State<AppState>, name: String) -> AppResult<()> {
    branch::checkout(&state.open()?, &name)
}

#[tauri::command]
fn create_branch(state: State<AppState>, name: String, checkout: bool) -> AppResult<()> {
    branch::create_branch(&state.open()?, &name, checkout)
}

#[tauri::command]
fn push(state: State<AppState>) -> AppResult<String> {
    ops::push(&state.open()?)
}

#[tauri::command]
fn pull(state: State<AppState>) -> AppResult<String> {
    ops::pull(&state.open()?)
}

#[tauri::command]
fn fetch(state: State<AppState>) -> AppResult<String> {
    ops::fetch(&state.open()?)
}

#[tauri::command]
fn merge(state: State<AppState>, branch: String) -> AppResult<String> {
    ops::merge(&state.open()?, &branch)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            open_repo,
            repo_status,
            commit_graph,
            list_branches,
            file_diff,
            commit_diff,
            stage,
            unstage,
            stage_all,
            unstage_all,
            discard,
            commit,
            checkout,
            create_branch,
            push,
            pull,
            fetch,
            merge,
        ])
        .run(tauri::generate_context!())
        .expect("error while running GitChef");
}
