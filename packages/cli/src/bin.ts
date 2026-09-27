#!/usr/bin/env node
// Entry point of the `bandwise` binary.

import { main } from "./main.js";

const out = await main(process.argv.slice(2));
if (out.stdout !== "") process.stdout.write(`${out.stdout}\n`);
if (out.stderr !== "") process.stderr.write(`${out.stderr}\n`);
process.exitCode = out.exitCode;
