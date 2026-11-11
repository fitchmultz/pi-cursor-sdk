import { spawnSync } from "node:child_process";
import { NATIVE_COMPATIBILITY_TEST_FILES } from "./ci-compatibility-phases.mjs";

const result = spawnSync(process.execPath, ["--test", ...NATIVE_COMPATIBILITY_TEST_FILES, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;
