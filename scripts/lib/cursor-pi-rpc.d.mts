import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface PiRpcRecord {
	type: string;
	[key: string]: unknown;
}

export interface PiRpcResponse extends PiRpcRecord {
	type: "response";
	id: string;
	success: boolean;
	data?: Record<string, unknown>;
	error?: unknown;
}

export interface PiRpcChannel {
	/** Session events and records that settled no pending request, in arrival order. */
	readonly events: PiRpcRecord[];
	readonly stderr: string;
	/** Rejects without writing once the channel is closed. */
	send(type: string, extra?: Record<string, unknown>, timeoutMs?: number): Promise<PiRpcResponse>;
	/** The first reason wins; pending and later requests reject with it once it resolves. */
	close(reason: Error | PromiseLike<Error>): void;
}

export declare function createPiRpcChannel(
	child: ChildProcessWithoutNullStreams,
	options: { idPrefix: string },
): PiRpcChannel;
