// SpecDiff: the output of version.diff and the `diff` field of DryRunResult.
// The interface part is
// diffInterface(from, to).

import { z } from "zod";

import { InterfaceDiff } from "./spec.js";

export const SpecChangeOp = z.enum(["add", "remove", "replace"]);
export type SpecChangeOp = z.infer<typeof SpecChangeOp>;

/** A JSON Pointer (RFC 6901): empty for the root, otherwise "/" followed by segments. */
const JsonPointer = z.string().regex(/^(\/([^~/]|~[01])*)*$/, "must be a JSON Pointer");

export const SpecChange = z
  .object({
    /** JSON Pointer into the spec. */
    path: JsonPointer,
    op: SpecChangeOp,
    /** Absent for "add". */
    before: z.json().optional(),
    /** Absent for "remove". */
    after: z.json().optional(),
  })
  .superRefine((c, ctx) => {
    if (c.op === "add" && c.before !== undefined) {
      ctx.addIssue({ code: "custom", path: ["before"], message: "an add has no before" });
    }
    if (c.op === "remove" && c.after !== undefined) {
      ctx.addIssue({ code: "custom", path: ["after"], message: "a remove has no after" });
    }
    if (c.op !== "remove" && c.after === undefined) {
      ctx.addIssue({ code: "custom", path: ["after"], message: `a ${c.op} needs after` });
    }
    if (c.op !== "add" && c.before === undefined) {
      ctx.addIssue({ code: "custom", path: ["before"], message: `a ${c.op} needs before` });
    }
  });
export type SpecChange = z.infer<typeof SpecChange>;

export const SpecDiff = z.object({
  /** Each side as resolved: "slug@7" or "slug@draft". */
  from: z.string().min(1),
  to: z.string().min(1),
  /** Sorted by path. */
  changes: z.array(SpecChange).superRefine((changes, ctx) => {
    for (let i = 1; i < changes.length; i++) {
      const prev = changes[i - 1];
      const cur = changes[i];
      if (prev !== undefined && cur !== undefined && comparePointers(prev.path, cur.path) > 0) {
        ctx.addIssue({ code: "custom", path: [i, "path"], message: "changes must be sorted by path" });
      }
    }
  }),
  /** diffInterface(from, to). */
  interface: InterfaceDiff,
});
export type SpecDiff = z.infer<typeof SpecDiff>;

/** Order for `SpecDiff.changes`: plain code unit order of the pointer strings. */
export function comparePointers(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
