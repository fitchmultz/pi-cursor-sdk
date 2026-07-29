import { AsyncLocalStorage } from "node:async_hooks";

const cursorSdkOutputSuppression = new AsyncLocalStorage();

export const CURSOR_SDK_STARTUP_NOISE_PATTERNS = [
	"[hooks]",
	"managed_skills.",
	"CursorPluginsAgentSkillsService load completed",
	"LocalCursorRulesService load completed",
	"AgentSkillsCursorRulesService load completed",
	"Error initializing ignore mapping for",
	"Ripgrep path not configured. Call configureRipgrepPath() at startup.",
	"[shell-exec]",
];

export function isCursorSdkOutputSuppressed() {
	return cursorSdkOutputSuppression.getStore() === true;
}

export function suppressCursorSdkOutput(operation) {
	return cursorSdkOutputSuppression.run(true, operation);
}

export function isCursorSdkStartupNoise(text) {
	return CURSOR_SDK_STARTUP_NOISE_PATTERNS.some((pattern) => text.includes(pattern));
}

function createFilteredProcessWrite(write, stream) {
	return (chunk, encodingOrCallback, callback) => {
		const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		if (isCursorSdkOutputSuppressed() || isCursorSdkStartupNoise(text)) {
			const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			done?.();
			return true;
		}
		return write.call(stream, chunk, encodingOrCallback, callback);
	};
}

function createFilteredConsoleMethod(method) {
	return (...args) => {
		const text = args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" ");
		if (isCursorSdkOutputSuppressed() || isCursorSdkStartupNoise(text)) return;
		method(...args);
	};
}

let activeOutputFilterInstalls = 0;
let outputFilterOriginals;

export function installCursorSdkOutputFilter() {
	if (activeOutputFilterInstalls === 0) {
		outputFilterOriginals = {
			stdoutWrite: process.stdout.write,
			stderrWrite: process.stderr.write,
			consoleLog: console.log,
			consoleInfo: console.info,
			consoleWarn: console.warn,
			consoleError: console.error,
			consoleDebug: console.debug,
		};
		process.stdout.write = createFilteredProcessWrite(outputFilterOriginals.stdoutWrite, process.stdout);
		process.stderr.write = createFilteredProcessWrite(outputFilterOriginals.stderrWrite, process.stderr);
		console.log = createFilteredConsoleMethod(outputFilterOriginals.consoleLog);
		console.info = createFilteredConsoleMethod(outputFilterOriginals.consoleInfo);
		console.warn = createFilteredConsoleMethod(outputFilterOriginals.consoleWarn);
		console.error = createFilteredConsoleMethod(outputFilterOriginals.consoleError);
		console.debug = createFilteredConsoleMethod(outputFilterOriginals.consoleDebug);
	}
	activeOutputFilterInstalls += 1;

	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		activeOutputFilterInstalls = Math.max(activeOutputFilterInstalls - 1, 0);
		if (activeOutputFilterInstalls > 0 || !outputFilterOriginals) return;
		process.stdout.write = outputFilterOriginals.stdoutWrite;
		process.stderr.write = outputFilterOriginals.stderrWrite;
		console.log = outputFilterOriginals.consoleLog;
		console.info = outputFilterOriginals.consoleInfo;
		console.warn = outputFilterOriginals.consoleWarn;
		console.error = outputFilterOriginals.consoleError;
		console.debug = outputFilterOriginals.consoleDebug;
		outputFilterOriginals = undefined;
	};
}
