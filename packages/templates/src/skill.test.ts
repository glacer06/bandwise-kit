// Checks the find-decisions Claude Code skill: its frontmatter parses, every file it points at
// exists, and its prose follows the writing rules.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TEMPLATE_IDS } from "./index.js";

const SKILL_DIR = fileURLToPath(new URL("../../../plugins/claude-code/skills/find-decisions/", import.meta.url));
const skillMd = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return markdownFiles(full);
    return e.name.endsWith(".md") ? [full] : [];
  });
}

/** Parse the `---` block at the top of a skill: one `key: value` per line. */
function frontmatter(text: string): Record<string, string> | null {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (match?.[1] === undefined) return null;
  const out: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = /^([a-z][a-z0-9-]*):\s+(.+)$/.exec(line);
    if (kv?.[1] === undefined || kv[2] === undefined) return null;
    out[kv[1]] = kv[2];
  }
  return out;
}

/** Skill-relative paths a Markdown file names, such as `references/decision-guide.md`. */
function referencedPaths(text: string): string[] {
  const found = [...text.matchAll(/`((?:references|templates)\/[^`\s]+)`/g)].map((m) => m[1] ?? "");
  return [...new Set(found)];
}

describe("find-decisions skill", () => {
  it("has frontmatter with a name that matches its folder and a description", () => {
    const fm = frontmatter(skillMd);
    expect(fm).not.toBeNull();
    expect(fm?.["name"]).toBe("find-decisions");
    expect(fm?.["description"]?.length ?? 0).toBeGreaterThan(50);
    expect(fm?.["description"]?.length ?? 0).toBeLessThanOrEqual(1024);
  });

  it("points only at files that exist", () => {
    const files = markdownFiles(SKILL_DIR);
    let checked = 0;
    for (const file of files) {
      for (const path of referencedPaths(readFileSync(file, "utf8"))) {
        if (path.includes("<id>")) {
          for (const id of TEMPLATE_IDS) expect(existsSync(join(SKILL_DIR, path.replace("<id>", id))), `${path} for ${id}`).toBe(true);
        } else {
          expect(existsSync(join(SKILL_DIR, path)), `${relative(SKILL_DIR, file)} names ${path}`).toBe(true);
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(5);
  });

  it("names every template in its decision guide", () => {
    const guide = readFileSync(join(SKILL_DIR, "references/decision-guide.md"), "utf8");
    for (const id of TEMPLATE_IDS) expect(guide, id).toContain(`\`${id}\``);
  });

  it("keeps code on the machine", () => {
    expect(skillMd).toContain("Never send source code");
    expect(skillMd).toContain("bandwise run --local");
  });

  const banned = /\b(leverage|utilize|delve|seamless|robust|comprehensive|cutting-edge|streamline|empower|unlock|furthermore|moreover)\b/i;
  it.each(markdownFiles(SKILL_DIR).map((f) => [relative(SKILL_DIR, f), f]))("%s follows the writing rules", (_name, file) => {
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("—");
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    expect(text).not.toMatch(banned);
  });
});
