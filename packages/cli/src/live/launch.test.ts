import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../main.js";
import { readReceipts } from "../receipts/index.js";
import { type LaunchCommand, type SpawnFn, launchArgs, launchEnv, loadProfiles, parseProfiles, runLaunchPrint, runLaunchStart, startProgram, taskFromArgs } from "./index.js";
import { liveTransport } from "./transport.js";

const at = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
const SET = at("../../../../.bandwise/sets/launch-profile.json");
const PROFILES = at("../../../../.bandwise/profiles.json");
const KEY = "ts_test_key_for_unit_tests_only_0000";
const ENV = { TYPESAFE_API_KEY: KEY };
const tmp = (): string => mkdtempSync(join(tmpdir(), "bandwise-launch-"));

const OPTIONS = ["light", "standard", "deep", "deep_review", "unclear"];

/** A fetch that answers the launch-profile set with `choice` at `confidence`. */
function answering(choice: string, confidence: number, opts: { delayMs?: number } = {}) {
  const sent: Array<{ state: Record<string, unknown> }> = [];
  const fetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    sent.push(JSON.parse(String(init?.body)) as { state: Record<string, unknown> });
    if (opts.delayMs !== undefined) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, opts.delayMs);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    }
    const rest = (1 - confidence) / (OPTIONS.length - 1);
    const probabilities = Object.fromEntries(OPTIONS.map((o) => [o, o === choice ? confidence : rest]));
    const body = { model: "jev-1.13.0", answers: { profile: { type: "choice", choice, confidence, probabilities } }, usage: { input_tokens: 300, output_tokens: 20 } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", "x-typesafe-request-id": "req_unit" } });
  };
  return { fetch, sent };
}

const cmd = (over: Partial<LaunchCommand> = {}): LaunchCommand => ({
  setPath: SET,
  profilesPath: PROFILES,
  rollout: "shadow",
  provider: "typesafe",
  // Generous, so a loaded test machine never turns a normal answer into a fallback. The timeout
  // test sets its own.
  timeoutMs: 20_000,
  receiptsPath: join(tmp(), "r.jsonl"),
  task: "Debug why sign-ins fail after the token refresh in production.",
  ...over,
});

describe("the profiles file", () => {
  it("accepts the reviewed file in this repo", () => {
    const p = loadProfiles(PROFILES);
    expect(p.ok && p.value.default).toBe("standard");
    expect(p.ok && Object.keys(p.value.profiles).sort()).toEqual(["deep", "deep_review", "light", "standard"]);
  });

  it("refuses anything but a program, a default and model plus effort per session, naming the field", () => {
    const good = { program: "claude", default: "a", profiles: { a: { sessions: [{ model: "sonnet", effort: "medium" }] } } };
    const field = (raw: unknown): string | null => {
      const r = parseProfiles(raw);
      return r.ok ? null : r.field;
    };
    expect(field(good)).toBeNull();
    expect(field({ ...good, command: "rm -rf /" })).toBe("command");
    expect(field({ ...good, program: "bash" })).toBe("program");
    expect(field({ ...good, default: "b" })).toBe("default");
    expect(field({ ...good, profiles: { "a b": good.profiles.a } })).toBe("profiles.a b");
    expect(field({ ...good, profiles: { a: { sessions: [], flags: "--x" } } })).toBe("profiles.a.flags");
    expect(field({ ...good, profiles: { a: { sessions: [] } } })).toBe("profiles.a.sessions");
    const s = { model: "sonnet", effort: "medium" };
    expect(field({ ...good, profiles: { a: { sessions: [s, s, s] } } })).toBe("profiles.a.sessions");
    expect(field({ ...good, profiles: { a: { sessions: [{ ...s, effort: "ultra" }] } } })).toBe("profiles.a.sessions[0].effort");
    expect(field({ ...good, profiles: { a: { sessions: [{ ...s, model: "sonnet --dangerously-skip-permissions" }] } } })).toBe("profiles.a.sessions[0].model");
    expect(field({ ...good, profiles: { a: { sessions: [{ ...s, permissionMode: "bypass" }] } } })).toBe("profiles.a.sessions[0].permissionMode");
  });
});

describe("bandwise launch --print", () => {
  it("in shadow prints the default and records what the set picked, never the task", async () => {
    const { fetch, sent } = answering("deep", 0.95);
    const c = cmd();
    const out = await runLaunchPrint(c, { env: ENV, transport: () => liveTransport({ fetch }) });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ profile: "standard", sessions: [{ model: "sonnet", effort: "medium" }], picked: "deep", rollout: "shadow" });
    expect(out.stderr).toBe("");
    expect(sent[0]?.state).toEqual({ task: c.task });
    const { receipts } = readReceipts(c.receiptsPath);
    expect(receipts[0]).toMatchObject({ set: "launch-profile", source: "launch", rollout: "shadow", acted: false, launch: { profile: "standard", picked: "deep" } });
    expect(readFileSync(c.receiptsPath, "utf8")).not.toContain("sign-ins");
  });

  it("in controlled uses a high band pick, and only that", async () => {
    const high = await runLaunchPrint(cmd({ rollout: "controlled" }), { env: ENV, transport: () => liveTransport({ fetch: answering("deep_review", 0.95).fetch }) });
    expect(JSON.parse(high.stdout)).toEqual({
      profile: "deep_review",
      sessions: [
        { model: "opus", effort: "high" },
        { model: "sonnet", effort: "medium" },
      ],
      picked: "deep_review",
      rollout: "controlled",
    });
    const medium = await runLaunchPrint(cmd({ rollout: "controlled" }), { env: ENV, transport: () => liveTransport({ fetch: answering("deep", 0.55).fetch }) });
    expect(JSON.parse(medium.stdout)).toMatchObject({ profile: "standard", picked: "deep" });
    // light needs a higher bar than the other options.
    const light = await runLaunchPrint(cmd({ rollout: "controlled" }), { env: ENV, transport: () => liveTransport({ fetch: answering("light", 0.75).fetch }) });
    expect(JSON.parse(light.stdout)).toMatchObject({ profile: "standard", picked: "light" });
  });

  it("treats an answer that is not a profile id as no pick", async () => {
    const out = await runLaunchPrint(cmd({ rollout: "controlled" }), { env: ENV, transport: () => liveTransport({ fetch: answering("unclear", 0.95).fetch }) });
    expect(JSON.parse(out.stdout)).toMatchObject({ profile: "standard", picked: null });
  });

  it("sends the task through the same redaction as the hooks", async () => {
    const { fetch, sent } = answering("standard", 0.9);
    const secret = ["sk-", "ant-", "abcdefghijklmnopqrstuvwxyz0123456789"].join("");
    await runLaunchPrint(cmd({ task: `Rotate the key ${secret} in the config` }), { env: ENV, transport: () => liveTransport({ fetch }) });
    expect(JSON.stringify(sent[0]?.state)).not.toContain(secret);
  });

  it("falls back to the default, and says why, with no key, no task, a bad set or a timeout", async () => {
    const none = answering("deep", 0.95);
    const noKey = await runLaunchPrint(cmd({ rollout: "controlled" }), { env: {}, transport: () => liveTransport({ fetch: none.fetch }) });
    expect(JSON.parse(noKey.stdout)).toMatchObject({ profile: "standard", picked: null });
    expect(noKey.stderr).toBe('bandwise launch: TYPESAFE_API_KEY is not set; using the default profile "standard".');
    expect(none.sent).toHaveLength(0);

    const empty = await runLaunchPrint(cmd({ task: "  " }), { env: ENV, transport: () => liveTransport({ fetch: none.fetch }) });
    expect(empty.stderr).toContain("no task was given");

    const badSet = await runLaunchPrint(cmd({ setPath: join(tmp(), "missing.json") }), { env: ENV, transport: () => liveTransport({ fetch: none.fetch }) });
    expect(badSet.exitCode).toBe(0);
    expect(badSet.stderr).toContain("could not be loaded");

    const c = cmd({ rollout: "controlled", timeoutMs: 100 });
    const slow = await runLaunchPrint(c, { env: ENV, transport: () => liveTransport({ fetch: answering("deep", 0.95, { delayMs: 2000 }).fetch }) });
    expect(JSON.parse(slow.stdout)).toMatchObject({ profile: "standard" });
    expect(slow.stderr).toContain("did not answer within 100 ms");
    expect(readReceipts(c.receiptsPath).receipts[0]).toMatchObject({ status: "timeout", launch: { profile: "standard", picked: null } });
  });

  it("refuses an invalid profiles file, naming the field", async () => {
    const path = join(tmp(), "profiles.json");
    writeFileSync(path, JSON.stringify({ program: "claude", default: "a", profiles: { a: { sessions: [{ model: "sonnet", effort: "ultra" }] } } }));
    const out = await runLaunchPrint(cmd({ profilesPath: path }), { env: ENV, transport: () => liveTransport({ fetch: answering("deep", 0.95).fetch }) });
    expect(out).toMatchObject({ exitCode: 1, stdout: "" });
    expect(out.stderr).toContain("profiles.a.sessions[0].effort");
  });

  it("from the command line: --print takes the task from --task or stdin, and no agent arguments", async () => {
    const extra = await main(["launch", "--print", "--task", "x", "--", "fix it"]);
    expect(extra.exitCode).toBe(1);
    expect(extra.stderr).toContain("takes no agent arguments");

    const base = ["launch", "--print", "--set", SET, "--profiles", PROFILES, "--rollout", "controlled", "--timeout-ms", "20000", "--receipts", join(tmp(), "r.jsonl")];
    const flag = await main([...base, "--task", "Rename foo to bar everywhere"], { env: ENV, fetch: answering("light", 0.95).fetch });
    expect(JSON.parse(flag.stdout)).toMatchObject({ profile: "light", sessions: [{ model: "sonnet", effort: "low" }] });

    const piped = answering("deep", 0.95);
    const stdin = await main(base, { env: ENV, fetch: piped.fetch, stdin: async () => "Design the new billing schema" });
    expect(JSON.parse(stdin.stdout)).toMatchObject({ profile: "deep" });
    expect(piped.sent[0]?.state).toEqual({ task: "Design the new billing schema" });
  });

  it("prints the default when live mode cannot load", async () => {
    const out = await main(["launch", "--print", "--profiles", PROFILES, "--task", "x"], {
      loadLive: async () => {
        throw new Error("Cannot find package '@typesafe-ai/sdk'");
      },
    });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ profile: "standard", picked: null });
    expect(out.stderr).toContain("live mode could not load");
  });
});

type Started = { program: string; args: readonly string[]; env: Readonly<Record<string, string | undefined>> };

/** A start function that records what it was asked to run and returns an exit code. */
function recorder(exitCode = 0) {
  const calls: Started[] = [];
  const start = async (program: "claude", args: readonly string[], env: Readonly<Record<string, string | undefined>>) => {
    calls.push({ program, args, env });
    return { ok: true as const, exitCode };
  };
  return { start, calls };
}

describe("bandwise launch (starts the agent)", () => {
  it("adds only --model and --effort and passes every other argument through unchanged", () => {
    const pick = { profile: "deep", sessions: [{ model: "opus", effort: "high" as const }], picked: "deep", rollout: "controlled" as const };
    const passthrough = ["--permission-mode", "plan", "--allowedTools", "Bash(git *)", "--disallowedTools", "Edit", "--settings", "s.json", "--dangerously-skip-permissions", "-p", "fix the flaky test; rm -rf / $(whoami)"];
    const { args, skipped } = launchArgs(pick, passthrough);
    expect(args).toEqual(["--model", "opus", "--effort", "high", ...passthrough]);
    expect(skipped).toEqual([]);
    // A flag the person passed wins; the profile's value is not added.
    expect(launchArgs(pick, ["--model", "sonnet", "hi"])).toEqual({ args: ["--effort", "high", "--model", "sonnet", "hi"], skipped: ["--model"] });
    expect(launchArgs(pick, ["--effort=low"]).args).toEqual(["--model", "opus", "--effort=low"]);
  });

  it("takes the task only from right after -p, or from a lone argument, never from an option's value", () => {
    expect(taskFromArgs(["-p", "Rename foo"])).toBe("Rename foo");
    expect(taskFromArgs(["--print", "Rename foo"])).toBe("Rename foo");
    // Options after the prompt, with a value or without one.
    expect(taskFromArgs(["-p", "Rename foo", "--output-format", "json"])).toBe("Rename foo");
    expect(taskFromArgs(["-p", "Rename foo", "--verbose"])).toBe("Rename foo");
    // Options before -p.
    expect(taskFromArgs(["--output-format", "json", "-p", "Rename foo"])).toBe("Rename foo");
    // Interactive `claude "prompt"`.
    expect(taskFromArgs(["Rename foo"])).toBe("Rename foo");
    // Anything else is no task, so an option's value is never taken for the prompt.
    expect(taskFromArgs(["--resume", "abc"])).toBe("");
    expect(taskFromArgs(["--model", "opus", "Rename foo"])).toBe("");
    expect(taskFromArgs(["-p", "--verbose"])).toBe("");
    expect(taskFromArgs(["-p"])).toBe("");
    expect(taskFromArgs(["--continue"])).toBe("");
    expect(taskFromArgs([])).toBe("");
  });

  it("in shadow starts claude on the default, with the profile variables and the exit code back", async () => {
    const { start, calls } = recorder(3);
    const out = await runLaunchStart(cmd(), ["-p", "hello"], { env: { ...ENV, HOME: "/home/nick" }, transport: () => liveTransport({ fetch: answering("deep", 0.95).fetch }), start });
    expect(out.exitCode).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.program).toBe("claude");
    expect(calls[0]?.args).toEqual(["--model", "sonnet", "--effort", "medium", "-p", "hello"]);
    expect(calls[0]?.env).toMatchObject({ HOME: "/home/nick", BANDWISE_LAUNCH_PROFILE: "standard", BANDWISE_LAUNCH_PICKED: "deep" });
  });

  it("in controlled starts one session on a high band pick and reports the second", async () => {
    const { start, calls } = recorder();
    const out = await runLaunchStart(cmd({ rollout: "controlled" }), [], { env: ENV, transport: () => liveTransport({ fetch: answering("deep_review", 0.95).fetch }), start });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(["--model", "opus", "--effort", "high"]);
    expect(out.stderr).toContain('profile "deep_review" names a second session (sonnet, medium)');
  });

  it("still starts the session on the default when Bandwise fails, and refuses a bad profiles file", async () => {
    const { start, calls } = recorder();
    const noKey = await runLaunchStart(cmd({ rollout: "controlled" }), ["hi"], { env: {}, transport: () => liveTransport({ fetch: answering("deep", 0.95).fetch }), start });
    expect(noKey.exitCode).toBe(0);
    expect(calls[0]?.args).toEqual(["--model", "sonnet", "--effort", "medium", "hi"]);
    expect(noKey.stderr).toContain("TYPESAFE_API_KEY is not set");

    const path = join(tmp(), "profiles.json");
    writeFileSync(path, JSON.stringify({ program: "bash", default: "a", profiles: { a: { sessions: [{ model: "sonnet", effort: "low" }] } } }));
    const bad = await runLaunchStart(cmd({ profilesPath: path }), ["hi"], { env: ENV, transport: () => liveTransport({ fetch: answering("deep", 0.95).fetch }), start });
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("program");
    expect(calls).toHaveLength(1);
  });

  it("says so when claude is not installed", async () => {
    const start = async () => ({ ok: false as const, message: "claude was not found on your PATH" });
    const out = await runLaunchStart(cmd(), [], { env: {}, transport: () => liveTransport({ fetch: answering("deep", 0.95).fetch }), start });
    expect(out.exitCode).toBe(127);
    expect(out.stderr).toContain("claude was not found on your PATH");
  });

  it("from the command line: everything after -- goes to the agent, --help there included", async () => {
    const { start, calls } = recorder();
    const out = await main(["launch", "--profiles", PROFILES, "--set", SET, "--timeout-ms", "20000", "--receipts", join(tmp(), "r.jsonl"), "--", "--help"], {
      env: ENV,
      fetch: answering("deep", 0.95).fetch,
      start,
    });
    expect(out.exitCode).toBe(0);
    expect(calls[0]?.args).toEqual(["--model", "sonnet", "--effort", "medium", "--help"]);
  });

  it("picks from the prompt after -- when there is no --task", async () => {
    const { start, calls } = recorder();
    const picker = answering("light", 0.95);
    const out = await main(
      ["launch", "--profiles", PROFILES, "--set", SET, "--rollout", "controlled", "--timeout-ms", "20000", "--receipts", join(tmp(), "r.jsonl"), "--", "-p", "Rename getUser to fetchUser everywhere"],
      { env: ENV, fetch: picker.fetch, start },
    );
    expect(out.exitCode).toBe(0);
    expect(picker.sent[0]?.state).toEqual({ task: "Rename getUser to fetchUser everywhere" });
    expect(calls[0]?.args).toEqual(["--model", "sonnet", "--effort", "low", "-p", "Rename getUser to fetchUser everywhere"]);
    expect(calls[0]?.env).toMatchObject({ BANDWISE_LAUNCH_PROFILE: "light", BANDWISE_LAUNCH_PICKED: "light" });
  });

  it("picks from the prompt, not from an option after it, and passes every argument through", async () => {
    const base = ["launch", "--profiles", PROFILES, "--set", SET, "--rollout", "controlled", "--timeout-ms", "20000", "--receipts", join(tmp(), "r.jsonl"), "--"];
    for (const after of [["--output-format", "json"], ["--verbose"]]) {
      const { start, calls } = recorder();
      const picker = answering("light", 0.95);
      const passthrough = ["-p", "Rename getUser to fetchUser everywhere", ...after];
      await main([...base, ...passthrough], { env: ENV, fetch: picker.fetch, start });
      expect(picker.sent[0]?.state).toEqual({ task: "Rename getUser to fetchUser everywhere" });
      expect(calls[0]?.args).toEqual(["--model", "sonnet", "--effort", "low", ...passthrough]);
    }
  });

  it("uses --task over the prompt after -p", async () => {
    const { start, calls } = recorder();
    const picker = answering("deep", 0.95);
    await runLaunchStart(cmd({ task: "Design the billing schema" }), ["-p", "Rename foo", "--output-format", "json"], { env: ENV, transport: () => liveTransport({ fetch: picker.fetch }), start });
    expect(picker.sent[0]?.state).toEqual({ task: "Design the billing schema" });
    expect(calls[0]?.args).toEqual(["--model", "sonnet", "--effort", "medium", "-p", "Rename foo", "--output-format", "json"]);
  });

  it("with no prompt it can find, starts the default and says to pass --task", async () => {
    const { start, calls } = recorder();
    const picker = answering("light", 0.95);
    const warned: string[] = [];
    await runLaunchStart(cmd({ task: "", rollout: "controlled" }), ["--resume", "abc"], { env: ENV, transport: () => liveTransport({ fetch: picker.fetch }), start, warn: (l) => warned.push(l) });
    expect(picker.sent).toHaveLength(0);
    expect(calls[0]?.args).toEqual(["--model", "sonnet", "--effort", "medium", "--resume", "abc"]);
    expect(warned.join("\n")).toContain("no task was given (pass --task, or put the prompt right after -p)");
  });

  it("shows its notices before the agent starts, not when it ends", async () => {
    const events: string[] = [];
    let release: (() => void) | undefined;
    const start = (_program: "claude", _args: readonly string[]) => {
      events.push("start");
      // The session stays open until the test lets it end.
      return new Promise<{ ok: true; exitCode: number }>((resolve) => {
        release = () => resolve({ ok: true, exitCode: 0 });
      });
    };
    const running = main(["launch", "--profiles", PROFILES, "--set", SET, "--rollout", "controlled", "--timeout-ms", "20000", "--receipts", join(tmp(), "r.jsonl"), "--", "hi"], {
      env: {},
      start,
      warn: (line) => events.push(`warn: ${line}`),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toEqual(['warn: bandwise launch: TYPESAFE_API_KEY is not set; using the default profile "standard".', "start"]);
    release?.();
    const out = await running;
    expect(out.stderr).toBe("");

    // The second-session note, too.
    const seen: string[] = [];
    await runLaunchStart(cmd({ rollout: "controlled" }), [], {
      env: ENV,
      transport: () => liveTransport({ fetch: answering("deep_review", 0.95).fetch }),
      warn: (line) => seen.push(line),
      start: async () => {
        seen.push("start");
        return { ok: true, exitCode: 0 };
      },
    });
    expect(seen[seen.length - 1]).toBe("start");
    expect(seen[0]).toContain("names a second session");
  });

  it("gives the agent the environment it would get from the same shell, plus the two profile variables", () => {
    // A key in the shell is inherited, as it is when claude starts directly, so hooks in the session work.
    const withKey = launchEnv({ BANDWISE_LAUNCH_PROFILE: "standard", BANDWISE_LAUNCH_PICKED: "none" }, { PATH: "/bin", TYPESAFE_API_KEY: KEY });
    expect(withKey).toEqual({ PATH: "/bin", TYPESAFE_API_KEY: KEY, BANDWISE_LAUNCH_PROFILE: "standard", BANDWISE_LAUNCH_PICKED: "none" });
    // No key in the shell means none in the session: launch never adds one.
    const without = launchEnv({ BANDWISE_LAUNCH_PROFILE: "standard", BANDWISE_LAUNCH_PICKED: "none" }, { PATH: "/bin" });
    expect(Object.keys(without).sort()).toEqual(["BANDWISE_LAUNCH_PICKED", "BANDWISE_LAUNCH_PROFILE", "PATH"]);
  });

  it("starts the default when live mode cannot load", async () => {
    const { start, calls } = recorder(0);
    const out = await main(["launch", "--profiles", PROFILES, "--", "hi"], {
      start,
      loadLive: async () => {
        throw new Error("Cannot find package '@typesafe-ai/sdk'");
      },
    });
    expect(out.exitCode).toBe(0);
    expect(calls[0]?.args).toEqual(["--model", "sonnet", "--effort", "medium", "hi"]);
    expect(calls[0]?.env).toMatchObject({ BANDWISE_LAUNCH_PROFILE: "standard", BANDWISE_LAUNCH_PICKED: "none" });
    expect(out.stderr).toContain("live mode could not load");
  });
});

describe("live/spawn.ts", () => {
  /** A fake child process and the options it was started with. */
  function fakeSpawn(finish: (child: EventEmitter & { kill: (s: string) => boolean; killed: string[] }) => void) {
    const seen: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
    const spawn: SpawnFn = (command, args, options) => {
      seen.push({ command, args, options });
      const child = Object.assign(new EventEmitter(), { killed: [] as string[], kill: (s: string) => (child.killed.push(s), true) });
      setImmediate(() => finish(child));
      return child as unknown as ReturnType<SpawnFn>;
    };
    return { spawn, seen };
  }
  const signals = () => {
    const handlers = new Map<string, () => void>();
    return {
      handlers,
      on: ((e: string, h: () => void) => (handlers.set(e, h), process)) as NodeJS.Process["on"],
      off: ((e: string) => (handlers.delete(e), process)) as NodeJS.Process["off"],
    };
  };

  it("starts the program with an argument array, no shell, the terminal and the given env", async () => {
    const { spawn, seen } = fakeSpawn((c) => c.emit("exit", 0, null));
    const out = await startProgram("claude", ["--model", "opus", "a; rm -rf /"], { A: "1" }, { spawn, signals: signals() });
    expect(out).toEqual({ ok: true, exitCode: 0 });
    expect(seen[0]).toEqual({ command: "claude", args: ["--model", "opus", "a; rm -rf /"], options: { stdio: "inherit", shell: false, env: { A: "1" } } });
  });

  it("returns the exit code, 128 plus the signal number, or a clear error", async () => {
    expect(await startProgram("claude", [], {}, { spawn: fakeSpawn((c) => c.emit("exit", 7, null)).spawn, signals: signals() })).toEqual({ ok: true, exitCode: 7 });
    expect(await startProgram("claude", [], {}, { spawn: fakeSpawn((c) => c.emit("exit", null, "SIGTERM")).spawn, signals: signals() })).toEqual({ ok: true, exitCode: 143 });
    const missing = await startProgram("claude", [], {}, { spawn: fakeSpawn((c) => c.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }))).spawn, signals: signals() });
    expect(missing).toEqual({ ok: false, message: "claude was not found on your PATH" });
  });

  it("leaves Ctrl-C to the agent, passes SIGTERM on, and cleans up its handlers", async () => {
    const sig = signals();
    let child: { killed: string[] } | undefined;
    const { spawn } = fakeSpawn((c) => {
      child = c;
      sig.handlers.get("SIGINT")?.();
      sig.handlers.get("SIGTERM")?.();
      c.emit("exit", 130, null);
    });
    await startProgram("claude", [], {}, { spawn, signals: sig });
    expect(child?.killed).toEqual(["SIGTERM"]);
    expect(sig.handlers.size).toBe(0);
  });
});
