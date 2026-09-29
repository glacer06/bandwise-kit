import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { planHooks } from "./hooks-install.js";
import { main } from "./main.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

describe("bandwise hooks install", () => {
  it("maps each agent pack set to its event and writes nothing", () => {
    const plan = planHooks({ setsDir: ".bandwise/sets", command: "bandwise", rollout: "shadow" }, ["model-tier.json", "done-check.json", "action-risk-gate.json", "other.json", "README.md"]);
    expect(plan.sets).toEqual(["action-risk-gate", "done-check", "model-tier"]);
    expect(plan.ignored).toEqual(["other.json"]);
    expect(Object.keys(plan.settings.hooks).sort()).toEqual(["PreToolUse", "Stop", "UserPromptSubmit"]);
    expect(plan.settings.hooks["PreToolUse"]?.[0]?.matcher).toBe("Bash|Edit|Write|MultiEdit|NotebookEdit");
    expect(plan.settings.hooks["Stop"]?.[0]?.hooks[0]).toEqual({
      type: "command",
      command: 'bandwise hook Stop --set "$CLAUDE_PROJECT_DIR"/.bandwise/sets/done-check.json --rollout shadow',
      timeout: 10,
    });
  });

  it("prints every dogfood set in this repo in shadow", async () => {
    const out = await main(["hooks", "install", "--sets-dir", `${REPO}.bandwise/sets`]);
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain("Nothing was written");
    const commands = Object.values(JSON.parse(out.stdout).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>).flatMap((e) => e.flatMap((x) => x.hooks.map((h) => h.command)));
    expect(commands).toHaveLength(3);
    for (const c of commands) expect(c).toMatch(/--rollout shadow$/);
  });

  it("rejects a bad rollout or subcommand", async () => {
    expect((await main(["hooks", "install", "--rollout", "paused"])).exitCode).toBe(1);
    expect((await main(["hooks", "remove"])).exitCode).toBe(1);
    expect((await main(["hooks", "install", "--sets-dir", "/does/not/exist"])).stderr).toContain("cannot read the sets folder");
  });
});
