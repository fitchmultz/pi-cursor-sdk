interface CursorPiToolBridgeActiveToolExecution {
	toolCallId: string;
	abort: () => Promise<void> | void;
	cancelPending: (reason: string) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

class CursorPiToolBridgeToolExecutionAbortTracker {
	private readonly activeExecutions = new Map<string, CursorPiToolBridgeActiveToolExecution>();
	private processSignalHandlersInstalled = false;

	track(
		toolCallId: string,
		options: {
			signal?: AbortSignal;
			abort: () => Promise<void> | void;
			cancelPending: (reason: string) => void;
		},
	): boolean {
		this.finish(toolCallId);
		const execution: CursorPiToolBridgeActiveToolExecution = {
			toolCallId,
			abort: options.abort,
			cancelPending: options.cancelPending,
			signal: options.signal,
		};
		if (options.signal?.aborted) {
			this.cancelExecution(execution, "Cursor pi bridge tool execution was already aborted");
			this.abortExecution(execution);
			return false;
		}

		execution.onAbort = () => {
			this.cancelExecution(execution, "Cursor pi bridge tool execution was aborted");
			this.abortExecution(execution);
			this.finish(toolCallId);
		};
		execution.signal?.addEventListener("abort", execution.onAbort, { once: true });
		this.activeExecutions.set(toolCallId, execution);
		this.installProcessSignalHandlers();
		return true;
	}

	finish(toolCallId: string): void {
		const execution = this.activeExecutions.get(toolCallId);
		if (!execution) return;
		if (execution.onAbort) execution.signal?.removeEventListener("abort", execution.onAbort);
		this.activeExecutions.delete(toolCallId);
		this.uninstallProcessSignalHandlersIfIdle();
	}

	finishAll(): void {
		for (const toolCallId of [...this.activeExecutions.keys()]) this.finish(toolCallId);
	}

	abort(toolCallId: string, reason: string): boolean {
		const execution = this.activeExecutions.get(toolCallId);
		if (!execution) return false;
		this.cancelExecution(execution, reason);
		this.abortExecution(execution);
		this.finish(toolCallId);
		return true;
	}

	abortAll(reason: string): void {
		for (const execution of [...this.activeExecutions.values()]) {
			this.abort(execution.toolCallId, reason);
		}
	}

	getActiveCount(): number {
		return this.activeExecutions.size;
	}

	emitProcessAbortSignalForTests(signal: NodeJS.Signals): void {
		this.abortActiveExecutions(signal, { preserveProcessSignalBehavior: true });
	}

	private readonly handleSigint = (): void => {
		this.abortActiveExecutions("SIGINT");
	};

	private readonly handleSigterm = (): void => {
		this.abortActiveExecutions("SIGTERM");
	};

	private installProcessSignalHandlers(): void {
		if (this.processSignalHandlersInstalled) return;
		this.processSignalHandlersInstalled = true;
		process.on("SIGINT", this.handleSigint);
		process.on("SIGTERM", this.handleSigterm);
	}

	private uninstallProcessSignalHandlersIfIdle(): void {
		if (!this.processSignalHandlersInstalled || this.activeExecutions.size > 0) return;
		this.processSignalHandlersInstalled = false;
		process.off("SIGINT", this.handleSigint);
		process.off("SIGTERM", this.handleSigterm);
	}

	private abortActiveExecutions(
		signal: NodeJS.Signals,
		options: { preserveProcessSignalBehavior?: boolean } = {},
	): void {
		if (this.activeExecutions.size === 0) return;
		const shouldRestoreDefaultSignalBehavior =
			options.preserveProcessSignalBehavior !== true && !this.hasExternalProcessSignalListeners(signal);
		this.abortAll(`Cursor pi bridge tool execution interrupted by ${signal}`);
		if (shouldRestoreDefaultSignalBehavior) this.restoreDefaultProcessSignalBehavior(signal);
	}

	private cancelExecution(execution: CursorPiToolBridgeActiveToolExecution, reason: string): void {
		try {
			execution.cancelPending(reason);
		} catch {
			// Cancellation is best-effort during process abort/shutdown cleanup; keep aborting siblings.
		}
	}

	private abortExecution(execution: CursorPiToolBridgeActiveToolExecution): void {
		try {
			Promise.resolve(execution.abort()).catch(() => undefined);
		} catch {
			// Abort is best-effort during process abort/shutdown cleanup; keep aborting siblings.
		}
	}

	private hasExternalProcessSignalListeners(signal: NodeJS.Signals): boolean {
		const ownHandler = signal === "SIGINT" ? this.handleSigint : this.handleSigterm;
		return process.listeners(signal).some((listener) => listener !== ownHandler);
	}

	private restoreDefaultProcessSignalBehavior(signal: NodeJS.Signals): void {
		setImmediate(() => {
			process.kill(process.pid, signal);
		});
	}
}

export const bridgeToolExecutionAbortTracker = new CursorPiToolBridgeToolExecutionAbortTracker();
