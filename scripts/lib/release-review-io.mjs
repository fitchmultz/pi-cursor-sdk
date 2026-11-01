import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import spawn from "cross-spawn";

export function run(command, args, { cwd, env, output, allowed = [0] } = {}) {
	const fd = output ? openSync(output, "w") : undefined;
	let result;
	try {
		result = spawn.sync(command, args, { cwd, env, encoding: "utf8", stdio: ["ignore", fd ?? "pipe", "pipe"] });
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
	if (result.error) throw result.error;
	const detail = result.stderr?.trim();
	assert.ok(allowed.includes(result.status), `${command} ${args.slice(0, 3).join(" ")} failed: ${result.status}${detail ? `\n${detail}` : ""}`);
	return result.stdout?.trim() ?? "";
}

export function hash(path, algorithm = "sha256", encoding = "hex") {
	return createHash(algorithm).update(readFileSync(path)).digest(encoding);
}

export function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
