// The dogfood sets in .bandwise/sets/: every spec validates, has no lint error, and runs
// with status ok under `bandwise run --local` on each of its example and borderline states.

import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SET_EVENTS } from "../hooks-install.js";
import { main } from "../main.js";

const ROOT = fileURLToPath(new URL("../../../../.bandwise/", import.meta.url));
const sets = readdirSync(`${ROOT}sets`).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));

describe("dogfood sets", () => {
  it("are the agent pack, each with a known hook event", () => {
    expect(sets.sort()).toEqual(Object.keys(SET_EVENTS).sort());
  });

  for (const set of sets) {
    const states = readdirSync(`${ROOT}states/${set}`).filter((f) => f.endsWith(".json"));
    it(`${set} has example and borderline states`, () => {
      expect(states.some((s) => s.startsWith("example-"))).toBe(true);
      expect(states.some((s) => s.startsWith("borderline-"))).toBe(true);
    });
    it.each(states)(`${set} runs locally on %s`, async (state) => {
      const out = await main(["run", "--local", `${ROOT}sets/${set}.json`, `${ROOT}states/${set}/${state}`, "--json", "--rollout", "shadow"]);
      expect(out.exitCode).toBe(0);
      expect(JSON.parse(out.stdout)).toMatchObject({ status: "ok", rollout: "shadow" });
      expect(out.stderr).not.toMatch(/^error /m);
    });
  }
});
