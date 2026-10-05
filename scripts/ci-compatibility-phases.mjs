import { spawnSync } from "node:child_process";

export const NATIVE_COMPATIBILITY_TEST_FILES = Object.freeze([
  "test/ci-compatibility.test.mjs",
  "test/native-provider.test.mjs",
  "test/native-cursor-flow.test.mjs",
  "test/native-cursor-prompt.test.mjs",
]);

/** Separate command watchdogs; a failed phase prevents every later phase. */
export function qualifySelectedHost(run) {
  run("npm", ["run", "build"]);
  run("npm", ["run", "verify"]);
  run(process.execPath, ["--test", ...NATIVE_COMPATIBILITY_TEST_FILES]);
}

/** Own POSIX descendants so a timed-out npm cannot outlive isolated-root cleanup. */
export function runCompatibilityCommand(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    detached: process.platform !== "win32",
    killSignal: "SIGKILL",
  });
  if (result.error && result.pid && process.platform !== "win32") {
    try {
      process.kill(-result.pid, "SIGKILL");
    } catch (error) {
      // An already-exited group has no descendants left to stop.
      if (error.code !== "ESRCH") throw error;
    }
  }
  return result;
}
