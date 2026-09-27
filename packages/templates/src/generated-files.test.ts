// The find-decisions skill carries files rendered from this pack (a template index, and each spec
// with an example state). This test fails when they drift. To refresh them after editing a
// template, run `pnpm --filter @bandwise/templates generate`.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TEMPLATES, renderSkillFiles } from "./index.js";

const SKILL_DIR = fileURLToPath(new URL("../../../plugins/claude-code/skills/find-decisions/", import.meta.url));
const write = process.env["BANDWISE_WRITE_GENERATED"] === "1";
const files = renderSkillFiles(TEMPLATES);

describe("find-decisions skill files generated from the pack", () => {
  if (write) {
    rmSync(join(SKILL_DIR, "templates"), { recursive: true, force: true });
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(SKILL_DIR, path)), { recursive: true });
      writeFileSync(join(SKILL_DIR, path), content);
    }
  }

  it.each(Object.keys(files))("%s is up to date", (path) => {
    const full = join(SKILL_DIR, path);
    expect(existsSync(full), `${path} is missing; run pnpm --filter @bandwise/templates generate`).toBe(true);
    expect(readFileSync(full, "utf8")).toBe(files[path]);
  });

  it("has no stale template files", () => {
    const onDisk = readdirSync(join(SKILL_DIR, "templates")).map((f) => `templates/${f}`);
    expect(onDisk.sort()).toEqual(Object.keys(files).filter((p) => p.startsWith("templates/")).sort());
  });
});
