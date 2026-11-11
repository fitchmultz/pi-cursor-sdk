import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { writeRawTestEvidence } from "./helpers/raw-test-evidence.mjs";

const cli = process.env.PI_HOST_CLI;
const script = process.env.REVIEW_NATIVE_SCRIPT ?? fileURLToPath(new URL("../scripts/release-review.mjs", import.meta.url));
const transport = fileURLToPath(new URL("./fixtures/release-review-model-transport.mjs", import.meta.url));
if (cli && process.env.PI_COMPAT_EXPECTED_PACKAGE_DIR) {
	const packageDir = process.env.PI_COMPAT_EXPECTED_PACKAGE_DIR;
	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	assert.equal(manifest.version, process.env.PI_COMPAT_EXPECTED_VERSION);
	assert.equal(realpathSync(cli), realpathSync(join(packageDir, manifest.bin.pi)));
}
function command(cwd, args) {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result.stdout.trim();
}
for (const kind of ["corrects", "second-gap", "progresses", "complete", "refuses", "incomplete", "incomplete-after-correction", "limited", "wrong-scope", "finding", "error", "aborted"]) {
	test(`native release-review read feedback: ${kind}`, { skip: !cli && "select a current native host with PI_HOST_CLI" }, (t) => {
		const root = mkdtempSync(join(tmpdir(), "review-native-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		const repo = join(root, "repo"), bin = join(root, "bin"), skill = join(root, "skill");
		for (const path of [repo, bin, join(skill, "references")]) mkdirSync(path, { recursive: true });
		command(repo, ["init", "--quiet"]);
		command(repo, ["config", "user.email", "native-review@example.invalid"]);
		command(repo, ["config", "user.name", "Native Review Test"]);
		const lines = n => Array.from({ length: n }, (_, i) => `entry ${i + 1}`).join("\n") + "\n";
		writeFileSync(join(repo, "catalog.json"), lines(100));
		writeFileSync(join(repo, "previous-release.json"), lines(188));
		command(repo, ["add", "."]); command(repo, ["commit", "--quiet", "-m", "base"]);
		writeFileSync(join(repo, "catalog.json"), lines(99) + "changed\n");
		unlinkSync(join(repo, "previous-release.json"));
		command(repo, ["add", "."]);
		const context = join(root, "npm-pack.json");
		writeFileSync(context, kind === "complete" ? "complete context\n" : lines(13802));
		writeFileSync(join(skill, "SKILL.md"), "Read the complete exact diff and changed files.\n");
		writeFileSync(join(skill, "references/review-rubric.md"), "Report all material findings.\n");
		const scenario = join(root, "scenario.json"), requests = join(root, "requests.jsonl");
		writeFileSync(scenario, JSON.stringify({ repo: command(repo, ["rev-parse", "--show-toplevel"]), kind, requests }));
		const wrapper = join(bin, process.platform === "win32" ? "pi.cjs" : "pi");
		writeFileSync(wrapper, `#!/usr/bin/env node\nconst cp = require("node:child_process");\nconst result = cp.spawnSync(${JSON.stringify(process.execPath)}, [${JSON.stringify(cli)}, "--extension", ${JSON.stringify(transport)}, ...process.argv.slice(2)], {stdio:"inherit", env:{...process.env, REVIEW_NATIVE_SCENARIO:${JSON.stringify(scenario)}}});\nif (result.error) throw result.error;\nprocess.exit(result.status ?? 1);\n`);
		chmodSync(wrapper, 0o755);
		if (process.platform === "win32") writeFileSync(join(bin, "pi.cmd"), `@"${process.execPath}" "%~dp0pi.cjs" %*\r\n`);
		const receipt = join(root, "review.json");
		const result = spawnSync(process.execPath, [script, "pre-commit", "--review-context", context, "--receipt", receipt], {
			cwd: repo, encoding: "utf8", env: { PATH: [dirname(process.execPath), bin, process.env.PATH].join(delimiter),
				HOME: root, PI_RELEASE_REVIEW_SKILL: join(skill, "SKILL.md"), ZAI_API_KEY: "offline-model-transport-only",
				PI_RELEASE_REVIEW_FEEDBACK_INPUT: "ambient-value-must-not-reach-the-review" },
		});
		const eventsText = readFileSync(`${receipt}.events.jsonl`, "utf8");
		const events = eventsText.split("\n").filter(Boolean).map(line => JSON.parse(line));
		const stderr = readFileSync(`${receipt}.stderr.log`, "utf8");
		if (process.env.PI_CURSOR_TEST_EVIDENCE_DIR) {
			for (const [name, value] of Object.entries({ "events.jsonl": eventsText, "stderr.log": stderr,
				"result.json": JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }),
				"requests.jsonl": existsSync(requests) ? readFileSync(requests, "utf8") : "", "receipt.json": readFileSync(receipt, "utf8") })) {
				writeRawTestEvidence(process.env.PI_CURSOR_TEST_EVIDENCE_DIR, `${kind}-${name}`, value);
			}
		}
		const expectedPass = ["corrects", "second-gap", "progresses", "complete"].includes(kind);
		assert.equal(result.status, expectedPass ? 0 : 1, result.stderr + stderr);
		const bodies = readFileSync(requests, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
		const feedback = [...new Set(bodies.flatMap(body => body.messages.flatMap(message => {
			const content = typeof message.content === "string" ? message.content : message.content?.map(part => part.text ?? "").join("") ?? "";
			return content.startsWith("Release review read coverage:") ? [content] : [];
		})))];
		assert.equal(feedback.length, ["complete", "error", "aborted", "incomplete", "limited", "wrong-scope"].includes(kind) ? 0 : kind === "progresses" ? 2 : 1, stderr);
		if (["corrects", "second-gap", "progresses", "incomplete-after-correction", "finding"].includes(kind)) {
			if (kind === "second-gap") assert.match(JSON.stringify(feedback), /1581,13802/);
			else {
				assert.match(JSON.stringify(feedback), /missingRanges.*1,40/);
				assert.match(JSON.stringify(feedback), /421,13743/);
				assert.match(JSON.stringify(feedback), /121,188/);
			}
			assert.equal(events.filter(event => event.type === "agent_settled").length, 1);
			assert.equal(events.filter(event => event.type === "agent_start").length, kind === "progresses" ? 3 : 2);
			assert.equal(events.at(-1).type, "agent_settled");
		}
		if (kind === "refuses") {
			assert.match(result.stderr, /Incomplete read of supplied review context/);
			assert.equal(bodies.length, 3, "unchanged missing evidence must settle without another paid request");
			assert.equal(events.filter(event => event.type === "agent_settled").length, 1);
		}
		if (kind.startsWith("incomplete")) assert.match(result.stderr, /marked the review incomplete/);
		if (kind === "wrong-scope") assert.match(result.stderr, /identifies a different scope/);
		if (kind === "finding") assert.match(result.stderr, /Review has findings/);
		if (kind === "limited") assert.match(result.stderr, /Incomplete read of supplied review context/);
		if (kind === "aborted") {
			assert.deepEqual(events.filter(event => event.type === "agent_settled"), [{ type: "agent_settled", aborted: true }]);
			assert.equal(events.findLast(event => event.type === "message_end" && event.message?.role === "assistant").message.stopReason, "aborted");
		}
		if (kind === "complete") assert.equal(events.filter(event => event.type === "agent_start").length, 1);
	});
}
