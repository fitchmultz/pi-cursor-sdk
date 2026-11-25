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
function extractEntryText(entry) {
	if (typeof entry?.content === "string") return entry.content;
	if (Array.isArray(entry?.content)) return entry.content.map(part => part?.text ?? "").join("");
	if (typeof entry?.output === "string") return entry.output;
	return "";
}
function formatResponsesSse(model, calls, content) {
	const responseId = `resp_offline_${request}`;
	const events = [{ type: "response.created", response: { id: responseId, status: "in_progress", model, output: [] } }];
	const output = [];
	if (calls) {
		calls.forEach((call, output_index) => {
			const itemId = `fc_${call.id}`;
			const added = { type: "function_call", id: itemId, call_id: call.id, name: call.function.name, arguments: "", status: "in_progress" };
			const done = { ...added, arguments: call.function.arguments, status: "completed" };
			events.push(
				{ type: "response.output_item.added", output_index, item: added },
				{ type: "response.function_call_arguments.delta", output_index, item_id: itemId, delta: call.function.arguments },
				{ type: "response.output_item.done", output_index, item: done },
			);
			output.push(done);
		});
	} else {
		const itemId = `msg_${request}`;
		const added = { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] };
		const done = { ...added, status: "completed", content: [{ type: "output_text", text: content, annotations: [] }] };
		events.push(
			{ type: "response.output_item.added", output_index: 0, item: added },
			{ type: "response.output_text.delta", output_index: 0, item_id: itemId, content_index: 0, delta: content },
			{ type: "response.output_item.done", output_index: 0, item: done },
		);
		output.push(done);
	}
	events.push({ type: "response.completed", response: { id: responseId, status: "completed", model, output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
	return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}
async function offlineFetch(url, options) {
	const targetUrl = String(url);
	const isResponses = /^https:\/\/api\.z\.ai\/api\/v1\/responses$/.test(targetUrl);
	const isCompletions = /^https:\/\/api\.z\.ai\/api\/coding\/paas\/v4\/chat\/completions$/.test(targetUrl);
	assert.ok(isResponses || isCompletions, `unexpected Z.ai endpoint: ${targetUrl}`);
	const body = JSON.parse(options.body);
	appendFileSync(scenario.requests, JSON.stringify(body) + "\n");
	const entries = isResponses ? (Array.isArray(body.input) ? body.input : []) : (body.messages ?? []);
	const text = [typeof body.instructions === "string" ? body.instructions : "", ...entries.map(extractEntryText)].join("\n");
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
		const feedback = entries.findLast(message => JSON.stringify(message).includes("Release review read coverage:"));
		assert.ok(feedback, "correction must be requested by native boundary feedback, not the test transport");
		const contents = extractEntryText(feedback);
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
		const last = entries.at(-1);
		const lastIsToolResult = last?.role === "tool" || last?.type === "function_call_output";
		if (!lastIsToolResult) { calls = reads(paths); finish = "tool_calls"; }
		else content = report();
	} else content = report();
	if (scenario.kind === "error") return new Response(JSON.stringify({ error: { message: "offline unrecoverable model error" } }), { status: 400 });
	if (scenario.kind === "aborted") {
		abort();
		throw new DOMException("offline transport aborted", "AbortError");
	}
	if (isResponses) {
		return new Response(formatResponsesSse(body.model, calls, content), { headers: { "Content-Type": "text/event-stream" } });
	}
	const delta = { role: "assistant", ...(calls ? { tool_calls: calls.map((call, index) => ({ index, ...call })) } : { content }) };
	const chunk = { id: `offline-${request}`, object: "chat.completion.chunk", created: 1, model: body.model,
		choices: [{ index: 0, delta, finish_reason: null }] };
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
		{ headers: { "Content-Type": "text/event-stream" } });
}
