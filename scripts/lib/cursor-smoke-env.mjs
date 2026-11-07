import { delimiter, dirname } from "node:path";
import {
	CURSOR_SDK_EVENT_DEBUG_DIR_ENV,
	CURSOR_SDK_EVENT_DEBUG_ENV,
	CURSOR_SDK_EVENT_DEBUG_ENV_NAMES,
	CURSOR_SDK_EVENT_DEBUG_RUN_DIR_ENV,
	CURSOR_SDK_EVENT_DEBUG_SESSION_DIR_ENV,
	CURSOR_SDK_EVENT_DEBUG_STDERR_ENV,
} from "../../shared/cursor-sdk-event-debug-env.mjs";

export {
	CURSOR_SDK_EVENT_DEBUG_DIR_ENV,
	CURSOR_SDK_EVENT_DEBUG_ENV,
	CURSOR_SDK_EVENT_DEBUG_ENV_NAMES,
	CURSOR_SDK_EVENT_DEBUG_RUN_DIR_ENV,
	CURSOR_SDK_EVENT_DEBUG_SESSION_DIR_ENV,
	CURSOR_SDK_EVENT_DEBUG_STDERR_ENV,
};

export function sealedNodePath(nodePath = process.execPath, envPath = process.env.PATH ?? "") {
	return [dirname(nodePath), envPath].filter(Boolean).join(delimiter);
}

export function clearCursorSdkEventDebugEnv(env) {
	for (const name of CURSOR_SDK_EVENT_DEBUG_ENV_NAMES) delete env[name];
	return env;
}

function boolEnv(value) {
	return value ? "1" : "0";
}

function pushIfDefined(entries, name, value) {
	if (value !== undefined) entries.push([name, value]);
}

export function buildCursorSmokeEnv({
	baseEnv = process.env,
	nodePath = process.execPath,
	settingSources,
	lean,
	nativeToolDisplay,
	registerNativeTools,
	bridge,
	exposeBuiltinTools,
	term,
	eventDebugDir,
} = {}) {
	const env = clearCursorSdkEventDebugEnv({ ...baseEnv });
	env.PATH = sealedNodePath(nodePath, baseEnv.PATH ?? "");
	if (settingSources === null) delete env.PI_CURSOR_SETTING_SOURCES;
	else if (settingSources !== undefined) env.PI_CURSOR_SETTING_SOURCES = settingSources;
	if (lean !== undefined) env.PI_CURSOR_LEAN = boolEnv(lean);
	if (nativeToolDisplay !== undefined) env.PI_CURSOR_NATIVE_TOOL_DISPLAY = boolEnv(nativeToolDisplay);
	if (registerNativeTools !== undefined) env.PI_CURSOR_REGISTER_NATIVE_TOOLS = boolEnv(registerNativeTools);
	if (bridge !== undefined) env.PI_CURSOR_PI_TOOL_BRIDGE = boolEnv(bridge);
	if (exposeBuiltinTools !== undefined) env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = boolEnv(exposeBuiltinTools);
	if (term !== undefined) env.TERM = term;
	if (eventDebugDir !== undefined) {
		env[CURSOR_SDK_EVENT_DEBUG_ENV] = "1";
		env[CURSOR_SDK_EVENT_DEBUG_DIR_ENV] = eventDebugDir;
	}
	return env;
}

export function buildCursorSmokeEnvPlan(options = {}) {
	const env = buildCursorSmokeEnv(options);
	const envEntries = [];
	pushIfDefined(envEntries, "PI_CURSOR_SETTING_SOURCES", options.settingSources === null ? undefined : options.settingSources);
	pushIfDefined(envEntries, "PI_CURSOR_LEAN", options.lean === undefined ? undefined : boolEnv(options.lean));
	pushIfDefined(envEntries, "PI_CURSOR_NATIVE_TOOL_DISPLAY", options.nativeToolDisplay === undefined ? undefined : boolEnv(options.nativeToolDisplay));
	pushIfDefined(envEntries, "PI_CURSOR_REGISTER_NATIVE_TOOLS", options.registerNativeTools === undefined ? undefined : boolEnv(options.registerNativeTools));
	pushIfDefined(envEntries, "PI_CURSOR_PI_TOOL_BRIDGE", options.bridge === undefined ? undefined : boolEnv(options.bridge));
	pushIfDefined(envEntries, "PI_CURSOR_EXPOSE_BUILTIN_TOOLS", options.exposeBuiltinTools === undefined ? undefined : boolEnv(options.exposeBuiltinTools));
	pushIfDefined(envEntries, "TERM", options.term);
	pushIfDefined(envEntries, CURSOR_SDK_EVENT_DEBUG_ENV, options.eventDebugDir === undefined ? undefined : "1");
	pushIfDefined(envEntries, CURSOR_SDK_EVENT_DEBUG_DIR_ENV, options.eventDebugDir);
	return {
		env,
		sealedPath: env.PATH,
		clearEnvNames: [...CURSOR_SDK_EVENT_DEBUG_ENV_NAMES],
		envEntries,
	};
}
