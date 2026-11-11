import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function writeUtf8(path, text) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text, "utf8");
}

export function redactedArgv(argv) {
	const redacted = [];
	let redactNext = false;
	for (const arg of argv) {
		if (redactNext) {
			redacted.push("[redacted]");
			redactNext = false;
			continue;
		}
		if (arg === "--prompt" || arg === "--prompt-file") {
			redacted.push(arg);
			redactNext = true;
			continue;
		}
		if (arg.startsWith("--prompt=") || arg.startsWith("--prompt-file=")) {
			const [flag] = arg.split("=", 1);
			redacted.push(`${flag}=[redacted]`);
			continue;
		}
		redacted.push(arg);
	}
	return redacted;
}

export function promptDigest(prompt) {
	return createHash("sha256").update(prompt).digest("hex");
}

function manifestExistingPath(path) {
	return path && existsSync(path) ? path : undefined;
}

export function writeVisualManifest(path, options, artifacts, failure) {
	const paths = {
		ansi: manifestExistingPath(artifacts.ansiPath),
		text: manifestExistingPath(artifacts.textPath),
		html: manifestExistingPath(artifacts.htmlPath),
		png: artifacts.pngWritten === true ? manifestExistingPath(artifacts.pngPath) : undefined,
		jsonlPathFile: manifestExistingPath(artifacts.jsonlPathFile),
		jsonl: manifestExistingPath(artifacts.jsonlPath),
	};
	for (const [key, value] of Object.entries(paths)) {
		if (value === undefined) delete paths[key];
	}
	writeUtf8(path, `${JSON.stringify({
		schemaVersion: 1,
		kind: "visual-tui-smoke-manifest",
		label: options.label,
		safeLabel: options.safeLabel,
		promptLength: options.prompt.length,
		promptSha256: promptDigest(options.prompt),
		width: options.width,
		height: options.height,
		model: options.model,
		mode: options.mode,
		cwd: options.cwd,
		ext: options.ext,
		outDir: options.outDir,
		sessionDir: options.sessionDir,
		sessionId: options.sessionId,
		waitMs: options.waitMs,
		startupMs: options.startupMs,
		screenshot: options.screenshot,
		paths,
		// pi's pane state when it was read; cleanup's tmux hangup is not proof that pi exited.
		...(artifacts.pi ? { pi: artifacts.pi } : {}),
		command: {
			argv: redactedArgv(process.argv.slice(2)),
			cwd: process.cwd(),
			pid: process.pid,
		},
		...(failure ? { failure } : {}),
		writtenAt: new Date().toISOString(),
	}, null, 2)}\n`);
}
