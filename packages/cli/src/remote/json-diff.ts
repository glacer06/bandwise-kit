// A structural JSON diff for `bandwise spec diff`. Changes use the SpecDiff change shape from
// openapi.json: a JSON Pointer, an op, and the values before and after.

export interface JsonChange {
  path: string;
  op: "add" | "remove" | "replace";
  before?: unknown;
  after?: unknown;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const escape = (key: string): string => key.replace(/~/g, "~0").replace(/\//g, "~1");

/** Every change that turns `before` into `after`. Object keys are compared in sorted order. */
export function diffJson(before: unknown, after: unknown, at = ""): JsonChange[] {
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => {
      const p = `${at}/${escape(k)}`;
      if (!(k in after)) return [{ path: p, op: "remove" as const, before: before[k] }];
      if (!(k in before)) return [{ path: p, op: "add" as const, after: after[k] }];
      return diffJson(before[k], after[k], p);
    });
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const out: JsonChange[] = [];
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      const p = `${at}/${i}`;
      if (i >= after.length) out.push({ path: p, op: "remove", before: before[i] });
      else if (i >= before.length) out.push({ path: p, op: "add", after: after[i] });
      else out.push(...diffJson(before[i], after[i], p));
    }
    return out;
  }
  return Object.is(before, after) ? [] : [{ path: at, op: "replace", before, after }];
}
