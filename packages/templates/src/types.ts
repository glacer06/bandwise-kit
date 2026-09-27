// The shape of one template in the pack. Pure data: a spec plus what a person or an agent needs to
// pick it, adapt it and try it.

import type { Pattern, QuestionSetSpec } from "@bandwise/core";

/** A state that shows the template doing its job. */
export interface TemplateExample {
  /** Short name, for example "Contract approval from a known contact". */
  name: string;
  /** What a person would expect the set to decide, in plain words. Not a recorded model answer. */
  expect: string;
  state: Record<string, unknown>;
}

/** A state near the line for one question, and why it is hard. Use it to test the wording. */
export interface BorderlineCase {
  why: string;
  state: Record<string, unknown>;
}

export interface Template {
  /** Stable id, also the file name the find-decisions skill copies (`<id>.spec.json`). */
  id: string;
  title: string;
  /** The job in one line. */
  job: string;
  /** The pattern advisor's tag, which picked the spec skeleton. */
  pattern: Pattern;
  whenToUse: string[];
  whenNotToUse: string[];
  /** How app code should read the result, and anything else to set up around the set. */
  notes: string[];
  spec: QuestionSetSpec;
  /** Two or three states. */
  examples: TemplateExample[];
  /** One borderline case per question id in the spec. */
  borderline: Record<string, BorderlineCase>;
}

/** Identity helper that keeps each template file type checked. */
export function defineTemplate(t: Template): Template {
  return t;
}
