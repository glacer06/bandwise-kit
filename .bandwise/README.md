# Bandwise on Bandwise

These are the question sets that run as Claude Code hooks on this repository. Each one is a copy of a template from the agent pack, kept here so a change to a question or a threshold is an edit and a commit, reviewed like code.

| Set | Hook event | What it decides |
|---|---|---|
| `sets/done-check.json` | `Stop` | Is the request finished, or is work left, a claim unchecked or work nobody asked for (logged only)? |
| `sets/action-risk-gate.json` | `PreToolUse` (Bash, Edit, Write) | Should a person confirm this command or file change first? |
| `sets/model-tier.json` | `UserPromptSubmit` | Is the task mechanical, standard or hard? |
| `sets/launch-profile.json` | none: `bandwise launch` | Which profile in `profiles.json` should a new session start with? |

Every set starts in `shadow`. It runs, writes a receipt to `~/.bandwise/receipts.jsonl` and changes nothing in the session. The rollout stage is the `--rollout` flag on each hook command, not a field in the spec.

`states/<set>/` holds example and borderline states for each set. CI runs every one of them with `bandwise run --local`, so a spec that stops validating fails the build.

To print the hook entries for `.claude/settings.json`:

```sh
pnpm bandwise hooks install --command 'pnpm -s --dir "$CLAUDE_PROJECT_DIR" bandwise'
```

It writes nothing. Review the output and paste it in yourself.

`profiles.json` is the launch allowlist: the agent program, a default profile, and each profile as one or two sessions with a model and an effort. `bandwise launch` can only pick an id from it, and refuses a file that holds anything else.
