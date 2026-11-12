import { execFile } from "node:child_process";

export const DEFAULT_CHILD_SHUTDOWN_GRACE_MS = 2_000;
export const CHILD_PROCESS_TREE_SPAWN_OPTIONS = Object.freeze({
	detached: process.platform !== "win32",
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
		if (process.platform === "win32") {
			child.kill(signal);
		} else {
			process.kill(-child.pid, signal);
		}
	} catch {
		try {
			child.kill(signal);
		} catch {
			// child already exited
		}
	}
}

function runHiddenWindowsCommand(command, args, timeoutMs) {
	return new Promise((resolve) => {
		let settled = false;
		let timer;
		const finish = (succeeded) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(succeeded);
		};
		const child = execFile(
			command,
			args,
			{ maxBuffer: 64 * 1024, timeout: timeoutMs, windowsHide: true },
			(error) => finish(error === null),
		);
		timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(false);
		}, timeoutMs);
	});
}

async function terminateWindowsProcessTree(pid, timeoutMs) {
	if (await runHiddenWindowsCommand("taskkill", ["/PID", String(pid), "/T", "/F"], timeoutMs)) return true;

	const script = `
$ErrorActionPreference = "Stop"
$rootPid = [uint32]${pid}
$deadline = [DateTime]::UtcNow.AddMilliseconds(${timeoutMs})
try {
	$processes = @(Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId)
	$queue = [Collections.Generic.Queue[uint32]]::new()
	$descendants = [Collections.Generic.List[uint32]]::new()
	$seen = [Collections.Generic.HashSet[uint32]]::new()
	$queue.Enqueue($rootPid)
	while ($queue.Count -gt 0) {
		$parentPid = $queue.Dequeue()
		foreach ($process in $processes) {
			$childPid = [uint32]$process.ProcessId
			if ([uint32]$process.ParentProcessId -eq $parentPid -and $seen.Add($childPid)) {
				$descendants.Add($childPid)
				$queue.Enqueue($childPid)
			}
		}
	}
	for ($index = $descendants.Count - 1; $index -ge 0; $index--) {
		Stop-Process -Id $descendants[$index] -Force -ErrorAction SilentlyContinue
	}
	Stop-Process -Id $rootPid -Force -ErrorAction SilentlyContinue
	$targets = @($rootPid) + @($descendants)
	do {
		$alive = @(Get-Process -Id $targets -ErrorAction SilentlyContinue)
		if ($alive.Count -eq 0) { exit 0 }
		Start-Sleep -Milliseconds 25
	} while ([DateTime]::UtcNow -lt $deadline)
} catch {}
exit 1
`;
	return runHiddenWindowsCommand(
		"powershell.exe",
		["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
		timeoutMs,
	);
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
	if (process.platform === "win32") {
		// CIM enumeration can exceed a short graceful-shutdown window on a busy Windows VM;
		// keep the process-tree discovery bounded but give orphan lookup a stable floor.
		const treeTimeoutMs = Math.max(timeoutMs, 15_000);
		if (!(await terminateWindowsProcessTree(pid, treeTimeoutMs))) {
			signalChild(child, "SIGTERM");
			if (!(await waitForChildCloseWithin(child, timeoutMs))) {
				signalChild(child, "SIGKILL");
				await waitForChildCloseWithin(child, timeoutMs);
			}
			throw new Error(`failed to verify termination of Windows process tree rooted at ${pid}`);
		}
		if (!(await waitForChildCloseWithin(child, timeoutMs))) {
			throw new Error(`Windows process tree exited but child ${pid} did not close`);
		}
		return;
	}

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
