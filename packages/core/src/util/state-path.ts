// Backtick state paths: "email.subject", "items[0].sku".

/** One step of a path: a property name or an array index. */
export type PathSegment = { key: string } | { index: number };

const PATH_PATTERN = /^[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*|\[\d+\])*$/;

/** True when `text` is a well-formed state path. */
export function isStatePath(text: string): boolean {
  return PATH_PATTERN.test(text);
}

/** Split a path into segments, or null when it is not a well-formed path. */
export function parseStatePath(path: string): PathSegment[] | null {
  if (!isStatePath(path)) return null;
  const segments: PathSegment[] = [];
  for (const m of path.matchAll(/([A-Za-z_$][\w$-]*)|\[(\d+)\]/g)) {
    if (m[1] !== undefined) segments.push({ key: m[1] });
    else segments.push({ index: Number(m[2]) });
  }
  return segments;
}

/** The value at a path, or undefined when the path does not resolve. */
export function resolveStatePath(state: unknown, path: string): unknown {
  const segments = parseStatePath(path);
  if (segments === null) return undefined;
  let cur: unknown = state;
  for (const seg of segments) {
    if ("key" in seg) {
      if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
      if (!Object.hasOwn(cur, seg.key)) return undefined;
      cur = (cur as Record<string, unknown>)[seg.key];
    } else {
      if (!Array.isArray(cur) || seg.index >= cur.length) return undefined;
      cur = cur[seg.index];
    }
  }
  return cur;
}

/** Every backtick path in a string, for example "Is `email.subject` urgent?" gives ["email.subject"]. */
export function backtickPaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/`([^`]+)`/g)) {
    const candidate = (m[1] ?? "").trim();
    if (isStatePath(candidate)) out.push(candidate);
  }
  return out;
}

/** Every string inside a structured value (instructions, criteria), depth first. */
export function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((v) => stringsIn(v));
  if (value !== null && typeof value === "object") return Object.values(value).flatMap((v) => stringsIn(v));
  return [];
}
