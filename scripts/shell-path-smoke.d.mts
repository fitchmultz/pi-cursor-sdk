export const PROBE_JSON_OBJECT: string;
export const PROBE_SOURCE: string;

export declare function expectedCursorShell(
	apply: (shellPath: string | undefined, env: { SHELL?: string }) => void,
	shellPath: string | null,
	startingShell: string,
): string | null;

export declare function formatShellPathProbe(
	shell: string | null | undefined,
	shellPath: string | null | undefined,
): string;

export declare function parseShellPathEvidence(
	lines: readonly string[],
): { shell: unknown; shellPath: unknown } | undefined;
