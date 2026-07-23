import { Fragment, type ReactNode } from "react";
import { overlayMatches, type RenderSpan } from "../highlight";
import type { Hit } from "../find";

/// Render one code line's spans into React nodes, shared by the file, blame, and
/// diff views. Syntax tokens become `.token.<type>`, word-diff segments add
/// `.diff-seg`, and find matches wrap in `<mark class="find-hit">` (the active
/// one also `.current`). Empty content renders a single space so the fixed-height
/// row keeps its height. `base` already carries syntax + word-diff; `hits` (if
/// any) are this line's match ranges.
export function renderCode(content: string, base: RenderSpan[], hits?: Hit[]): ReactNode {
  if (content === "") return " ";
  return overlayMatches(base, hits ?? []).map((s, i) => {
    const cls = `${s.type ? `token ${s.type}` : ""}${s.changed ? " diff-seg" : ""}`.trim();
    const inner: ReactNode = cls ? <span className={cls}>{s.text}</span> : s.text;
    return (
      <Fragment key={i}>
        {s.hit ? <mark className={`find-hit${s.current ? " current" : ""}`}>{inner}</mark> : inner}
      </Fragment>
    );
  });
}
