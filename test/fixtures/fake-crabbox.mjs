// Preloaded through NODE_OPTIONS=--import into a Node process standing in for the Crabbox CLI.
// It must exit synchronously, before Node resolves the Crabbox subcommand as a main module.
import { writeFileSync, writeSync } from "node:fs";

const args = process.argv.slice(2);
const capture = args.indexOf("--capture-stdout");
if (capture !== -1) writeFileSync(args[capture + 1], `FAKE_CRABBOX_ARGS=${JSON.stringify(args)}\n`);
writeSync(1, "terminal output truncated by Crabbox\n");
process.exit(7);
