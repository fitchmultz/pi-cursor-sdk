import type { CloudSmokeShutdownController } from "./cloud-smoke-shutdown.mjs";
import type { PiRpcRecord, PiRpcResponse } from "./cursor-pi-rpc.mjs";

interface CloudSmokeRpcResponse extends PiRpcResponse {
	data?: { text?: string; [key: string]: unknown };
}

export function createCloudSmokePiRunner(options: {
	root: string;
	model: string;
	shutdown: CloudSmokeShutdownController;
	buildEnv(artifactDir: string, options?: Record<string, unknown>): NodeJS.ProcessEnv;
	buildWorkspace(artifactDir: string): string;
}): {
	runPi(options: {
		artifactDir: string;
		envOptions?: Record<string, unknown>;
		message: string;
		sessionId: string;
		timeoutMs: number;
	}): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;
	startRpc(options: {
		artifactDir: string;
		contextHandoff?: string;
		sessionId: string;
		envOptions?: Record<string, unknown>;
	}): Promise<{
		events: PiRpcRecord[];
		send(type: string, extra?: Record<string, unknown>, timeoutMs?: number): Promise<CloudSmokeRpcResponse>;
		stop(): Promise<void>;
		throwIfFailed(): void;
		readonly stderr: string;
	}>;
};
