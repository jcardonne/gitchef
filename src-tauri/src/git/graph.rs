use crate::error::AppResult;
use git2::{Repository, Sort};
use serde::Serialize;
use std::collections::HashMap;

/// A ref pointing at a commit, with its type so the UI can badge it (branch /
/// remote / tag / stash / HEAD).
#[derive(Serialize, Clone)]
pub struct RefLabel {
    pub name: String,
    pub kind: String,
}

/// Classify a git reference into a labelled badge, or None to skip it.
fn classify_ref(r: &git2::Reference) -> Option<RefLabel> {
    let full = r.name().unwrap_or("");
    let (kind, name) = if full == "HEAD" {
        ("head", "HEAD".to_string())
    } else if let Some(n) = full.strip_prefix("refs/heads/") {
        ("branch", n.to_string())
    } else if let Some(n) = full.strip_prefix("refs/remotes/") {
        if n.ends_with("/HEAD") {
            return None; // origin/HEAD symbolic pointer is just noise
        }
        ("remote", n.to_string())
    } else if let Some(n) = full.strip_prefix("refs/tags/") {
        ("tag", n.to_string())
    } else if full.starts_with("refs/stash") {
        ("stash", "stash".to_string())
    } else {
        return None;
    };
    Some(RefLabel { name, kind: kind.to_string() })
}

#[derive(Serialize)]
pub struct CommitNode {
    pub id: String,
    pub short_id: String,
    pub summary: String,
    /// Full commit message (subject + body) - used for search.
    pub message: String,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub parents: Vec<String>,
    pub refs: Vec<RefLabel>,
    /// Horizontal column the commit dot sits in. Filled by `assign_lanes`.
    pub lane: usize,
    /// Color bucket for the lane (frontend maps this to a palette entry).
    pub color: usize,
}

/// Walk every ref, collect up to `limit` commits in topological+time order, and
/// hand them to the lane assigner that gives the graph its shape.
pub fn commit_graph(repo: &Repository, limit: usize) -> AppResult<Vec<CommitNode>> {
    // Single pass over refs: map each commit -> ref chips, and collect seed oids
    // for the walk. Peeling to a commit is what makes annotated tags resolve to
    // their commit instead of the tag object (which would break find_commit).
    let mut ref_map: HashMap<String, Vec<RefLabel>> = HashMap::new();
    let mut seeds: Vec<git2::Oid> = Vec::new();
    if let Ok(refs) = repo.references() {
        for r in refs.flatten() {
            if let Ok(commit) = r.peel_to_commit() {
                if let Some(label) = classify_ref(&r) {
                    ref_map.entry(commit.id().to_string()).or_default().push(label);
                }
                seeds.push(commit.id());
            }
        }
    }
    // HEAD isn't returned by references(); add it so the UI can mark the current
    // branch (or show a HEAD badge when detached).
    if let Ok(commit) = repo.head().and_then(|h| h.peel_to_commit()) {
        ref_map
            .entry(commit.id().to_string())
            .or_default()
            .push(RefLabel { name: "HEAD".into(), kind: "head".into() });
    }

    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
    for oid in seeds {
        let _ = walk.push(oid); // seed from all branches/tags, not just HEAD
    }
    let _ = walk.push_head();

    let mut nodes = Vec::new();
    for oid_res in walk {
        if nodes.len() >= limit {
            break;
        }
        let oid = oid_res?;
        let commit = repo.find_commit(oid)?;
        let author = commit.author();
        nodes.push(CommitNode {
            id: oid.to_string(),
            short_id: super::short_oid(oid),
            summary: commit.summary().unwrap_or_default().to_string(),
            message: commit.message().unwrap_or_default().to_string(),
            author: author.name().unwrap_or_default().to_string(),
            email: author.email().unwrap_or_default().to_string(),
            time: commit.time().seconds(),
            parents: commit.parent_ids().map(|p| p.to_string()).collect(),
            refs: ref_map.get(&oid.to_string()).cloned().unwrap_or_default(),
            lane: 0,
            color: 0,
        });
    }

    assign_lanes(&mut nodes);
    Ok(nodes)
}

/// Assign each commit a horizontal lane so parallel branch lines stay visually
/// separate and merges read clearly. `nodes` arrives newest-first; `active[i]`
/// holds the commit a lane is reserved for by an already-seen child. First
/// parent inherits the commit's lane, extra (merge) parents take fresh lanes.
/// Note: freed lanes are not compacted, so very long histories drift rightward.
fn assign_lanes(nodes: &mut [CommitNode]) {
    let mut active: Vec<Option<String>> = Vec::new();

    for node in nodes.iter_mut() {
        // 1. Which lane is this commit in? A child may have reserved one for it.
        let reserved = active.iter().position(|s| s.as_deref() == Some(node.id.as_str()));
        let lane = match reserved {
            Some(i) => {
                // A merge point: several children funnel in. Collapse the extras.
                for slot in active.iter_mut() {
                    if slot.as_deref() == Some(node.id.as_str()) {
                        *slot = None;
                    }
                }
                i
            }
            None => match active.iter().position(|s| s.is_none()) {
                Some(i) => i,
                None => {
                    active.push(None);
                    active.len() - 1
                }
            },
        };

        // 2. Route parents downward: first parent continues this lane; any extra
        //    parents (merge) each claim a free lane.
        if let Some(first) = node.parents.first() {
            active[lane] = Some(first.clone());
            for parent in node.parents.iter().skip(1) {
                match active.iter().position(|s| s.is_none()) {
                    Some(i) => active[i] = Some(parent.clone()),
                    None => active.push(Some(parent.clone())),
                }
            }
        } else {
            active[lane] = None; // root commit: the lane ends here
        }

        node.lane = lane;
        node.color = lane;
    }
}
