import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	extractPlatformArtifactBundle,
	scanArtifacts,
	scanForSecrets,
	writeCommand,
	writeExitCode,
} from "./artifacts.mjs";
import { stopLease, warmupLease } from "./crabbox-runner.mjs";
import { LOCAL_RESUME_SUITE_BY_NAME } from "./local-resume-suites.mjs";
import {
	failSuite,
	fetchPlatformArtifactBundle,
	finalizeSuiteArtifacts,
	platformFor,
	runOnLeaseWithTransientRetry,
	stopLeaseCheck,
	writeRedactedFile,
	writeStopLeaseArtifacts,
} from "./target-runtime.mjs";

export async function executeLocalResumeSuite(
	config,
	targetName,
	suiteName,
	suiteDir,
	slug,
	leaseSession,
) {
	const startedAt = Date.now();
	let warmup = leaseSession;
	const ownsLease = !warmup;
	const variant = LOCAL_RESUME_SUITE_BY_NAME.get(suiteName);
	const prepDir = leaseSession?.livePrepDir ?? `.platform-smoke-runs/local-resume-prep-${Date.now()}-${targetName}`;
	const command = buildLocalResumeSuiteCommand(
		targetName,
		variant.script,
		prepDir,
		config.packageName ?? "pi-cursor-sdk",
		suiteName,
	);
	writeCommand(suiteDir, command);

	if (!warmup) {
		console.log(`  warmup ${targetName}...`);
		warmup = await warmupLease(targetName, slug, config);
		if (!warmup.ok) {
			writeExitCode(suiteDir, warmup.code, warmup.signal);
			writeRedactedFile(
				resolve(suiteDir, "crabbox.warmup.stdout.txt"),
				warmup.stdout,
			);
			writeRedactedFile(
				resolve(suiteDir, "crabbox.warmup.stderr.txt"),
				warmup.stderr,
			);
			return failSuite(
				suiteDir,
				targetName,
				suiteName,
				`Crabbox warmup failed (exit ${warmup.code}): ${warmup.stderr.slice(-500)}`,
			);
		}
	}

	console.log(`  executing local resume smoke on ${targetName}...`);
	const result = await runOnLeaseWithTransientRetry(
		suiteDir,
		targetName,
		warmup.leaseId,
		command,
		{
			shell: true,
			timeout: 900_000,
			allowEnv: ["CURSOR_API_KEY"],
			sync: leaseSession?.sync,
			config,
		},
	);
	const bundleTransport = await fetchPlatformArtifactBundle(targetName, warmup.leaseId, result.stdout, config);
	if (!bundleTransport.ok) result.stderr = `${result.stderr}\n[platform-smoke] ${bundleTransport.error}`.trim();
	const elapsed = Date.now() - startedAt;
	writeRedactedFile(resolve(suiteDir, "crabbox.stdout.txt"), result.stdout);
	writeRedactedFile(resolve(suiteDir, "crabbox.stderr.txt"), result.stderr);
	writeFileSync(
		resolve(suiteDir, "crabbox.timing.json"),
		JSON.stringify(
			{
				startedAt: new Date(startedAt).toISOString(),
				elapsedMs: elapsed,
				code: result.code,
				signal: result.signal,
			},
			null,
			2,
		),
	);
	writeExitCode(suiteDir, result.code, result.signal);

	const bundle = extractPlatformArtifactBundle(suiteDir, bundleTransport.stdout);
	const evidenceRoot = resolve(suiteDir, "local-resume-evidence");
	const packedPackagePath = result.stdout.match(/^PLATFORM_PACKED_PACKAGE_PATH=(.+)$/m)?.[1]?.trim();
	const evidence = summarizeLocalResumeEvidence(evidenceRoot, packedPackagePath);
	writeFileSync(resolve(suiteDir, "local-resume-evidence.json"), JSON.stringify(evidence, null, 2));

	let stopResult;
	if (ownsLease) {
		console.log(`  stopping lease ${warmup.leaseId}...`);
		stopResult = await stopLease(targetName, warmup.leaseId, config);
		writeStopLeaseArtifacts(suiteDir, stopResult);
	}

	const violations = [
		...scanForSecrets(`${result.stdout}\n${result.stderr}`).map(
			(violation) => ({ file: "process-output", violation }),
		),
		...bundle.violations,
		...scanArtifacts(suiteDir),
	];
	if (violations.length > 0)
		writeFileSync(
			resolve(suiteDir, "redaction-violations.json"),
			JSON.stringify(violations, null, 2),
		);

	const checks = [
		{ id: "local-resume-exit-zero", fn: () => result.code === 0 },
		{ id: "local-resume-bundle-extracted", fn: () => bundle.ok },
		{ id: "local-resume-session-evidence", fn: () => evidence.sessionFiles > 0 },
		{ id: "local-resume-debug-evidence", fn: () => evidence.debugFiles > 0 },
		{ id: "local-resume-runtime-evidence", fn: () => evidence.runtimeFiles > 0 },
		{ id: "local-resume-packed-extension", fn: () => evidence.packedExtensionPathMatched },
		{
			id: "local-resume-marker",
			fn: () => result.stdout.includes(variant.marker),
		},
		{
			id: "local-resume-stderr-evidence",
			fn: () => variant.stderrPattern.test(result.stderr),
		},
		{ id: "no-secrets", fn: () => violations.length === 0 },
	];
	if (stopResult) checks.push(stopLeaseCheck(stopResult));
	const expectedFiles = [
		"summary.json",
		"target.json",
		"suite.json",
		"command.txt",
		"exit-code.txt",
		"crabbox.stdout.txt",
		"crabbox.stderr.txt",
		"crabbox.timing.json",
		"local-resume-evidence.json",
		"local-resume-evidence/runtime-launches.jsonl",
		"assertions.json",
	];
	if (stopResult)
		expectedFiles.push(
			"crabbox.stop.stdout.txt",
			"crabbox.stop.stderr.txt",
			"crabbox.stop.exit-code.txt",
		);
	const { assertions } = finalizeSuiteArtifacts(
		suiteDir,
		checks,
		{
			target: targetName,
			suite: suiteName,
			exitCode: result.code,
			signal: result.signal,
			elapsedMs: elapsed,
			evidence,
		},
		expectedFiles,
	);
	console.log(
		`  ${assertions.ok ? "PASS" : "FAIL"} ${suiteName} on ${targetName} (${elapsed}ms)`,
	);
	return { ok: assertions.ok, suiteDir, assertions };
}

function normalizedTargetPath(path) {
	const normalized = String(path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
	return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function summarizeLocalResumeEvidence(root, packedPackagePath) {
	const files = [];
	function visit(dir) {
		if (!existsSync(dir)) return;
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = resolve(dir, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile()) files.push(path.slice(root.length + 1).replace(/\\/g, "/"));
		}
	}
	visit(root);
	const runtimePath = resolve(root, "runtime-launches.jsonl");
	let runtimeLaunchCount = 0;
	let runtimeRecordsValid = false;
	let runtimeExtensionPaths = [];
	try {
		const runtimeLines = readFileSync(runtimePath, "utf8").split(/\r?\n/).filter(Boolean);
		runtimeLaunchCount = runtimeLines.length;
		const parsedPaths = runtimeLines.map((line) => JSON.parse(line)?.extensionPath);
		runtimeRecordsValid = parsedPaths.every((path) => typeof path === "string");
		runtimeExtensionPaths = parsedPaths.filter((path) => typeof path === "string");
	} catch {}
	const expectedPath = normalizedTargetPath(packedPackagePath);
	return {
		root: "local-resume-evidence",
		fileCount: files.length,
		sessionFiles: files.filter((path) => path.startsWith("sessions/") && path.endsWith(".jsonl")).length,
		debugFiles: files.filter((path) => path.startsWith("debug/")).length,
		runtimeFiles: files.filter((path) => path === "runtime-launches.jsonl").length,
		packedPackagePath,
		runtimeLaunchCount,
		runtimeExtensionPaths,
		packedExtensionPathMatched: (expectedPath.startsWith("/") || /^[a-z]:\//.test(expectedPath))
			&& runtimeLaunchCount > 0
			&& runtimeRecordsValid
			&& runtimeExtensionPaths.every((path) => normalizedTargetPath(path) === expectedPath),
	};
}

function quotePosix(value) {
	return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function quotePowerShell(value) {
	return `'${String(value).replace(/'/g, "''")}'`;
}

export function buildLocalResumeSuiteCommand(
	targetName,
	script = "smoke:local-resume",
	prepDir = ".platform-smoke-runs/local-resume-prep",
	packageName = "pi-cursor-sdk",
	suiteName = "cursor-local-resume-restart",
) {
	const powershellTarget = platformFor(targetName) === "powershell";
	const evidenceDir = `${prepDir}/${powershellTarget ? "lr" : `local-resume-${suiteName}`}`;
	const packagePath = `${prepDir}/packed-workspace/node_modules/${packageName}`;
	if (powershellTarget) {
		const powershell = `$ErrorActionPreference='Stop';$p=${quotePowerShell(prepDir)};$e=$p+'/lr';$w=$e.Replace('/','\\');$x=$p+${quotePowerShell(`/packed-workspace/node_modules/${packageName}`)};node scripts/platform-smoke/live-suite-runner.mjs --prepare-only --target ${targetName} --package-name ${packageName} --prep-dir $p;if($LASTEXITCODE){exit $LASTEXITCODE};for($i=0;$i -lt 10 -and (Test-Path -LiteralPath $e);$i++){cmd.exe /d /c rd /s /q $w;if(Test-Path -LiteralPath $e){Start-Sleep -Milliseconds 200}};if(Test-Path -LiteralPath $e){throw 'local-resume evidence cleanup failed'};$env:CURSOR_LOCAL_RESUME_SMOKE_EXTENSION_PATH=$x;$env:CURSOR_LOCAL_RESUME_SMOKE_ARTIFACT_DIR=$e;$env:CURSOR_LOCAL_RESUME_SMOKE_KEEP_ARTIFACTS='1';$env:CURSOR_LOCAL_RESUME_SMOKE_EMIT_BUNDLE='1';npm run ${script}`;
		return `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(powershell, "utf16le").toString("base64")}`;
	}
	const prep = `node scripts/platform-smoke/live-suite-runner.mjs --prepare-only --target ${quotePosix(targetName)} --package-name ${quotePosix(packageName)} --prep-dir ${quotePosix(prepDir)}`;
	return `${prep} && rm -rf ${quotePosix(evidenceDir)} && CURSOR_LOCAL_RESUME_SMOKE_EXTENSION_PATH=${quotePosix(packagePath)} CURSOR_LOCAL_RESUME_SMOKE_ARTIFACT_DIR=${quotePosix(evidenceDir)} CURSOR_LOCAL_RESUME_SMOKE_KEEP_ARTIFACTS=1 CURSOR_LOCAL_RESUME_SMOKE_EMIT_BUNDLE=1 npm run ${script}`;
}
