/**
 * PTY capture harness — records the full ANSI stream from a terminal session.
 *
 * Captures: pty.events.jsonl, terminal.ansi, terminal.txt, exit code, signal.
 * Terminal dimensions: 150 columns × 45 rows.
 */

import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const COLS = 150;
const ROWS = 45;

/**
 * Capture a command inside a PTY and write artifacts to `dir`.
 *
 * Returns { code, signal, ansiPath, txtPath, eventsPath }.
 *
 * Uses node-pty if available, otherwise falls back to plain child_process.
 */
export async function capturePTY(dir, command, opts = {}) {
	mkdirSync(dir, { recursive: true });

	const eventsPath = resolve(dir, "pty.events.jsonl");
	const ansiPath = resolve(dir, "terminal.ansi");
	const txtPath = resolve(dir, "terminal.txt");

	let ansiBuffer = "";

	function appendEvent(event) {
		appendFileSync(eventsPath, JSON.stringify(event) + "\n");
	}
	function appendOutput(data) {
		const text = typeof data === "string" ? data : data.toString();
		ansiBuffer += text;
	}

	// Try node-pty first
	let pty;
	try {
		const ptyModule = await import("node-pty");
		pty = ptyModule;
	} catch {
		console.log("  node-pty not available — using plain child_process spawn (no PTY sizing)");
	}

	const startTime = Date.now();
	appendEvent({ type: "start", time: startTime, cols: COLS, rows: ROWS, command });

	if (pty) {
		// Use real PTY — always spawn through a shell for portability
		const shellCmd = process.platform === "win32" ? "powershell.exe" : "/bin/bash";
		const shellArgs = process.platform === "win32"
			? ["-NoProfile", "-Command", command.join(" ")]
			: ["-lc", command.join(" ")];

		const ptyProcess = pty.spawn(shellCmd, shellArgs, {
			name: "xterm-256color",
			cols: COLS,
			rows: ROWS,
			cwd: opts.cwd ?? process.cwd(),
			env: { ...process.env, ...opts.env },
		});

		ptyProcess.onData((data) => {
			appendOutput(data);
			appendEvent({ type: "output", time: Date.now() - startTime, bytes: data.length });
		});

		const { code, signal } = await new Promise((resolvePromise) => {
			ptyProcess.onExit((e) => {
				appendEvent({ type: "exit", time: Date.now() - startTime, code: e.exitCode, signal: e.signal });
				resolvePromise({ code: e.exitCode, signal: e.signal });
			});
		});

		writeFileSync(ansiPath, ansiBuffer);
		writeFileSync(txtPath, stripVTControlCharacters(ansiBuffer));

		return { code: code ?? (signal ? 1 : 0), signal, ansiPath, txtPath, eventsPath };
	} else {
		// Fallback: plain child_process
		const child = spawn(command[0], command.slice(1), {
			stdio: ["pipe", "pipe", "pipe"],
			cwd: opts.cwd ?? process.cwd(),
			env: { ...process.env, ...opts.env, COLUMNS: String(COLS), LINES: String(ROWS) },
		});

		child.stdout.on("data", (d) => {
			appendOutput(d.toString());
			appendEvent({ type: "output", time: Date.now() - startTime, bytes: d.length });
		});
		child.stderr.on("data", (d) => {
			appendOutput(d.toString());
			appendEvent({ type: "stderr", time: Date.now() - startTime, bytes: d.length });
		});

		const { code, signal } = await new Promise((resolvePromise) => {
			child.on("close", (c, s) => {
				appendEvent({ type: "exit", time: Date.now() - startTime, code: c, signal: s });
				resolvePromise({ code: c, signal: s });
			});
			child.on("error", (err) => {
				appendEvent({ type: "error", time: Date.now() - startTime, error: err.message });
				resolvePromise({ code: 1, signal: null });
			});
		});

		writeFileSync(ansiPath, ansiBuffer);
		writeFileSync(txtPath, stripVTControlCharacters(ansiBuffer));

		return { code: code ?? (signal ? 1 : 0), signal, ansiPath, txtPath, eventsPath };
	}
}

/** Self-test: can we create a simple PTY? */
export async function ptySelfTest() {
	const dir = resolve(process.cwd(), ".artifacts", "pty-self-test");
	mkdirSync(dir, { recursive: true });
	const result = await capturePTY(dir, ["echo", "pty-self-test-ok"]);
	return result;
}
