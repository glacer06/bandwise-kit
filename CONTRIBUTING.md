# Contributing

Thanks for helping. Bug reports, new templates and fixes are all welcome.

## Set up

You need Node 22 (see `.nvmrc`) and pnpm 10 (`corepack enable` picks the version from `package.json`).

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

All four must pass before a pull request can merge. CI runs the same commands.

Try the CLI from source after a build:

```sh
pnpm bandwise run --local examples/email-triage.spec.json examples/email-triage.state.json
```

## Layout

| Folder | Package | What it holds |
|---|---|---|
| `packages/core` | `@bandwise/core` | The spec format (zod contracts), the lints, the run engine, the confidence router, cost and savings math, the model catalog. Pure: no I/O. |
| `packages/system-one-client` | `@bandwise/system-one-client` | Transports that send a compiled request to a System One model: the SDK transport and the fixture transport. |
| `packages/templates` | `@bandwise/templates` | The template pack: specs, example states and a borderline case per question. Pure. |
| `packages/cli` | `@bandwise/cli` | The `bandwise` command. `run --local` runs a spec on a state with no network. |
| `packages/config` | not published | Shared tsconfig, ESLint and Vitest settings. |
| `plugins/claude-code/skills/find-decisions` | not published | The find-decisions skill for Claude Code. |

## Rules that keep the kit trustworthy

- `@bandwise/core` and `@bandwise/templates` stay pure. No file, network, clock, randomness or env access. The lint enforces it.
- Tests never call a live model. Use the fixture transport.
- The spec format is a public contract. A change that breaks existing specs needs a new `schemaVersion` and a migration note.
- Never commit keys or `.env` files.
- Template files in the find-decisions skill are generated from the template pack. After you change a template, run `pnpm --filter @bandwise/templates generate` and commit the result.

## Writing style

Docs, messages and comments use plain words and short sentences. No em dashes to join thoughts, no emojis.

## Pull requests

Keep a pull request to one change, add or update tests with it, and describe what it changes and why. By contributing you agree that your work is licensed under the Apache License 2.0, as described in `LICENSE`.
