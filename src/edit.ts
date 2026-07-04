import { diff_match_patch } from "diff-match-patch";
import type { OtUpdate } from "./socket.js";

const dmp = new diff_match_patch();

/**
 * Computes a list of ShareJS `text0` OT operations (insertions/deletions/skips)
 * that transform `oldText` into `newText`.
 */
export function computeOtOps(oldText: string, newText: string): OtUpdate["op"] {
  const diffs = dmp.diff_main(oldText, newText);
  dmp.diff_cleanupSemantic(diffs);

  const ops: NonNullable<OtUpdate["op"]> = [];
  let pos = 0;

  for (const [opType, text] of diffs) {
    if (opType === 0) {
      // EQUAL
      pos += text.length;
    } else if (opType === -1) {
      // DELETE
      ops.push({ p: pos, d: text });
      // Note: Do NOT advance `pos` for a deletion, because the character
      // is removed from the position `p`, meaning the next operation
      // still happens at the same index in the "current" string state.
    } else if (opType === 1) {
      // INSERT
      ops.push({ p: pos, i: text });
      pos += text.length;
    }
  }

  return ops;
}
