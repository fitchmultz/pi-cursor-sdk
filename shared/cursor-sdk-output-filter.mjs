import { AsyncLocalStorage } from "node:async_hooks";
import { isUtf8 } from "node:buffer";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";

// Pi can reevaluate extension dependencies during reload. Share both the sink
// ownership and async attribution scopes, not just a permanent-install flag.
const STATE = Symbol.for("pi-cursor-sdk:output-filter:v1");
const state = process[STATE] ??= {
	suppression: new AsyncLocalStorage(), noticeOwner: new AsyncLocalStorage(),
	installs: 0, originals: undefined, sinks: undefined, processCleanup: undefined,
};
const cursorSdkOutputSuppression = state.suppression;
const noticeOwner = state.noticeOwner;
// ponytail: larger frames pass unchanged. Raise this cap for a captured larger
// SDK frame, or use a public SDK sink when unbounded suppression is required.
const MAX_CANDIDATE_BYTES = 16 * 1024;
const PARSER_WARNING = "shell-parser: tree-sitter natives are unavailable in this artifact; shell command analysis degrades to parsingFailed";
const PLUGIN_PREFIX = "[local-plugins-bootstrap] loadUserLocalPlugin ";
const SHELL_CLOSE_TIMEOUT_PREFIX = "[shell-exec] Close event did not fire within ";
// Fixed compatibility notices remain exact. Only the event name varies in
// these two verified SDK templates; unrelated [hooks] warnings must pass.
const HOOK_EVENT_NOTICES = [
	{ prefix: '[hooks] Unknown Claude Code event "', suffix: '", skipping' },
	{ prefix: '[hooks] Claude Code event "', suffix: '" is not supported in Cursor and will be ignored' },
];
const HOOK_NOTICES = [
	...["startup", "resume", "clear", "compact"].map(trigger => `[hooks] SessionStart trigger matcher "${trigger}" is not supported in Cursor, hooks will fire for all triggers`),
	...["manual", "auto"].map(trigger => `[hooks] PreCompact trigger matcher "${trigger}" is not supported in Cursor, hooks will fire for all triggers`),
	'[hooks] Tool "Glob" is not supported in Cursor and will be ignored',
];

export const CURSOR_SDK_STARTUP_NOISE_PATTERNS = [
	"managed_skills.startup_inventory",
	"managed_skills.removed",
	"CursorPluginsAgentSkillsService load completed",
	"LocalCursorRulesService load completed",
	"AgentSkillsCursorRulesService load completed",
];

const CURSOR_SDK_CAPABILITY_NOTICES = {
	outsidePlugin: "Cursor skipped a local plugin because its symlink points outside the local plugin directory. Install it inside that directory to enable it.",
	parserUnavailable: "Cursor shell analysis is degraded because native parsers are unavailable (parsingFailed). Check the native parser installation or CURSOR_TREE_SITTER_VENDOR_DIR.",
};

export function isCursorSdkOutputSuppressed() {
	return cursorSdkOutputSuppression.getStore()?.active === true;
}

export function suppressCursorSdkOutput(operation) {
	// Detached SDK tasks inherit ALS, but must not inherit an unbounded mute
	// after Agent.create() settles. Only known frames stay hidden afterward.
	const scope = { active: true };
	return cursorSdkOutputSuppression.run(scope, () => {
		try {
			const result = operation();
			if (result && typeof result.then === "function") {
				return Promise.resolve(result).finally(() => { scope.active = false; });
			}
			scope.active = false;
			return result;
		} catch (error) {
			scope.active = false;
			throw error;
		}
	});
}

/** Attribution follows the request's async work, including overlapping native sessions. */
export function withCursorSdkOutputNoticeHandler(handler, operation) {
	return noticeOwner.run(handler, operation);
}

function hookEventNotice(line, partial = false) {
	return HOOK_EVENT_NOTICES.some(({ prefix, suffix }) => {
		if (partial && prefix.startsWith(line)) return true;
		if (!line.startsWith(prefix)) return false;
		const rest = line.slice(prefix.length), quote = rest.indexOf('"');
		if (quote < 0) return partial && !/[\r\n]/.test(rest);
		if (quote === 0 || /[\r\n]/.test(rest.slice(0, quote))) return false;
		const ending = rest.slice(quote);
		return partial ? suffix.startsWith(ending) || ending === `${suffix}\r` : ending === suffix;
	});
}

function classify(text) {
	if (text.replace(/\x1b\[[\d;]*m/g, "").includes("\x1b")) return;
	const line = stripVTControlCharacters(text).replace(/\r?\n$/, "");
	if (line === PARSER_WARNING) return "parserUnavailable";
	if (/^\[local-plugins-bootstrap\] loadUserLocalPlugin [^\r\n]+ rejected: symlink target [^\r\n]+ is outside [^\r\n]+(?: \{[^\r\n]*\})?$/.test(line)) return "outsidePlugin";
	if (HOOK_NOTICES.includes(line) || hookEventNotice(line)) return "noise";
	// One SDK close-timeout heuristic with four executor-specific suffixes:
	// bash, PowerShell, and zsh-light proceed; zsh leaves the job or kills the
	// group. Pi cannot act on any of them, so none belongs in its input area.
	if (line.startsWith(SHELL_CLOSE_TIMEOUT_PREFIX)) return "noise";
	const info = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3} INFO  (.+?)(?: ctx=[^\s]+)?(?: meta=\{[^\r\n]*\})?$/.exec(line);
	if (info && CURSOR_SDK_STARTUP_NOISE_PATTERNS.includes(info[1])) return "noise";
}

// ponytail: framed text cannot attribute an identical complete SDK signature to
// its emitter. Upgrade to a public SDK logger/sink when strict attribution exists.
export function isCursorSdkStartupNoise(text) {
	return classify(text) === "noise";
}

function possibleDiagnostic(text) {
	// Only SGR may lead a diagnostic; Pi cursor/prompt controls forward immediately.
	const withoutSgr = text.replace(/\x1b\[[\d;]*m/g, "");
	const plain = stripVTControlCharacters(withoutSgr.replace(/\x1b(?:\[[\d;]*)?$/, ""));
	if (withoutSgr.includes("\x1b") && !/\x1b(?:\[[\d;]*)?$/.test(withoutSgr)) return false;
	if (!plain) return true;
	if (HOOK_NOTICES.some(prefix => prefix.startsWith(plain) || plain === `${prefix}\r`) || hookEventNotice(plain, true)) return true;
	if (PARSER_WARNING.startsWith(plain) || plain === `${PARSER_WARNING}\r`) return true;
	if (SHELL_CLOSE_TIMEOUT_PREFIX.startsWith(plain) || plain.startsWith(SHELL_CLOSE_TIMEOUT_PREFIX) || plain.startsWith(`${SHELL_CLOSE_TIMEOUT_PREFIX}\r`)) return true;
	if (PLUGIN_PREFIX.startsWith(plain) || plain.startsWith(PLUGIN_PREFIX)) return true;
	const timestamp = "00:00:00.000 INFO  ";
	const normalized = plain.replace(/\d/g, "0");
	if (timestamp.startsWith(normalized)) return true;
	if (!normalized.startsWith(timestamp)) return false;
	const message = plain.slice(timestamp.length);
	return CURSOR_SDK_STARTUP_NOISE_PATTERNS.some(prefix => prefix.startsWith(message) || message === prefix || message.startsWith(`${prefix} `));
}

// A sink is empty between frames, buffers one candidate frame, or delegates
// transparently after restoration. A candidate keeps its original bytes, the
// notice owner and creation mute from its start, and its own StringDecoder,
// which alone holds a split UTF-8 tail.
const EMPTY = { kind: "empty" }, TRANSPARENT = { kind: "transparent" };

function createFilteredProcessWrite(write, stream) {
	let parser = EMPTY;
	// Callers detach the frame first: a notice handler may write to this sink.
	function finish(frame, output) {
		const original = Buffer.concat(frame.chunks);
		const kind = isUtf8(original) ? classify(frame.text + frame.decoder.end()) : undefined;
		let handled = kind === "noise";
		if (kind && kind !== "noise" && frame.owner) {
			// A failed native notice must not turn a capability warning into silence.
			try {
				handled = cursorSdkOutputSuppression.run(false, () => frame.owner(kind, CURSOR_SDK_CAPABILITY_NOTICES[kind])) !== false;
			} catch { handled = false; }
		}
		if (!handled && (kind || !frame.suppressed)) output.push(original);
	}
	const filteredWrite = (chunk, encodingOrCallback, callback) => {
		if (parser.kind === "transparent") return write.call(stream, chunk, encodingOrCallback, callback);
		if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) return write.call(stream, chunk, encodingOrCallback, callback);
		const bytes = typeof chunk === "string" ? Buffer.from(chunk, typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8") : Buffer.from(chunk);
		const output = [];
		for (let offset = 0; offset < bytes.length;) {
			// Restoration is terminal even if a notice handler restores mid-write.
			if (parser.kind === "transparent") { output.push(bytes.subarray(offset)); break; }
			const newline = bytes.indexOf(10, offset);
			const end = newline < 0 ? bytes.length : newline + 1;
			const part = bytes.subarray(offset, end);
			// A write invocation is also a frame boundary after unknown bytes have
			// forwarded: Pi's native footer/prompt need not end with a newline.
			if (parser.kind === "empty") parser = {
				kind: "candidate", chunks: [], size: 0, text: "", decoder: new StringDecoder("utf8"),
				owner: noticeOwner.getStore(), suppressed: isCursorSdkOutputSuppressed(),
			};
			const frame = parser;
			frame.chunks.push(part); frame.size += part.length;
			if (frame.size <= MAX_CANDIDATE_BYTES) frame.text += frame.decoder.write(part);
			if (frame.size > MAX_CANDIDATE_BYTES || !frame.text || (newline < 0 && !possibleDiagnostic(frame.text))) {
				parser = EMPTY;
				if (!frame.suppressed) output.push(...frame.chunks);
			} else if (newline >= 0) {
				parser = EMPTY;
				finish(frame, output);
			}
			offset = end;
		}
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		if (output.length) return write.call(stream, Buffer.concat(output), done);
		if (done) process.nextTick(done);
		return true;
	};
	// Settle a pending candidate on flush (keep filtering) or restore (terminal).
	function settle(next) {
		const frame = parser;
		if (frame.kind === "transparent") return;
		parser = next;
		const output = [];
		if (frame.kind === "candidate") finish(frame, output);
		if (output.length) write.call(stream, Buffer.concat(output));
	}
	return {
		write: filteredWrite,
		flush: () => settle(EMPTY),
		restore: () => settle(TRANSPARENT),
	};
}

export function installCursorSdkOutputFilter() {
	if (state.installs === 0) {
		state.originals = { stdoutWrite: process.stdout.write, stderrWrite: process.stderr.write };
		state.sinks = [createFilteredProcessWrite(state.originals.stdoutWrite, process.stdout), createFilteredProcessWrite(state.originals.stderrWrite, process.stderr)];
		process.stdout.write = state.sinks[0].write;
		process.stderr.write = state.sinks[1].write;
	}
	state.installs += 1;
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		state.installs -= 1;
		if (state.installs > 0) return;
		// A later owner may wrap our write method. Keep its wrapper installed;
		// retained filter methods become transparent delegates on restoration.
		if (process.stdout.write === state.sinks[0].write) process.stdout.write = state.originals.stdoutWrite;
		if (process.stderr.write === state.sinks[1].write) process.stderr.write = state.originals.stderrWrite;
		const finishing = state.sinks;
		state.sinks = state.originals = undefined;
		for (const sink of finishing) sink.restore();
	};
}

/** One narrow, process-lifetime lease survives reload, removal and failed reload. */
export function installCursorSdkProcessOutputFilter() {
	if (state.processCleanup) return;
	const restore = installCursorSdkOutputFilter();
	const flush = () => { for (const sink of state.sinks ?? []) sink.flush(); };
	const cleanup = () => {
		if (state.processCleanup !== cleanup) return;
		state.processCleanup = undefined;
		process.off("beforeExit", flush);
		process.off("exit", onExit);
		restore();
	};
	const onExit = () => { flush(); cleanup(); };
	state.processCleanup = cleanup;
	// beforeExit may schedule more work: keep filtering until actual exit,
	// which flushes even when temporary owners still retain their leases.
	process.on("beforeExit", flush);
	process.once("exit", onExit);
}

// Canonical harness cleanup only; production owns this lease until process exit.
export const __testUtils = {
	resetProcessOutputFilter() { state.processCleanup?.(); },
};
