use crate::error::AppResult;
use git2::{Repository, Sort};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Serialize)]
pub struct CommitNode {
    pub id: String,
    pub short_id: String,
    pub summary: String,
    pub author: String,
    pub email: String,
    pub time: i64,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
    /// Horizontal column the commit dot sits in. Filled by `assign_lanes`.
    pub lane: usize,
    /// Color bucket for the lane (frontend maps this to a palette entry).
    pub color: usize,
}

/// Walk every ref, collect up to `limit` commits in topological+time order, and
/// hand them to the lane assigner that gives the graph its shape.
pub fn commit_graph(repo: &Repository, limit: usize) -> AppResult<Vec<CommitNode>> {
    // oid -> branch/tag names pointing at it, so the UI can draw ref chips.
    let mut ref_map: HashMap<String, Vec<String>> = HashMap::new();
    if let Ok(refs) = repo.references() {
        for r in refs.flatten() {
            if let Some(oid) = r.target() {
                if let Some(name) = r.shorthand() {
                    ref_map.entry(oid.to_string()).or_default().push(name.to_string());
                }
            }
        }
    }

    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
    for r in repo.references()?.flatten() {
        if let Some(oid) = r.target() {
            let _ = walk.push(oid); // seed from all branches/tags, not just HEAD
        }
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
            short_id: oid.to_string()[..7].to_string(),
            summary: commit.summary().unwrap_or_default().to_string(),
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
/// separate and merges read clearly.
///
/// LEARNING-MODE CONTRIBUTION POINT
/// --------------------------------
/// `nodes` arrives newest-first (topological order). `active[i]` holds the id of
/// the commit a lane is currently "waiting for" - i.e. reserved by a child that
/// already drew an edge down into lane `i`.
///
/// The implementation below is intentionally simple: first parent inherits the
/// commit's lane, extra parents (merges) grab fresh lanes, and lanes free up
/// when their commit is reached. It works, but it never *compacts* freed lanes,
/// so long histories drift rightward. Good things to try:
///   - reuse the leftmost freed lane instead of letting columns sprawl
///   - keep a commit's color stable across a whole branch line
///   - bias a merge's second parent toward an already-low lane index
/// Tune this and the whole graph changes character. This is yours to own.
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
