// Manifest: the body of GET /api/v1/sets/{ref}/manifest (operation set.manifest).
// The manifest never carries instructions, criteria or thresholds. It is a z.object, so parsing
// drops any key not listed here, including those.

import { z } from "zod";

import { Action, Channel, DecisionId, JsonObject, QuestionId, SetId, VersionId } from "./common.js";
import { QuestionTypeId, type ManifestQuestion } from "./question-types.js";

/** One question as the embed kit and codegen see it: `manifestHint(q)` plus the question id. */
export const ManifestQuestionEntry = z.object({
  id: QuestionId,
  type: QuestionTypeId,
  label: z.string(),
  description: z.string().optional(),
  /** Choice option keys, in spec order. */
  options: z.array(z.string()).optional(),
  /** Score level count. */
  levels: z.number().int().positive().optional(),
});
export type ManifestQuestionEntry = z.infer<typeof ManifestQuestionEntry>;

export const Manifest = z.object({
  setId: SetId,
  slug: z.string().min(1),
  /** The version the ref resolved to. */
  version: z.number().int().positive(),
  versionId: VersionId,
  /** How the ref resolved: a channel pointer, a pinned "slug@7", or "slug@draft". */
  channel: Channel,
  /** The spec's model, as written (pinned or moving). */
  model: z.string().min(1),
  interfaceMajor: z.number().int().nonnegative(),
  interfaceHash: z.string().min(1),
  /** The spec's `input.schema` (JSON Schema). */
  inputSchema: JsonObject,
  questions: z.array(ManifestQuestionEntry),
  /** Composite ids. */
  composites: z.array(DecisionId),
  /** Every route output, plus defaultRoute. */
  routeOutputs: z.array(z.string()),
  /** The action enum, so generated code can switch over every action. */
  actions: z.array(Action),
});
export type Manifest = z.infer<typeof Manifest>;

// Compile-time check: an entry minus its id is what a question-type module's manifestHint returns.
type _AssertTrue<T extends true> = T;
type _EntryMatchesHint = _AssertTrue<
  Omit<ManifestQuestionEntry, "id"> extends ManifestQuestion
    ? ManifestQuestion extends Omit<ManifestQuestionEntry, "id">
      ? true
      : false
    : false
>;
