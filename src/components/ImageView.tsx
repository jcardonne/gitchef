import { useEffect, useState } from "react";
import * as api from "../api";
import { imageMime } from "../util";

/// One image blob rendered on a checkerboard, fetched as base64. `rev` is a
/// revspec (or null = index when `staged`, else working tree). Empty bytes (the
/// path is absent at `rev`) show a muted placeholder - e.g. the "before" side of
/// a file added in this commit.
export function ImageView({
  repoPath,
  path,
  rev,
  staged,
}: {
  repoPath: string;
  path: string;
  rev: string | null;
  staged: boolean;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    setSrc(null);
    setError("");
    api
      .fileBytes(repoPath, path, rev, staged)
      .then((b) => !cancelled && setSrc(b))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [repoPath, path, rev, staged]);

  if (error) return <div className="image-msg">{error}</div>;
  if (src === null) return <div className="image-msg">Loading…</div>;
  if (src === "") return <div className="image-msg image-none">No image here</div>;
  const mime = imageMime(path) ?? "application/octet-stream";
  return (
    <div className="image-stage">
      <img className="image-checker" src={`data:${mime};base64,${src}`} alt={path} />
    </div>
  );
}

/// Image diff: the old version beside the new one. With no old rev to compare
/// against (e.g. the File tab, or nothing before it), it shows just one image.
export function ImageDiff({
  repoPath,
  path,
  oldRev,
  newRev,
  newStaged,
}: {
  repoPath: string;
  path: string;
  oldRev: string | null;
  newRev: string | null;
  newStaged: boolean;
}) {
  if (oldRev === null) return <ImageView repoPath={repoPath} path={path} rev={newRev} staged={newStaged} />;
  return (
    <div className="image-diff">
      <figure className="image-side">
        <figcaption>Before</figcaption>
        <ImageView repoPath={repoPath} path={path} rev={oldRev} staged={false} />
      </figure>
      <figure className="image-side">
        <figcaption>After</figcaption>
        <ImageView repoPath={repoPath} path={path} rev={newRev} staged={newStaged} />
      </figure>
    </div>
  );
}
