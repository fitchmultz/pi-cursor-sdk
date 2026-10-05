import { AsyncLocalStorage } from "node:async_hooks";
import { isUtf8 } from "node:buffer";
import { StringDecoder } from "node:string_decoder";
import { stripVTControlCharacters } from "node:util";

const cursorSdkOutputSuppression = new AsyncLocalStorage();
const noticeOwner = new AsyncLocalStorage();
// ponytail: larger frames pass unchanged. Raise this cap for a captured larger
// SDK frame, or use a public SDK sink when unbounded suppression is required.
const MAX_CANDIDATE_BYTES = 16 * 1024;
const PARSER_WARNING = "shell-parser: tree-sitter natives are unavailable in this artifact; shell command analysis degrades to parsingFailed";
const PLUGIN_PREFIX = "[local-plugins-bootstrap] loadUserLocalPlugin ";
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
	return cursorSdkOutputSuppression.getStore() === true;
}

export function suppressCursorSdkOutput(operation) {
	return cursorSdkOutputSuppression.run(true, operation);
}

/** Attribution follows the request's async work, including overlapping native sessions. */
export function withCursorSdkOutputNoticeHandler(handler, operation) {
	return noticeOwner.run(handler, operation);
}

function classify(text) {
	if (text.replace(/\x1b\[[\d;]*m/g, "").includes("\x1b")) return;
	const line = stripVTControlCharacters(text).replace(/\r?\n$/, "");
	if (line === PARSER_WARNING) return "parserUnavailable";
	if (/^\[local-plugins-bootstrap\] loadUserLocalPlugin [^\r\n]+ rejected: symlink target [^\r\n]+ is outside [^\r\n]+(?: \{[^\r\n]*\})?$/.test(line)) return "outsidePlugin";
	if (HOOK_NOTICES.includes(line)) return "noise";
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
	if (HOOK_NOTICES.some(prefix => prefix.startsWith(plain) || plain === `${prefix}\r`)) return true;
	if (PARSER_WARNING.startsWith(plain) || plain === `${PARSER_WARNING}\r`) return true;
	if (PLUGIN_PREFIX.startsWith(plain) || plain.startsWith(PLUGIN_PREFIX)) return true;
	const timestamp = "00:00:00.000 INFO  ";
	const normalized = plain.replace(/\d/g, "0");
	if (timestamp.startsWith(normalized)) return true;
	if (!normalized.startsWith(timestamp)) return false;
	const message = plain.slice(timestamp.length);
	return CURSOR_SDK_STARTUP_NOISE_PATTERNS.some(prefix => prefix.startsWith(message) || message === prefix || message.startsWith(`${prefix} `));
}

function createFilteredProcessWrite(write, stream) {
	let pending = [], size = 0, text = "", decoder = new StringDecoder("utf8");
	let owner, suppressed = false;
	let active = true;
	function reset() {
		pending = []; size = 0; text = ""; decoder = new StringDecoder("utf8"); owner = undefined; suppressed = false;
	}
	function finish(output) {
		const original = Buffer.concat(pending);
		const kind = isUtf8(original) ? classify(text + decoder.end()) : undefined;
		const handler = owner, wasSuppressed = suppressed;
		reset();
		let handled = kind === "noise";
		if (kind && kind !== "noise" && handler) {
			// A failed native notice must not turn a capability warning into silence.
			try {
				handled = cursorSdkOutputSuppression.run(false, () => handler(kind, CURSOR_SDK_CAPABILITY_NOTICES[kind])) !== false;
			} catch { handled = false; }
		}
		if (!handled && (kind || !wasSuppressed)) output.push(original);
	}
	const filteredWrite = (chunk, encodingOrCallback, callback) => {
		if (!active) return write.call(stream, chunk, encodingOrCallback, callback);
		if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) return write.call(stream, chunk, encodingOrCallback, callback);
		const bytes = typeof chunk === "string" ? Buffer.from(chunk, typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8") : Buffer.from(chunk);
		const output = [];
		for (let offset = 0; offset < bytes.length;) {
			const newline = bytes.indexOf(10, offset);
			const end = newline < 0 ? bytes.length : newline + 1;
			const part = bytes.subarray(offset, end);
			// A write invocation is also a frame boundary after unknown bytes have
			// forwarded: Pi's native footer/prompt need not end with a newline.
			if (size === 0) { owner = noticeOwner.getStore(); suppressed = isCursorSdkOutputSuppressed(); }
			pending.push(part); size += part.length;
			if (size <= MAX_CANDIDATE_BYTES) text += decoder.write(part);
			if (size > MAX_CANDIDATE_BYTES || !text || (newline < 0 && !possibleDiagnostic(text))) {
				if (!suppressed) output.push(...pending);
				reset();
			} else if (newline >= 0) finish(output);
			offset = end;
		}
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		if (output.length) return write.call(stream, Buffer.concat(output), done);
		if (done) process.nextTick(done);
		return true;
	};
	return {
		write: filteredWrite,
		restore() {
			active = false;
			const output = [];
			if (size) finish(output);
			if (output.length) write.call(stream, Buffer.concat(output));
		},
	};
}

let activeOutputFilterInstalls = 0;
let outputFilterOriginals;
let sinks;

export function installCursorSdkOutputFilter() {
	if (activeOutputFilterInstalls === 0) {
		outputFilterOriginals = { stdoutWrite: process.stdout.write, stderrWrite: process.stderr.write };
		sinks = [createFilteredProcessWrite(outputFilterOriginals.stdoutWrite, process.stdout), createFilteredProcessWrite(outputFilterOriginals.stderrWrite, process.stderr)];
		process.stdout.write = sinks[0].write;
		process.stderr.write = sinks[1].write;
	}
	activeOutputFilterInstalls += 1;
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		activeOutputFilterInstalls -= 1;
		if (activeOutputFilterInstalls > 0) return;
		process.stdout.write = outputFilterOriginals.stdoutWrite;
		process.stderr.write = outputFilterOriginals.stderrWrite;
		const finishing = sinks;
		sinks = outputFilterOriginals = undefined;
		for (const sink of finishing) sink.restore();
	};
}
