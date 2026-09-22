use crate::git::diff::FileDiff;

/// Maximum character budget for the processed diff sent to the LLM.
/// ~3,500 characters corresponds to ~800-1,000 tokens, which easily fits inside
/// the small context cache of ultra-lightweight models (0.5B / 1.5B) and executes
/// fast even on a Raspberry Pi or low-end CPU.
pub const MAX_DIFF_CHARS: usize = 3500;

/// Max length of any single diff line before truncating.
const MAX_LINE_CHARS: usize = 160;

/// Common lockfiles, minified bundles, and generated artifacts that pollute diffs
/// and bloat token count without adding semantic meaning for a commit message.
const NOISY_FILENAMES: &[&str] = &[
    "pnpm-lock.yaml",
    "package-lock.json",
    "yarn.lock",
    "bun.lockb",
    "cargo.lock",
    "composer.lock",
    "gemfile.lock",
    "poetry.lock",
    "pipfile.lock",
    "mix.lock",
    "go.sum",
];

const NOISY_EXTENSIONS: &[&str] = &[
    "min.js",
    "min.css",
    "map",
    "svg",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "ico",
    "webp",
    "woff",
    "woff2",
    "ttf",
    "eot",
    "pdf",
];

/// Returns true if a path is considered noisy / generated / lockfile.
pub fn is_noisy_file(path: &str) -> bool {
    let lower = path.to_lowercase();
    let basename = lower.rsplit('/').next().unwrap_or(&lower);

    if NOISY_FILENAMES.contains(&basename) {
        return true;
    }

    if NOISY_EXTENSIONS.iter().any(|&ext| basename.ends_with(&format!(".{ext}"))) {
        return true;
    }

    if lower.split('/').any(|seg| matches!(seg, "dist" | "build" | "target" | "node_modules" | ".git")) {
        return true;
    }

    false
}

/// Truncates a line to MAX_LINE_CHARS if needed.
fn cap_line(s: &str) -> String {
    if s.chars().count() > MAX_LINE_CHARS {
        let cut: String = s.chars().take(MAX_LINE_CHARS).collect();
        format!("{cut}…")
    } else {
        s.to_string()
    }
}

/// Prepares a compact, noise-free diff summary specifically optimized for small LLMs.
///
/// Output structure:
/// 1. Summary of modified files with additions/deletions counts.
/// 2. Hunk content with only `+` and `-` changes (context lines stripped).
/// 3. Graceful truncation if the character budget is exceeded.
pub fn prepare_diff_for_llm(files: &[FileDiff]) -> String {
    if files.is_empty() {
        return "No changed files.".to_string();
    }

    let mut out = String::with_capacity(MAX_DIFF_CHARS);

    // 1. High-level summary of all changed files
    out.push_str("Modified files:\n");
    let mut relevant_files: Vec<&FileDiff> = Vec::new();
    let mut skipped_noisy: Vec<&str> = Vec::new();

    for file in files {
        if is_noisy_file(&file.path) {
            skipped_noisy.push(&file.path);
            continue;
        }
        if file.binary || file.oversized {
            out.push_str(&format!("- {} (binary/oversized)\n", file.path));
            continue;
        }

        let mut adds = 0;
        let mut dels = 0;
        for hunk in &file.hunks {
            for line in &hunk.lines {
                match line.origin.as_str() {
                    "+" => adds += 1,
                    "-" => dels += 1,
                    _ => {}
                }
            }
        }
        out.push_str(&format!("- {} (+{}, -{})\n", file.path, adds, dels));
        relevant_files.push(file);
    }

    if !skipped_noisy.is_empty() {
        out.push_str(&format!(
            "- (ignored {} lockfile/asset file(s))\n",
            skipped_noisy.len()
        ));
    }
    out.push('\n');

    // 2. Compact diff hunks
    out.push_str("Diff:\n");
    let mut budget_exhausted = false;
    let mut truncated_files: Vec<&str> = Vec::new();

    for file in relevant_files {
        if budget_exhausted {
            truncated_files.push(&file.path);
            continue;
        }

        let file_header = format!("--- {}\n", file.path);
        if out.len() + file_header.len() > MAX_DIFF_CHARS {
            budget_exhausted = true;
            truncated_files.push(&file.path);
            continue;
        }
        out.push_str(&file_header);

        for hunk in &file.hunks {
            if budget_exhausted {
                break;
            }

            // Short hunk header
            let hunk_header = format!("{}\n", hunk.header.trim());
            if out.len() + hunk_header.len() > MAX_DIFF_CHARS {
                budget_exhausted = true;
                break;
            }
            out.push_str(&hunk_header);

            for line in &hunk.lines {
                // Keep only changes (+ and -). Omit context (' ') to save tokens.
                if line.origin != "+" && line.origin != "-" {
                    continue;
                }

                let line_str = format!("{}{}\n", line.origin, cap_line(line.content.trim_end()));
                if out.len() + line_str.len() > MAX_DIFF_CHARS {
                    budget_exhausted = true;
                    break;
                }
                out.push_str(&line_str);
            }
        }
    }

    if budget_exhausted {
        if !truncated_files.is_empty() {
            out.push_str(&format!(
                "\n[Diff truncated to fit token budget. {} remaining file(s) summarized above]\n",
                truncated_files.len()
            ));
        } else {
            out.push_str("\n[Diff truncated to fit token budget]\n");
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::diff::{DiffHunk, DiffLine, FileDiff};
    use crate::git::repo::FileStatusKind;

    fn make_test_diff(path: &str, additions: &[&str], deletions: &[&str]) -> FileDiff {
        let mut lines = Vec::new();
        for &d in deletions {
            lines.push(DiffLine {
                origin: "-".to_string(),
                content: d.to_string(),
                old_lineno: Some(1),
                new_lineno: None,
            });
        }
        for &a in additions {
            lines.push(DiffLine {
                origin: "+".to_string(),
                content: a.to_string(),
                old_lineno: None,
                new_lineno: Some(1),
            });
        }
        FileDiff {
            path: path.to_string(),
            binary: false,
            status: FileStatusKind::Modified,
            old_path: None,
            hunks: vec![DiffHunk {
                header: "@@ -1,3 +1,3 @@".to_string(),
                lines,
            }],
            truncated: false,
            oversized: false,
        }
    }

    #[test]
    fn test_noisy_file_filtering() {
        assert!(is_noisy_file("pnpm-lock.yaml"));
        assert!(is_noisy_file("foo/bar/package-lock.json"));
        assert!(is_noisy_file("Cargo.lock"));
        assert!(is_noisy_file("dist/bundle.js"));
        assert!(is_noisy_file("app/icon.png"));
        assert!(is_noisy_file("app/styles.min.css"));
        assert!(is_noisy_file("src/main.js.map"));

        assert!(!is_noisy_file("src/main.rs"));
        assert!(!is_noisy_file("src/components/RepoView.tsx"));
        assert!(!is_noisy_file("package.json"));
    }

    #[test]
    fn test_prepare_diff_filters_lockfiles() {
        let files = vec![
            make_test_diff("src/App.tsx", &["const x = 1;"], &["const x = 0;"]),
            make_test_diff("pnpm-lock.yaml", &["lockfile change"], &[]),
        ];

        let summary = prepare_diff_for_llm(&files);
        assert!(summary.contains("src/App.tsx (+1, -1)"));
        assert!(summary.contains("ignored 1 lockfile/asset file(s)"));
        assert!(summary.contains("+const x = 1;"));
        assert!(!summary.contains("lockfile change"));
    }

    #[test]
    fn test_prepare_diff_budget_cap() {
        let long_line = "a".repeat(300);
        let additions = vec![long_line.as_str(); 50];
        let files = vec![make_test_diff("src/large.rs", &additions, &[])];

        let summary = prepare_diff_for_llm(&files);
        assert!(summary.len() <= MAX_DIFF_CHARS + 200);
        assert!(summary.contains("truncated"));
    }
}
