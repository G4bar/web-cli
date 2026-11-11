#!/usr/bin/env node
// web — search / fetch / answer / research with provider fallback (Exa -> TinyFish).
// Zero dependencies. Needs EXA_API_KEY and/or TINYFISH_API_KEY in the environment.
// The implementation lives in ./lib; this file stays the entry point (npm bin, Pi skill, symlinks).
import { main, realCtx } from "./lib/cli.mjs";

process.exitCode = await main(process.argv.slice(2), realCtx());
