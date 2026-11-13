// Only the external Z.ai HTTP transport is substituted. The CLI, provider parser,
// read tool, extension loader, continuation scheduler and final gate are real.
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const scenario = JSON.parse(readFileSync(process.env.REVIEW_NATIVE_SCENARIO, "utf8"));
let request = 0;
let scope;
let inputPath;
let abort;
function report() {
	return JSON.stringify({ scopeId: scenario.kind === "wrong-scope" ? "different-scope" : scope.scopeId, completed: scenario.kind !== "incomplete" && !(scenario.kind === "incomplete-after-correction" && request > 2),
		findings: scenario.kind === "finding"
			? [{ path: "catalog.json", line: 1, material: true, description: "Retained review finding", remedy: "Fix it" }] : [],
		materialLimitations: scenario.kind === "limited" ? ["Required contract unavailable"] : [], summary: "Reviewed the exact supplied scope." });
}
function reads(paths) {
	return paths.map((args, index) => ({ id: `read_${request}_${index}`, type: "function",
		function: { name: "read", arguments: JSON.stringify(args) } }));
}
export default function installOfflineModelTransport(pi) {
	globalThis.fetch = offlineFetch;
	pi.on("before_provider_request", (_event, ctx) => { abort = () => ctx.abort(); });
}
async function offlineFetch(url, options) {
	assert.match(String(url), /^https:\/\/api\.z\.ai\/api\/coding\/paas\/v4\/chat\/completions$/);
	const body = JSON.parse(options.body);
	appendFileSync(scenario.requests, JSON.stringify(body) + "\n");
	const text = body.messages.map(message => typeof message.content === "string" ? message.content
		: message.content?.map(part => part.text ?? "").join("") ?? "").join("\n");
	if (!scope) {
		// The @prompt file is expanded by native Pi before the provider request.
		inputPath = /Read ((?:[A-Za-z]:)?[\\/][^\r\n]+?[\\/]review-input\.json) for immutable identities/.exec(text)?.[1];
		assert.ok(inputPath, "native prompt expansion must include the immutable input path");
		scope = JSON.parse(readFileSync(inputPath, "utf8"));
	}
	request++;
	let calls;
	let content = null;
	let finish = "stop";
	if (request === 1 && !["error", "aborted"].includes(scenario.kind)) {
		const paths = [inputPath, scope.patch, scope.commits];
		if (["complete", "second-gap"].includes(scenario.kind)) paths.push(join(scenario.repo, "catalog.json"), join(scope.sourceBase, "previous-release.json"));
		if (scenario.kind === "complete") paths.push(scope.reviewContext.path);
		calls = reads(paths.map(path => ({ path })));
		if (scenario.kind === "second-gap") calls.push(...reads([
			{ path: scope.reviewContext.path, offset: 1, limit: 80 },
			{ path: scope.reviewContext.path, offset: 81, limit: 1500 },
		]));
		else if (scenario.kind !== "complete") calls.push(...reads([
			{ path: join(scope.sourceBase, "catalog.json"), offset: 1, limit: 40 },
			{ path: join(scenario.repo, "catalog.json"), offset: 41, limit: 200 },
			{ path: join(scope.sourceBase, "previous-release.json"), offset: 1, limit: 120 },
			{ path: scope.reviewContext.path, offset: 1, limit: 420 },
			{ path: scope.reviewContext.path, offset: 13744, limit: 59 },
		]));
		// Distinct IDs across both batches are required by the native tool ledger.
		calls.forEach((call, index) => { call.id = `read_${request}_${index}`; });
		finish = "tool_calls";
	} else if (request > 2 && !["refuses", "error", "aborted"].includes(scenario.kind)) {
		const feedback = body.messages.findLast(message => JSON.stringify(message).includes("Release review read coverage:"));
		assert.ok(feedback, "correction must be requested by native boundary feedback, not the test transport");
		const contents = typeof feedback.content === "string" ? feedback.content : feedback.content.map(part => part.text ?? "").join("");
		const missing = JSON.parse(contents.slice(contents.indexOf("\n[") + 1));
		const paths = (scenario.kind === "progresses" && request === 3 ? missing.slice(0, 1) : missing).flatMap(entry => {
			const alternative = entry.alternatives[0];
			if (alternative.unopened) return [{ path: alternative.path }];
			return alternative.missingRanges.flatMap(([first, last]) => {
				const pages = [];
				for (let offset = first; offset <= last; offset += 1000) pages.push({ path: alternative.path, offset, limit: Math.min(1000, last - offset + 1) });
				return pages;
			});
		});
		// A correction request is followed by a normal final model response.
		const last = body.messages.at(-1);
		if (last.role !== "tool") { calls = reads(paths); finish = "tool_calls"; }
		else content = report();
	} else content = report();
	if (scenario.kind === "error") return new Response(JSON.stringify({ error: { message: "offline unrecoverable model error" } }), { status: 400 });
	if (scenario.kind === "aborted") {
		abort();
		throw new DOMException("offline transport aborted", "AbortError");
	}
	const delta = { role: "assistant", ...(calls ? { tool_calls: calls.map((call, index) => ({ index, ...call })) } : { content }) };
	const chunk = { id: `offline-${request}`, object: "chat.completion.chunk", created: 1, model: body.model,
		choices: [{ index: 0, delta, finish_reason: null }] };
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
		{ headers: { "Content-Type": "text/event-stream" } });
}
