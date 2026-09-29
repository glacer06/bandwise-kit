#!/usr/bin/env node
// Entry point of the `bandwise` binary.

import { main } from "./main.js";

/** All of stdin, for `bandwise hook`. The hook's own timeout covers a stdin that never closes. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const argv = process.argv.slice(2);
const isHook = argv[0] === "hook";
// A hook never fails a session: anything main throws ends the hook with exit 0 and no output.
const out = isHook
  ? await main(argv, { stdin: readStdin }).catch(() => ({ exitCode: 0, stdout: "", stderr: "" }))
  : await main(argv, { stdin: readStdin });
if (isHook) {
  // A hook must not linger on an open stdin or a slow socket after it answered. Exit once the
  // answer is flushed, always with 0.
  process.stdout.write(out.stdout === "" ? "" : `${out.stdout}\n`, () => process.exit(0));
} else {
  if (out.stdout !== "") process.stdout.write(`${out.stdout}\n`);
  if (out.stderr !== "") process.stderr.write(`${out.stderr}\n`);
  process.exitCode = out.exitCode;
}
