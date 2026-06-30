//! Block-level conflict resolution. A conflicted working file is split into
//! plain context and conflict segments (ours / theirs, plus the base when the
//! user has diff3 markers); the UI picks a side per block and we rebuild the
//! file from those choices, then stage it to mark the path resolved.

use super::{run_git, workdir};
use crate::error::{AppError, AppResult};
use git2::Repository;
use serde::Serialize;

#[derive(Serialize, PartialEq, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Segment {
    /// Unchanged lines outside any conflict.
    Context { lines: Vec<String> },
    /// A `<<<<<<< / ======= / >>>>>>>` block. `base` is set only when the file
    /// carries diff3 markers (`|||||||`).
    Conflict {
        ours: Vec<String>,
        theirs: Vec<String>,
        base: Option<Vec<String>>,
    },
}

#[derive(Serialize)]
pub struct ConflictFile {
    pub path: String,
    pub segments: Vec<Segment>,
}

enum Region {
    Outside,
    Ours,
    Base,
    Theirs,
}

/// Parse conflict markers out of `text` into ordered segments. Marker lines are
/// matched by their 7-char prefix the way git writes them.
fn parse_text(text: &str) -> Vec<Segment> {
    let mut segments = Vec::new();
    let mut ctx: Vec<String> = Vec::new();
    let mut ours: Vec<String> = Vec::new();
    let mut base: Vec<String> = Vec::new();
    let mut theirs: Vec<String> = Vec::new();
    let mut has_base = false;
    let mut region = Region::Outside;

    let flush_ctx = |ctx: &mut Vec<String>, segments: &mut Vec<Segment>| {
        if !ctx.is_empty() {
            segments.push(Segment::Context { lines: std::mem::take(ctx) });
        }
    };

    for line in text.split('\n') {
        match region {
            Region::Outside if line.starts_with("<<<<<<<") => {
                flush_ctx(&mut ctx, &mut segments);
                ours.clear();
                base.clear();
                theirs.clear();
                has_base = false;
                region = Region::Ours;
            }
            Region::Ours if line.starts_with("|||||||") => {
                has_base = true;
                region = Region::Base;
            }
            Region::Ours if line.starts_with("=======") => region = Region::Theirs,
            Region::Base if line.starts_with("=======") => region = Region::Theirs,
            Region::Theirs if line.starts_with(">>>>>>>") => {
                segments.push(Segment::Conflict {
                    ours: std::mem::take(&mut ours),
                    theirs: std::mem::take(&mut theirs),
                    base: has_base.then(|| std::mem::take(&mut base)),
                });
                region = Region::Outside;
            }
            Region::Outside => ctx.push(line.to_string()),
            Region::Ours => ours.push(line.to_string()),
            Region::Base => base.push(line.to_string()),
            Region::Theirs => theirs.push(line.to_string()),
        }
    }
    // An unterminated conflict (corrupt file) degrades to context so nothing is
    // silently dropped.
    if !matches!(region, Region::Outside) {
        ctx.extend(ours);
        ctx.extend(base);
        ctx.extend(theirs);
    }
    flush_ctx(&mut ctx, &mut segments);
    segments
}

pub fn parse(repo: &Repository, path: &str) -> AppResult<ConflictFile> {
    let full = workdir(repo)?.join(path);
    let text = std::fs::read_to_string(&full)
        .map_err(|_| AppError::Msg(format!("cannot read {path} as text (binary conflict?)")))?;
    let mut segments = parse_text(&text);
    // split('\n') leaves a trailing "" for a newline-terminated file; drop it so
    // the UI doesn't show a phantom blank line (resolve() keeps it, since join()
    // turns it back into the trailing newline for an exact round-trip).
    if text.ends_with('\n') {
        if let Some(Segment::Context { lines }) = segments.last_mut() {
            if lines.last().map(String::is_empty).unwrap_or(false) {
                lines.pop();
                if lines.is_empty() {
                    segments.pop();
                }
            }
        }
    }
    Ok(ConflictFile { path: path.to_string(), segments })
}

/// One choice per conflict block, in document order: "ours" | "theirs" | "both" |
/// "neither". Rebuild the file with those choices applied and stage it.
pub fn resolve(repo: &Repository, path: &str, choices: &[String]) -> AppResult<()> {
    let full = workdir(repo)?.join(path);
    let text = std::fs::read_to_string(&full)
        .map_err(|_| AppError::Msg(format!("cannot read {path} as text (binary conflict?)")))?;
    let segments = parse_text(&text);
    let conflicts = segments
        .iter()
        .filter(|s| matches!(s, Segment::Conflict { .. }))
        .count();
    if choices.len() != conflicts {
        return Err(AppError::Msg(format!(
            "expected {conflicts} resolution(s), got {}",
            choices.len()
        )));
    }

    let mut out: Vec<String> = Vec::new();
    let mut ci = 0;
    for seg in &segments {
        match seg {
            Segment::Context { lines } => out.extend(lines.iter().cloned()),
            Segment::Conflict { ours, theirs, .. } => {
                match choices[ci].as_str() {
                    "ours" => out.extend(ours.iter().cloned()),
                    "theirs" => out.extend(theirs.iter().cloned()),
                    "both" => {
                        out.extend(ours.iter().cloned());
                        out.extend(theirs.iter().cloned());
                    }
                    "both_reversed" => {
                        out.extend(theirs.iter().cloned());
                        out.extend(ours.iter().cloned());
                    }
                    "neither" => {}
                    other => return Err(AppError::Msg(format!("unknown choice: {other}"))),
                }
                ci += 1;
            }
        }
    }

    // parse_text keeps the trailing "" that split('\n') yields for a
    // newline-terminated file, so join() already re-emits the final newline (and
    // omits it for a file without one) - an exact round-trip. Do NOT add another.
    let body = out.join("\n");
    std::fs::write(&full, body)?;
    // `git add` clears the conflict's higher-stage index entries; libgit2's
    // index.add_path does too, but the CLI is the one with all the safety rails.
    run_git(workdir(repo)?, &["add", "--", path])?;
    Ok(())
}

/// Take one whole side of every conflict in a file (`git checkout --ours/--theirs`)
/// and stage it - the one-click shortcut next to the block picker.
pub fn take_side(repo: &Repository, path: &str, side: &str) -> AppResult<()> {
    let flag = match side {
        "ours" => "--ours",
        "theirs" => "--theirs",
        other => return Err(AppError::Msg(format!("unknown side: {other}"))),
    };
    let dir = workdir(repo)?;
    run_git(dir, &["checkout", flag, "--", path])?;
    run_git(dir, &["add", "--", path])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{parse_text, resolve, Segment};
    use crate::git::run_git;
    use git2::Repository;
    use std::path::{Path, PathBuf};

    const SAMPLE: &str = "keep\n<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> branch\ntail\n";

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
    }

    #[test]
    fn parses_context_and_conflict() {
        let segs = parse_text(SAMPLE);
        assert_eq!(
            segs,
            vec![
                Segment::Context { lines: vec!["keep".into()] },
                Segment::Conflict {
                    ours: vec!["ours line".into()],
                    theirs: vec!["theirs line".into()],
                    base: None,
                },
                // trailing "" from the final newline; parse() trims it, parse_text doesn't
                Segment::Context { lines: vec!["tail".into(), "".into()] },
            ]
        );
    }

    #[test]
    fn parses_diff3_base() {
        let text = "<<<<<<< HEAD\na\n||||||| base\nb\n=======\nc\n>>>>>>> x\n";
        let segs = parse_text(text);
        assert_eq!(
            segs[0],
            Segment::Conflict {
                ours: vec!["a".into()],
                theirs: vec!["c".into()],
                base: Some(vec!["b".into()]),
            }
        );
    }

    #[test]
    fn rebuild_respects_each_choice() {
        // mirror resolve()'s rebuild without touching disk
        let segs = parse_text(SAMPLE);
        let build = |choice: &str| {
            let mut out: Vec<String> = vec![];
            for s in &segs {
                match s {
                    Segment::Context { lines } => out.extend(lines.iter().cloned()),
                    Segment::Conflict { ours, theirs, .. } => match choice {
                        "ours" => out.extend(ours.iter().cloned()),
                        "theirs" => out.extend(theirs.iter().cloned()),
                        "both" => {
                            out.extend(ours.iter().cloned());
                            out.extend(theirs.iter().cloned());
                        }
                        "both_reversed" => {
                            out.extend(theirs.iter().cloned());
                            out.extend(ours.iter().cloned());
                        }
                        _ => {}
                    },
                }
            }
            out.join("\n")
        };
        assert_eq!(build("ours"), "keep\nours line\ntail\n");
        assert_eq!(build("theirs"), "keep\ntheirs line\ntail\n");
        assert_eq!(build("both"), "keep\nours line\ntheirs line\ntail\n");
        assert_eq!(build("both_reversed"), "keep\ntheirs line\nours line\ntail\n");
        assert_eq!(build("neither"), "keep\ntail\n");
    }

    // Disk round-trip: guards the trailing-newline bug (resolve() must not add a
    // second newline) and that the resolved file is staged (conflict cleared).
    #[test]
    fn resolve_writes_chosen_side_and_stages_it() {
        let dir = tmp("resolve");
        init(&dir);
        let p = "file.txt";
        std::fs::write(dir.join(p), SAMPLE).unwrap();
        resolve(&Repository::open(&dir).unwrap(), p, &["theirs".to_string()]).unwrap();

        let got = std::fs::read_to_string(dir.join(p)).unwrap();
        assert_eq!(got, "keep\ntheirs line\ntail\n", "exactly one trailing newline");
        // Staged: the path now shows up under the index, not as a conflict.
        let staged = run_git(&dir, &["diff", "--cached", "--name-only"]).unwrap();
        assert!(staged.contains("file.txt"), "resolved file staged: {staged}");

        // A file without a trailing newline round-trips without gaining one.
        std::fs::write(dir.join(p), "a\n<<<<<<<\nx\n=======\ny\n>>>>>>>\nb").unwrap();
        resolve(&Repository::open(&dir).unwrap(), p, &["ours".to_string()]).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(p)).unwrap(), "a\nx\nb");
        std::fs::remove_dir_all(&dir).ok();
    }
}
