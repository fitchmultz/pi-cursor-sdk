import type { ChildProcess } from "node:child_process";

export declare const DEFAULT_CHILD_SHUTDOWN_GRACE_MS: number;
export declare const CHILD_PROCESS_TREE_SPAWN_OPTIONS: Readonly<{ detached: boolean }>;
export declare function waitForChildClose(child: ChildProcess): Promise<number>;
export declare function signalChild(child: ChildProcess, signal: NodeJS.Signals): void;
export declare function terminateChild(
	child: ChildProcess,
	options?: { graceMs?: number },
): Promise<void>;
export declare function describeProcessExit(code: number | null, signal: string | number | null): string;
export declare function parseJsonLines(stdout: string): unknown[];
