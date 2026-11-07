export {
	CURSOR_SDK_EVENT_DEBUG_DIR_ENV,
	CURSOR_SDK_EVENT_DEBUG_ENV,
	CURSOR_SDK_EVENT_DEBUG_ENV_NAMES,
	CURSOR_SDK_EVENT_DEBUG_RUN_DIR_ENV,
	CURSOR_SDK_EVENT_DEBUG_SESSION_DIR_ENV,
	CURSOR_SDK_EVENT_DEBUG_STDERR_ENV,
} from "../../shared/cursor-sdk-event-debug-env.mjs";

export declare function sealedNodePath(nodePath?: string, envPath?: string): string;
export declare function clearCursorSdkEventDebugEnv<TEnv extends Record<string, string | undefined>>(env: TEnv): TEnv;
export declare function buildCursorSmokeEnv(options?: {
	baseEnv?: Record<string, string | undefined>;
	nodePath?: string;
	settingSources?: string | null;
	lean?: boolean;
	nativeToolDisplay?: boolean;
	registerNativeTools?: boolean;
	bridge?: boolean;
	exposeBuiltinTools?: boolean;
	term?: string;
	eventDebugDir?: string;
}): Record<string, string | undefined>;
export declare function buildCursorSmokeEnvPlan(options?: {
	baseEnv?: Record<string, string | undefined>;
	nodePath?: string;
	settingSources?: string | null;
	lean?: boolean;
	nativeToolDisplay?: boolean;
	registerNativeTools?: boolean;
	bridge?: boolean;
	exposeBuiltinTools?: boolean;
	term?: string;
	eventDebugDir?: string;
}): {
	env: Record<string, string | undefined>;
	sealedPath: string;
	clearEnvNames: string[];
	envEntries: Array<[string, string]>;
};
