export const DEFAULT_CHILD_SHUTDOWN_GRACE_MS = 2_000;
export const CHILD_PROCESS_TREE_SPAWN_OPTIONS = Object.freeze({
	detached: true,
});

// Node emits 'close' only after the process ends and its piped output streams close; 'exit' can
// come first, e.g. while a descendant still holds the inherited stdout.
function isChildClosed(child) {
	if (child.exitCode === null && child.signalCode === null) return false;
	return child.stdio.every((stream, fd) => fd === 0 || !stream || stream.closed);
}

export function waitForChildClose(child) {
	if (isChildClosed(child)) return Promise.resolve(child.exitCode ?? 1);
	return new Promise((resolve) => {
		child.once("close", (code) => resolve(code ?? 1));
	});
}

export function signalChild(child, signal) {
	if (!child.pid) return;
	try {
		process.kill(-child.pid, signal);
	} catch {
		try {
			child.kill(signal);
		} catch {
			// child already exited
		}
	}
}

function waitForChildCloseWithin(child, timeoutMs) {
	if (isChildClosed(child)) return Promise.resolve(true);
	return new Promise((resolve) => {
		const finish = (closed) => {
			clearTimeout(timer);
			child.off("close", onClose);
			resolve(closed);
		};
		const onClose = () => finish(true);
		const timer = setTimeout(() => finish(false), timeoutMs);
		child.once("close", onClose);
	});
}

function posixProcessGroupExists(pid) {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return error?.code !== "ESRCH";
	}
}

async function waitForPosixProcessGroupExit(pid, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (posixProcessGroupExists(pid) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
	}
	return !posixProcessGroupExists(pid);
}

export async function terminateChild(child, { graceMs = DEFAULT_CHILD_SHUTDOWN_GRACE_MS } = {}) {
	const pid = child.pid;
	if (!pid) return;
	const timeoutMs = Number.isFinite(graceMs) ? Math.max(1, Math.trunc(graceMs)) : DEFAULT_CHILD_SHUTDOWN_GRACE_MS;
	try {
		child.stdin?.end?.();
	} catch {
		child.stdin?.destroy?.();
	}
	await waitForChildCloseWithin(child, timeoutMs);

	if (posixProcessGroupExists(pid)) signalChild(child, "SIGTERM");
	let groupExited = await waitForPosixProcessGroupExit(pid, timeoutMs);
	if (!groupExited) {
		signalChild(child, "SIGKILL");
		groupExited = await waitForPosixProcessGroupExit(pid, timeoutMs);
	}
	const childClosed = await waitForChildCloseWithin(child, timeoutMs);
	if (!groupExited || !childClosed) {
		throw new Error(`failed to verify termination of POSIX process tree rooted at ${pid}`);
	}
}

// Names how a process ended from its native receipt: by the signal when one ended it, otherwise by the exit code.
// On a signal death Node's close reports code null and node-pty reports a placeholder exitCode 0.
export function describeProcessExit(code, signal) {
	return signal ? `signal ${signal}` : `exit code ${code}`;
}

export function parseJsonLines(stdout) {
	const events = [];
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			// ignore partial lines
		}
	}
	return events;
}
