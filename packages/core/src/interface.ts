// SetInterface: what app code depends on.

import type { InterfaceDiff, QuestionSetSpec, SetInterface } from "./contracts/spec.js";
import { specQuestions } from "./contracts/spec.js";
import { hashJson } from "./util/canonical-json.js";

/** The interface of a spec: input schema, questions with options or levels, composites and route outputs. */
export function interfaceOf(spec: QuestionSetSpec): SetInterface {
  const questions = specQuestions(spec).map(({ id, question }) => {
    const q: SetInterface["questions"][number] = { id, type: question.type };
    if (question.type === "choice") q.options = Object.keys(question.criteria);
    if (question.type === "score") q.levels = question.criteria.length;
    return q;
  });
  const routeOutputs: string[] = [];
  for (const r of spec.routes ?? []) if (!routeOutputs.includes(r.output)) routeOutputs.push(r.output);
  if (spec.defaultRoute !== undefined && !routeOutputs.includes(spec.defaultRoute)) routeOutputs.push(spec.defaultRoute);
  return {
    inputSchema: spec.input.schema,
    questions,
    composites: (spec.composites ?? []).map((c) => c.id),
    routeOutputs,
  };
}

/** versions.interface_hash: the hash of the canonical SetInterface JSON. */
export function interfaceHash(iface: SetInterface): string {
  return hashJson(iface);
}

type Schema = Record<string, unknown>;

const isObject = (v: unknown): v is Schema => v !== null && typeof v === "object" && !Array.isArray(v);
const typesOf = (s: Schema): string[] | null =>
  s["type"] === undefined ? null : Array.isArray(s["type"]) ? (s["type"] as string[]) : [s["type"] as string];

/** Input schema changes: narrowing is breaking, widening is additive. */
function diffSchema(a: unknown, b: unknown, path: string, out: InterfaceDiff): void {
  if (!isObject(a) || !isObject(b)) return;
  const at = path === "" ? "input" : `input${path}`;
  const ta = typesOf(a);
  const tb = typesOf(b);
  if (tb !== null && (ta === null || ta.some((t) => !tb.includes(t) && !(t === "integer" && tb.includes("number"))))) {
    out.breaking.push(`input type narrowed: ${at}`);
  } else if (ta !== null && (tb === null || tb.some((t) => !ta.includes(t)))) {
    out.additive.push(`input type widened: ${at}`);
  }
  if (Array.isArray(b["enum"])) {
    const be = b["enum"].map((v) => JSON.stringify(v));
    const ae = Array.isArray(a["enum"]) ? a["enum"].map((v) => JSON.stringify(v)) : null;
    if (ae === null || ae.some((v) => !be.includes(v))) out.breaking.push(`input values narrowed: ${at}`);
  }
  const reqA = new Set(Array.isArray(a["required"]) ? (a["required"] as string[]) : []);
  const reqB = new Set(Array.isArray(b["required"]) ? (b["required"] as string[]) : []);
  for (const k of reqB) if (!reqA.has(k)) out.breaking.push(`input field now required: ${at}.${k}`);
  for (const k of reqA) if (!reqB.has(k)) out.additive.push(`input field now optional: ${at}.${k}`);
  const pa = isObject(a["properties"]) ? a["properties"] : {};
  const pb = isObject(b["properties"]) ? b["properties"] : {};
  for (const k of Object.keys(pa)) {
    if (Object.hasOwn(pb, k)) diffSchema(pa[k], pb[k], `${path}.${k}`, out);
    else if (b["additionalProperties"] === false) out.breaking.push(`input field removed: ${at}.${k}`);
  }
  for (const k of Object.keys(pb)) if (!Object.hasOwn(pa, k)) out.additive.push(`input field added: ${at}.${k}`);
  if (a["additionalProperties"] !== false && b["additionalProperties"] === false) {
    out.breaking.push(`input no longer accepts extra fields: ${at}`);
  }
  if (a["items"] !== undefined || b["items"] !== undefined) diffSchema(a["items"] ?? {}, b["items"] ?? {}, `${path}[]`, out);
}

/**
 * What changed from interface `a` to `b`. Breaking: a question, option, composite or route output
 * removed, a type or level count changed, or the input schema narrowed. Additive: anything new or
 * a wider input schema.
 */
export function diffInterface(a: SetInterface, b: SetInterface): InterfaceDiff {
  const out: InterfaceDiff = { breaking: [], additive: [] };
  const qa = new Map(a.questions.map((q) => [q.id, q]));
  const qb = new Map(b.questions.map((q) => [q.id, q]));
  for (const [id, q] of qa) {
    const nq = qb.get(id);
    if (nq === undefined) {
      out.breaking.push(`question removed: ${id}`);
      continue;
    }
    if (nq.type !== q.type) {
      out.breaking.push(`question type changed: ${id} (${q.type} to ${nq.type})`);
      continue;
    }
    for (const o of q.options ?? []) if (!(nq.options ?? []).includes(o)) out.breaking.push(`choice option removed: ${id}.${o}`);
    for (const o of nq.options ?? []) if (!(q.options ?? []).includes(o)) out.additive.push(`choice option added: ${id}.${o}`);
    if (q.levels !== nq.levels) out.breaking.push(`score levels changed: ${id} (${q.levels} to ${nq.levels})`);
  }
  for (const id of qb.keys()) if (!qa.has(id)) out.additive.push(`question added: ${id}`);
  for (const c of a.composites) if (!b.composites.includes(c)) out.breaking.push(`composite removed: ${c}`);
  for (const c of b.composites) if (!a.composites.includes(c)) out.additive.push(`composite added: ${c}`);
  for (const r of a.routeOutputs) if (!b.routeOutputs.includes(r)) out.breaking.push(`route output removed: ${r}`);
  for (const r of b.routeOutputs) if (!a.routeOutputs.includes(r)) out.additive.push(`route output added: ${r}`);
  diffSchema(a.inputSchema, b.inputSchema, "", out);
  return out;
}
