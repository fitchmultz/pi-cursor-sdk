export const PROBE_JSON_OBJECT: string;
export const PROBE_SOURCE: string;

export declare function expectedAppliedShell(
	shellPath: string | null,
	startingShell: string,
	platform: string,
	piDefaultShell: string,
): string;

export declare function formatShellPathProbe(
	shell: string | null | undefined,
	shellPath: string | null | undefined,
): string;

export declare function parseShellPathEvidence(
	lines: readonly string[],
): { shell: unknown; shellPath: unknown } | undefined;
