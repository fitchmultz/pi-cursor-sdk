import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	decodeCanonicalBase64,
	MAX_COMPRESSED_BUNDLE_BYTES,
	PLATFORM_ARTIFACT_BUNDLE_END,
	PLATFORM_ARTIFACT_BUNDLE_FILE_MARKER,
	PLATFORM_ARTIFACT_BUNDLE_PATH,
	PLATFORM_ARTIFACT_BUNDLE_START,
} from "./artifact-bundle-contract.mjs";
import { redactSecrets } from "./artifact-secrets.mjs";
import {
	scanArtifacts,
	writeCommand,
	writeExitCode,
	writeManifest,
	writeSummary,
} from "./artifacts.mjs";
import { runAssertions } from "./assertions.mjs";
import { runOnLease } from "./crabbox-runner.mjs";

export function platformFor(targetName) {
	return targetName === "windows-native" ? "powershell" : "posix";
}

export function finalizeSuiteArtifacts(
	suiteDir,
	checks,
	summaryData,
	expectedFiles,
) {
	const malformed = scanArtifacts(suiteDir).filter(({ violation }) => violation.startsWith("invalid JSON"));
	checks = [...checks, {
		id: "structured-artifacts-parseable",
		fn: () => malformed.length === 0,
		error: malformed.map(({ file, violation }) => `${file}: ${violation}`).join("; "),
	}];
	const assertions = runAssertions(suiteDir, checks);
	writeSummary(suiteDir, { ...summaryData, ok: assertions.ok });
	const expected = assertions.ok
		? expectedFiles
		: [...expectedFiles, "failures.md"];
	const manifest = writeManifest(suiteDir, expected);
	if (manifest.missing.length === 0) return { assertions, manifest };

	const finalAssertions = runAssertions(suiteDir, [
		...checks,
		{
			id: "artifact-manifest-complete",
			fn: () => false,
			error: `missing required artifact(s): ${manifest.missing.join(", ")}`,
		},
	]);
	writeSummary(suiteDir, { ...summaryData, ok: false });
	const finalManifest = writeManifest(suiteDir, [
		...expectedFiles,
		"failures.md",
	]);
	return { assertions: finalAssertions, manifest: finalManifest };
}

export function writeRedactedFile(path, content) {
	writeFileSync(path, redactSecrets(content ?? ""));
}

export function writeStopLeaseArtifacts(suiteDir, stopResult) {
	writeRedactedFile(
		resolve(suiteDir, "crabbox.stop.stdout.txt"),
		stopResult.stdout ?? "",
	);
	writeRedactedFile(
		resolve(suiteDir, "crabbox.stop.stderr.txt"),
		stopResult.stderr ?? "",
	);
	writeFileSync(
		resolve(suiteDir, "crabbox.stop.exit-code.txt"),
		`code=${stopResult.code}\nsignal=${stopResult.signal ?? "none"}\n`,
	);
}

export function stopLeaseCheck(stopResult) {
	return {
		id: "lease-stop",
		fn: () => stopResult?.code === 0,
		error: `Crabbox stop failed (exit ${stopResult?.code ?? "unknown"}); check crabbox.stop.stderr.txt`,
	};
}

export async function runOnLeaseWithTransientRetry(
	suiteDir,
	targetName,
	leaseId,
	command,
	options,
	run = runOnLease,
) {
	const first = await run(targetName, leaseId, command, options);
	if (!isTransientCrabboxSshFailure(first)) return first;
	writeRedactedFile(
		resolve(suiteDir, "crabbox.retry1.stdout.txt"),
		first.stdout,
	);
	writeRedactedFile(
		resolve(suiteDir, "crabbox.retry1.stderr.txt"),
		first.stderr,
	);
	await new Promise((resolveRetry) => setTimeout(resolveRetry, 10_000));
	return await run(targetName, leaseId, command, { ...options, sync: false });
}

const ARTIFACT_CHUNK_BYTES = 32 * 1024;

export async function fetchPlatformArtifactBundle(targetName, leaseId, stdout, config, run = runOnLease) {
	const markerLine = stdout.split(/\r?\n/).find((line) => line.startsWith(PLATFORM_ARTIFACT_BUNDLE_FILE_MARKER));
	if (!markerLine) return { ok: true, stdout };
	let metadata;
	try {
		metadata = JSON.parse(markerLine.slice(PLATFORM_ARTIFACT_BUNDLE_FILE_MARKER.length));
	} catch {
		return { ok: false, stdout, error: "invalid platform artifact bundle file marker" };
	}
	if (
		metadata?.encoding !== "gzip" ||
		metadata.path !== PLATFORM_ARTIFACT_BUNDLE_PATH ||
		!Number.isSafeInteger(metadata.size) ||
		metadata.size < 1 ||
		metadata.size > MAX_COMPRESSED_BUNDLE_BYTES ||
		!/^[0-9a-f]{64}$/i.test(metadata.sha256)
	) {
		return { ok: false, stdout, error: "unsafe platform artifact bundle file metadata" };
	}
	const chunks = [];
	for (let offset = 0; offset < metadata.size; offset += ARTIFACT_CHUNK_BYTES) {
		const length = Math.min(ARTIFACT_CHUNK_BYTES, metadata.size - offset);
		const result = await run(
			targetName,
			leaseId,
			[
				"node",
				"scripts/platform-smoke/artifact-bundle-chunk.mjs",
				"--path", metadata.path,
				"--offset", String(offset),
				"--length", String(length),
			],
			{ timeout: 120_000, sync: false, config },
		);
		if (result.code !== 0) return { ok: false, stdout, error: `artifact chunk ${offset} failed: ${result.stderr || result.stdout}` };
		const chunkLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith("PLATFORM_BUNDLE_CHUNK_JSON="));
		try {
			const chunk = JSON.parse(chunkLine?.slice("PLATFORM_BUNDLE_CHUNK_JSON=".length));
			if (chunk.offset !== offset || chunk.total !== metadata.size || chunk.bytes !== length) {
				return { ok: false, stdout, error: `artifact chunk ${offset} failed validation` };
			}
			const content = decodeCanonicalBase64(chunk.contentBase64, length);
			if (!content) {
				return { ok: false, stdout, error: `artifact chunk ${offset} failed validation` };
			}
			chunks.push(content);
		} catch {
			return { ok: false, stdout, error: `artifact chunk ${offset} was malformed` };
		}
	}
	const compressed = Buffer.concat(chunks);
	if (createHash("sha256").update(compressed).digest("hex") !== metadata.sha256) {
		return { ok: false, stdout, error: "platform artifact bundle checksum mismatch" };
	}
	const envelope = {
		encoding: "gzip-base64",
		size: compressed.length,
		sha256: metadata.sha256,
		contentBase64: compressed.toString("base64"),
	};
	return {
		ok: true,
		stdout: `${PLATFORM_ARTIFACT_BUNDLE_START}\n${JSON.stringify(envelope)}\n${PLATFORM_ARTIFACT_BUNDLE_END}\n`,
	};
}

function isTransientCrabboxSshFailure(result) {
	const text = `${result.stdout}\n${result.stderr}`;
	return (
		result.code === 255 &&
		/ssh: connect to host .*\b(Operation timed out|Connection timed out)\b/i.test(
			text,
		)
	);
}

export function failSuite(suiteDir, targetName, suiteName, message) {
	const safeMessage = redactSecrets(message);
	console.log(`  FAIL ${suiteName} on ${targetName}: ${safeMessage}`);

	writeCommand(suiteDir, `# ${suiteName} — ${safeMessage}`);
	writeExitCode(suiteDir, 1, null);

	const checks = [{ id: "execution", fn: () => false, error: safeMessage }];
	const { assertions } = finalizeSuiteArtifacts(
		suiteDir,
		checks,
		{ target: targetName, suite: suiteName, exitCode: 1, error: safeMessage },
		[
			"summary.json",
			"target.json",
			"suite.json",
			"command.txt",
			"exit-code.txt",
			"assertions.json",
		],
	);

	return { ok: false, suiteDir, assertions };
}
