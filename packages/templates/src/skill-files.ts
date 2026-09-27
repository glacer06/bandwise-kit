// The files the find-decisions Claude Code skill carries, rendered from the pack so they never
// drift: a Markdown index of the templates, and each template's spec plus its first example state,
// ready for `bandwise run --local`. Pure: returns paths and contents; a test writes and checks them.

import type { Template } from "./types.js";

/** Path of the index, relative to the skill folder. */
export const SKILL_TEMPLATE_INDEX = "references/templates.md";

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function questionsOf(t: Template): string {
  return t.spec.stages
    .flatMap((s) => Object.entries(s.questions).map(([id, q]) => `\`${id}\` (${q.type})`))
    .join(", ");
}

function routesOf(t: Template): string {
  const outputs = [...(t.spec.routes ?? []).map((r) => r.output), ...(t.spec.defaultRoute === undefined ? [] : [t.spec.defaultRoute])];
  return [...new Set(outputs)].map((o) => `\`${o}\``).join(", ");
}

function stateFieldsOf(t: Template): string {
  const props = t.spec.input.schema["properties"];
  if (props === null || typeof props !== "object" || Array.isArray(props)) return "";
  return Object.keys(props).map((k) => `\`${k}\``).join(", ");
}

function indexMarkdown(templates: readonly Template[]): string {
  const sections = templates.map((t) =>
    [
      `## ${t.id}`,
      "",
      `${t.title}. ${t.job}`,
      "",
      `- Pattern: \`${t.pattern}\``,
      `- Questions: ${questionsOf(t)}`,
      `- State: ${stateFieldsOf(t)}`,
      `- Routes: ${routesOf(t)}`,
      `- Use when: ${t.whenToUse.join(" ")}`,
      `- Not when: ${t.whenNotToUse.join(" ")}`,
      `- Files: \`templates/${t.id}.spec.json\`, \`templates/${t.id}.state.json\``,
    ].join("\n"),
  );
  return [
    "# Template index",
    "",
    "Generated from the template pack. Do not edit by hand.",
    "",
    "Start a draft from the closest template: copy its spec, rename the state fields to match the code, rewrite the instructions and options for the real decision, and keep the policy shape unless the risk differs.",
    "",
    ...sections.flatMap((s) => [s, ""]),
  ].join("\n");
}

/** Every generated skill file, keyed by its path relative to the skill folder. */
export function renderSkillFiles(templates: readonly Template[]): Record<string, string> {
  const files: Record<string, string> = { [SKILL_TEMPLATE_INDEX]: indexMarkdown(templates) };
  for (const t of templates) {
    files[`templates/${t.id}.spec.json`] = json(t.spec);
    files[`templates/${t.id}.state.json`] = json(t.examples[0]?.state ?? {});
  }
  return files;
}
