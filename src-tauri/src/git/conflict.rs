//! Block-level conflict resolution. A conflicted working file is split into
//! plain context and conflict segments (ours / theirs, plus the base when the
//! user has diff3 markers); the UI picks a side per block and we rebuild the
//! file from those choices, then stage it to mark the path resolved.

use super::{literal, run_git, workdir};
use crate::error::{AppError, AppResult};
use git2::{AttrCheckFlags, Repository};
use std::path::Path;
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

/// Default marker length; git's `conflict-marker-size` attribute can override it
/// per path, and git then writes markers of exactly that length.
const DEFAULT_MARKER_SIZE: usize = 7;

/// Is this line a git conflict marker of the given kind? Git writes markers as
/// EXACTLY `size` marker chars, optionally followed by a space and a label.
/// Matching a mere prefix would also swallow ordinary content - a Markdown
/// setext heading underline (`==========`), an ASCII rule, a `|||||||||` table
/// edge - and misparsing content as a marker makes `resolve()` write the file
/// back with the user's real lines deleted. Tolerates a CRLF line ending.
fn is_marker(line: &str, marker: char, size: usize) -> bool {
    let line = line.strip_suffix('\r').unwrap_or(line);
    let mut chars = line.chars();
    if !(0..size).all(|_| chars.next() == Some(marker)) {
        return false; // too short, or not this marker
    }
    match chars.next() {
        None => true,          // bare marker
        Some(c) => c == ' ',   // marker + " label"; a longer run is content
    }
}

/// Effective conflict-marker length for `path`. Git honours the
/// `conflict-marker-size` gitattribute, so assuming 7 would fail to find ANY
/// conflict block in a file that sets it - and a file that parses as zero
/// conflicts looks fully resolved, so the UI would happily stage it with the raw
/// markers still inside.
fn marker_size(repo: &Repository, path: &str) -> usize {
    repo.get_attr(Path::new(path), "conflict-marker-size", AttrCheckFlags::default())
        .ok()
        .flatten()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|n| *n >= 1)
        .unwrap_or(DEFAULT_MARKER_SIZE)
}

/// Parse conflict markers out of `text` into ordered segments.
fn parse_text(text: &str, size: usize) -> Vec<Segment> {
    let mut segments = Vec::new();
    let mut ctx: Vec<String> = Vec::new();
    let mut ours: Vec<String> = Vec::new();
    let mut base: Vec<String> = Vec::new();
    let mut theirs: Vec<String> = Vec::new();
    let mut has_base = false;
    let mut region = Region::Outside;
    // The marker lines themselves, kept so an unterminated block can be put back
    // together verbatim (see the degraded path at the end).
    let (mut open_line, mut base_line, mut sep_line) = (None, None, None);

    let flush_ctx = |ctx: &mut Vec<String>, segments: &mut Vec<Segment>| {
        if !ctx.is_empty() {
            segments.push(Segment::Context { lines: std::mem::take(ctx) });
        }
    };

    for line in text.split('\n') {
        match region {
            Region::Outside if is_marker(line, '<', size) => {
                flush_ctx(&mut ctx, &mut segments);
                ours.clear();
                base.clear();
                theirs.clear();
                has_base = false;
                open_line = Some(line.to_string());
                base_line = None;
                sep_line = None;
                region = Region::Ours;
            }
            Region::Ours if is_marker(line, '|', size) => {
                has_base = true;
                base_line = Some(line.to_string());
                region = Region::Base;
            }
            Region::Ours if is_marker(line, '=', size) => {
                sep_line = Some(line.to_string());
                region = Region::Theirs;
            }
            Region::Base if is_marker(line, '=', size) => {
                sep_line = Some(line.to_string());
                region = Region::Theirs;
            }
            Region::Theirs if is_marker(line, '>', size) => {
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
    // silently dropped - INCLUDING the marker lines, in document order. Dropping
    // those would let resolve() write the file back looking clean and stage it,
    // quietly discarding the fact that the block was never closed.
    if !matches!(region, Region::Outside) {
        ctx.extend(open_line);
        ctx.extend(ours);
        ctx.extend(base_line);
        ctx.extend(base);
        ctx.extend(sep_line);
        ctx.extend(theirs);
    }
    flush_ctx(&mut ctx, &mut segments);
    segments
}

pub fn parse(repo: &Repository, path: &str) -> AppResult<ConflictFile> {
    let full = workdir(repo)?.join(path);
    let text = std::fs::read_to_string(&full)
        .map_err(|_| AppError::Msg(format!("cannot read {path} as text (binary conflict?)")))?;
    let mut segments = parse_text(&text, marker_size(repo, path));
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
    let size = marker_size(repo, path);
    let segments = parse_text(&text, size);
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
    // Last line of defence before staging: if ANY marker survived, the parse
    // disagreed with the file and staging now would commit conflict markers.
    // Refuse instead - a visible error beats a corrupt commit.
    if let Some(bad) = body
        .split('\n')
        .find(|l| ['<', '=', '>', '|'].iter().any(|c| is_marker(l, *c, size)))
    {
        return Err(AppError::Msg(format!(
            "{path} still contains a conflict marker ({bad}) - resolve it in an editor and stage it there"
        )));
    }
    std::fs::write(&full, body)?;
    // `git add` clears the conflict's higher-stage index entries; libgit2's
    // index.add_path does too, but the CLI is the one with all the safety rails.
    run_git(workdir(repo)?, &["add", "--", &literal(path)])?;
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
    run_git(dir, &["checkout", flag, "--", &literal(path)])?;
    run_git(dir, &["add", "--", &literal(path)])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{parse, parse_text, resolve, Segment, DEFAULT_MARKER_SIZE};
    use crate::git::run_git;
    use git2::Repository;
    use std::path::{Path, PathBuf};

    const SAMPLE: &str = "keep\n<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> branch\ntail\n";

    /// A conflict whose sides carry Markdown setext heading underlines - lines of
    /// 10 `=` that are content, not markers. Parsing must key on the exact
    /// 7-char marker, else the first underline is read as the separator and the
    /// rest of the user's text is silently dropped when the block is resolved.
    #[test]
    fn long_runs_of_marker_chars_in_content_are_not_markers() {
        let text = "intro\n\
                    <<<<<<< HEAD\n\
                    Ours Title\n\
                    ==========\n\
                    ours body\n\
                    =======\n\
                    Theirs Title\n\
                    ==========\n\
                    theirs body\n\
                    >>>>>>> feature\n\
                    tail\n";
        let segments = parse_text(text, DEFAULT_MARKER_SIZE);
        let conflict = segments
            .iter()
            .find_map(|s| match s {
                Segment::Conflict { ours, theirs, .. } => Some((ours, theirs)),
                _ => None,
            })
            .expect("the block must parse as one conflict");
        assert_eq!(conflict.0, &["Ours Title", "==========", "ours body"]);
        assert_eq!(conflict.1, &["Theirs Title", "==========", "theirs body"]);
    }

    /// Markers still parse with a CRLF line ending and with no trailing label.
    #[test]
    fn markers_parse_with_crlf_and_without_labels() {
        let text = "a\r\n<<<<<<<\r\nmine\r\n=======\r\nyours\r\n>>>>>>>\r\nb\r\n";
        let ours = parse_text(text, DEFAULT_MARKER_SIZE)
            .into_iter()
            .find_map(|s| match s {
                Segment::Conflict { ours, .. } => Some(ours),
                _ => None,
            })
            .expect("bare markers must still be recognised");
        assert_eq!(ours, ["mine\r"]);
    }

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
        let segs = parse_text(SAMPLE, DEFAULT_MARKER_SIZE);
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
        let segs = parse_text(text, DEFAULT_MARKER_SIZE);
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
        let segs = parse_text(SAMPLE, DEFAULT_MARKER_SIZE);
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

    /// Git honours the `conflict-marker-size` gitattribute and writes markers of
    /// exactly that length. Assuming 7 finds NO conflict block in such a file,
    /// which then looks fully resolved - so the UI would stage it with the raw
    /// markers still inside and commit them.
    #[test]
    fn honours_the_conflict_marker_size_attribute() {
        let dir = tmp("marker-size");
        init(&dir);
        std::fs::write(dir.join(".gitattributes"), "big.txt conflict-marker-size=32\n").unwrap();
        let p = "big.txt";
        let m = |c: char| c.to_string().repeat(32);
        let text = format!("keep\n{} HEAD\nmine\n{}\nyours\n{} other\ntail\n", m('<'), m('='), m('>'));
        std::fs::write(dir.join(p), &text).unwrap();

        let repo = Repository::open(&dir).unwrap();
        let parsed = parse(&repo, p).unwrap();
        let n = parsed.segments.iter().filter(|s| matches!(s, Segment::Conflict { .. })).count();
        assert_eq!(n, 1, "the 32-char block must parse as a conflict: {:?}", parsed.segments);

        resolve(&Repository::open(&dir).unwrap(), p, &["ours".to_string()]).unwrap();
        let got = std::fs::read_to_string(dir.join(p)).unwrap();
        assert_eq!(got, "keep\nmine\ntail\n");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Whatever the parse decided, a file that still holds a marker must never be
    /// written back and staged - that commits the markers.
    #[test]
    fn refuses_to_stage_a_file_that_still_holds_a_marker() {
        let dir = tmp("marker-guard");
        init(&dir);
        let p = "f.txt";
        // An unterminated conflict: parse_text degrades it to context, so there
        // are zero blocks to choose and the rebuilt text still has the markers.
        std::fs::write(dir.join(p), "a\n<<<<<<< HEAD\nmine\n=======\nyours\n").unwrap();
        let err = resolve(&Repository::open(&dir).unwrap(), p, &[]);
        assert!(err.is_err(), "must refuse rather than stage markers: {err:?}");
        let staged = run_git(&dir, &["diff", "--cached", "--name-only"]).unwrap();
        assert!(!staged.contains("f.txt"), "nothing may be staged: {staged}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
