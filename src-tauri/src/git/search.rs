use super::history::FileHistoryEntry;
use super::{run_git, workdir};
use crate::error::{AppError, AppResult};
use git2::Repository;
use serde::Serialize;
use std::process::Command;

/// One matching line within a file.
#[derive(Serialize)]
pub struct SearchHit {
    pub line: u32,
    pub text: String,
}

/// A tracked file with its matching lines (consecutive, in file order).
#[derive(Serialize)]
pub struct SearchFile {
    pub path: String,
    pub hits: Vec<SearchHit>,
}

/// Repo-wide content search result. `truncated` is set when hits hit the cap.
#[derive(Serialize)]
pub struct ContentSearch {
    pub files: Vec<SearchFile>,
    pub truncated: bool,
}

/// Cap total hits so a common term on a huge repo can't flood the UI.
const MAX_HITS: usize = 500;
/// Cap pickaxe commits (as a string: it goes straight into the git args).
const MAX_PICKAXE: &str = "200";

/// Search tracked files in the working tree for `query`, like `git grep`.
/// `regex` picks extended-regexp vs fixed-string matching; `case_sensitive`
/// toggles `-i`. Binary files are skipped (`-I`) and only tracked files are
/// searched (git grep ignores untracked/ignored). Hits are grouped by file and
/// capped at MAX_HITS. `git grep` exits 1 for "no matches" - that's an empty
/// result, not an error, so we run the Command directly to read the exit code
/// (run_git would turn the exit-1 into an error).
pub fn content(
    repo: &Repository,
    query: &str,
    regex: bool,
    case_sensitive: bool,
    path: Option<&str>,
) -> AppResult<ContentSearch> {
    let empty = ContentSearch { files: Vec::new(), truncated: false };
    if query.is_empty() {
        return Ok(empty);
    }
    let dir = workdir(repo)?;
    let mut args: Vec<&str> = vec!["grep", "--line-number", "-I", "--null", "--no-color"];
    if !case_sensitive {
        args.push("--ignore-case");
    }
    args.push(if regex { "--extended-regexp" } else { "--fixed-strings" });
    args.push("-e");
    args.push(query);
    if let Some(p) = path.filter(|p| !p.is_empty()) {
        args.push("--");
        args.push(p);
    }
    let out = Command::new("git").current_dir(dir).args(&args).output()?;
    match out.status.code() {
        Some(0) => {}
        Some(1) => return Ok(empty), // no matches
        _ => {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(AppError::Msg(format!("git grep: {}", err.trim())));
        }
    }
    let raw = String::from_utf8_lossy(&out.stdout);
    let mut files: Vec<SearchFile> = Vec::new();
    let mut total = 0usize;
    let mut truncated = false;
    for record in raw.lines() {
        // Each record is `path\0lineno\0text` (--null puts NUL after the path
        // and the line number; the matched line itself has no NUL).
        let mut parts = record.splitn(3, '\0');
        let (Some(path), Some(lineno), Some(text)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if total >= MAX_HITS {
            truncated = true;
            break;
        }
        total += 1;
        let hit = SearchHit { line: lineno.parse().unwrap_or(0), text: text.to_string() };
        // Grep emits a file's matches consecutively, so extend the last group
        // when the path repeats, else open a new one.
        match files.last_mut() {
            Some(f) if f.path == path => f.hits.push(hit),
            _ => files.push(SearchFile { path: path.to_string(), hits: vec![hit] }),
        }
    }
    Ok(ContentSearch { files, truncated })
}

/// Pickaxe search: commits that change the number of occurrences of `query`
/// (`git log -S`), or - with `regex` - whose diff matches it (`git log -G`).
/// Newest-first, capped, reusing the file-history row shape for the frontend.
pub fn pickaxe(repo: &Repository, query: &str, regex: bool, path: Option<&str>) -> AppResult<Vec<FileHistoryEntry>> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    // Unborn HEAD (a fresh repo with no commits): `git log -S` fatals (exit 128),
    // which run_git would surface as an error. Nothing has changed the string yet.
    if repo.head().is_err() {
        return Ok(Vec::new());
    }
    let dir = workdir(repo)?;
    let needle = format!("{}{}", if regex { "-G" } else { "-S" }, query);
    // `-z` terminates each commit with a NUL and the format joins its 6 fields
    // with NUL too, so the whole stream splits cleanly into 6-field chunks.
    let mut args: Vec<&str> = vec![
        "log",
        &needle,
        "--max-count",
        MAX_PICKAXE,
        "-z",
        "--format=%H%x00%h%x00%an%x00%ae%x00%at%x00%s",
    ];
    if let Some(p) = path.filter(|p| !p.is_empty()) {
        args.push("--");
        args.push(p);
    }
    let raw = run_git(dir, &args)?;
    let fields: Vec<&str> = raw.split('\0').collect();
    let mut out = Vec::new();
    for chunk in fields.chunks(6) {
        // The final NUL leaves a trailing empty field: a short chunk = the end.
        if chunk.len() < 6 {
            break;
        }
        out.push(FileHistoryEntry {
            id: chunk[0].to_string(),
            short_id: chunk[1].to_string(),
            author: chunk[2].to_string(),
            email: chunk[3].to_string(),
            time: chunk[4].parse().unwrap_or(0),
            summary: chunk[5].to_string(),
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::{content, pickaxe};
    use crate::git::run_git;
    use git2::Repository;
    use std::path::PathBuf;

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

    fn setup(tag: &str) -> PathBuf {
        let dir = tmp(tag);
        Repository::init(&dir).unwrap();
        run_git(&dir, &["config", "user.email", "t@t.t"]).unwrap();
        run_git(&dir, &["config", "user.name", "t"]).unwrap();
        std::fs::write(dir.join("a.txt"), "alpha needle\nbeta\nNEEDLE upper\n").unwrap();
        std::fs::write(dir.join("b.txt"), "gamma\nneedle two\n").unwrap();
        run_git(&dir, &["add", "."]).unwrap();
        run_git(&dir, &["commit", "-m", "add needle"]).unwrap();
        dir
    }

    #[test]
    fn content_groups_hits_by_file_and_respects_case() {
        let repo = Repository::open(setup("content")).unwrap();
        // Case-insensitive: "needle" and "NEEDLE" both match, grouped per file.
        let r = content(&repo, "needle", false, false, None).unwrap();
        assert!(!r.truncated);
        assert_eq!(r.files.len(), 2);
        assert_eq!(r.files[0].path, "a.txt");
        assert_eq!(r.files[0].hits.iter().map(|h| h.line).collect::<Vec<_>>(), vec![1, 3]);
        assert_eq!(r.files[1].path, "b.txt");
        assert_eq!(r.files[1].hits[0].line, 2);
        // Case-sensitive: only the uppercase line matches.
        let cs = content(&repo, "NEEDLE", false, true, None).unwrap();
        assert_eq!(cs.files.len(), 1);
        assert_eq!(cs.files[0].hits.len(), 1);
        assert_eq!(cs.files[0].hits[0].line, 3);
        // No match is an empty result, not an error (git grep exits 1).
        assert!(content(&repo, "zzz-absent", false, false, None).unwrap().files.is_empty());
        // Path filter scopes to a pathspec.
        let scoped = content(&repo, "needle", false, false, Some("b.txt")).unwrap();
        assert_eq!(scoped.files.len(), 1);
        assert_eq!(scoped.files[0].path, "b.txt");
    }

    #[test]
    fn pickaxe_finds_the_commit_that_introduced_a_string() {
        let repo = Repository::open(setup("pickaxe")).unwrap();
        let hits = pickaxe(&repo, "needle", false, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].summary, "add needle");
        assert!(pickaxe(&repo, "zzz-absent", false, None).unwrap().is_empty());
    }

    #[test]
    fn pickaxe_on_unborn_head_is_empty_not_an_error() {
        // A freshly-init'd repo (no commits) is exactly what create-repo makes
        // when the initial commit is skipped. `git log -S` would fatal here.
        let dir = tmp("unborn");
        Repository::init(&dir).unwrap();
        let repo = Repository::open(&dir).unwrap();
        assert!(pickaxe(&repo, "anything", false, None).unwrap().is_empty());
    }
}
