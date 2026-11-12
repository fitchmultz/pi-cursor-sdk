/**
 * Pi RPC request state for one smoke child: strict JSONL framing, request IDs, per-request
 * timeouts and a single close path. Callers own process termination and route the child's
 * close/error events to close() under their own shutdown policy.
 */
export function createPiRpcChannel(child, { idPrefix }) {
	const events = [];
	const pending = new Map();
	let requestId = 0;
	let stdoutBuffer = "";
	let stderr = "";
	let closeReason;

	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	// Pi frames records with LF only; U+2028/U+2029 stay inside JSON strings, so no readline.
	child.stdout.on("data", (chunk) => {
		stdoutBuffer += chunk;
		let newlineIndex;
		while ((newlineIndex = stdoutBuffer.indexOf("\n")) >= 0) {
			const line = stdoutBuffer.slice(0, newlineIndex);
			stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
			if (!line.trim()) continue;
			let message;
			try {
				message = JSON.parse(line);
			} catch {
				continue;
			}
			const request = message.type === "response" ? pending.get(message.id) : undefined;
			if (!request) events.push(message);
			else if (!closeReason) {
				pending.delete(message.id);
				clearTimeout(request.timer);
				request.resolve(message);
			}
		}
	});

	// The first reason wins. Responses stop settling at once; pending and later requests reject
	// with the reason once it resolves, so a caller can hold settlement behind its own shutdown.
	const close = (reason) => {
		if (closeReason) return;
		closeReason = Promise.resolve(reason);
		for (const request of pending.values()) clearTimeout(request.timer);
		void closeReason.then((error) => {
			for (const request of pending.values()) request.reject(error);
			pending.clear();
		});
	};

	const send = (type, extra = {}, timeoutMs = 120_000) => {
		if (closeReason) return closeReason.then((error) => Promise.reject(error));
		return new Promise((resolve, reject) => {
			const id = `${idPrefix}_${++requestId}`;
			const record = `${JSON.stringify({ id, type, ...extra })}\n`;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`timeout waiting for ${type}. Stderr: ${stderr}`));
			}, timeoutMs);
			pending.set(id, { resolve, reject, timer });
			child.stdin.write(record);
		});
	};

	return {
		events,
		send,
		close,
		get stderr() {
			return stderr;
		},
	};
}
