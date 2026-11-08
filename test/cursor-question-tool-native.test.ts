import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
	JsonAgentSessionEvent,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { attachJsonlLineReader } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/jsonl.js";
import { CURSOR_ASK_QUESTION_BLOCKED_EVENT, CURSOR_ASK_QUESTION_TOOL_NAME } from "../src/cursor-question-tool.js";
import { isolatedPiEnv, piCli } from "./helpers/project-trust-contract-fixture.js";

type RpcOutput = RpcResponse | RpcExtensionUIRequest | JsonAgentSessionEvent;
type UiRequest<Method extends RpcExtensionUIRequest["method"]> = Extract<RpcExtensionUIRequest, { method: Method }>;

// Real Pi CLI in RPC mode: the installed host owns the dialog subprotocol, abort command, agent loop and tool signal.
// Only the model is an offline fixture that calls cursor_ask_question with the prompt's JSON arguments.
it.each([
	{ dialog: "select", wasCustom: false },
	{ dialog: "input", wasCustom: true },
] as const)("dismisses a pending native RPC $dialog dialog and asks no later question on abort", async ({ dialog, wasCustom }) => {
	const root = mkdtempSync(join(tmpdir(), "cursor-question-rpc-"));
	mkdirSync(join(root, "home"));
	const child = spawn(process.execPath, [
		piCli, "--mode", "rpc", "--no-session", "--no-approve", "--no-extensions", "--no-skills", "--no-prompt-templates",
		"--no-themes", "--no-context-files", "--offline", "-e", resolve("test/fixtures/cursor-question-rpc-extension.ts"),
		"--model", "cursor/question-proof",
	], { cwd: root, env: { ...isolatedPiEnv(join(root, "home"), join(root, "agent")), PI_CURSOR_ASK_QUESTION: "1" } });
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	child.stdin.on("error", (error) => { stderr += `\nstdin: ${error.message}`; });
	const lines: RpcOutput[] = [];
	const stopReading = attachJsonlLineReader(child.stdout, (line) => { lines.push(JSON.parse(line) as RpcOutput); });
	const send = (message: RpcCommand | RpcExtensionUIResponse) => child.stdin.write(`${JSON.stringify(message)}\n`);
	const uiRequests = <Method extends RpcExtensionUIRequest["method"]>(method: Method) =>
		lines.filter((line): line is UiRequest<Method> => line.type === "extension_ui_request" && line.method === method);
	const waitFor = <T>(find: () => T | undefined, pending: string, timeout: number) => vi.waitFor(() => {
		const found = find();
		if (found === undefined) throw new Error(`${pending}\n${stderr}`);
		return found;
	}, { timeout, interval: 10 });
	try {
		send({ id: "prompt", type: "prompt", message: JSON.stringify({ questions: [
			{ id: "first", question: "First?", options: ["A", "B"] },
			{ id: "second", question: "Second?", options: ["C", "D"] },
		] }) });
		const select = await waitFor(() => uiRequests("select")[0], "Pi did not open the first question dialog", 15_000);
		expect(select).toMatchObject({ title: "First?", options: ["A", "B", "Type a custom answer"] });
		if (dialog === "input") {
			send({ type: "extension_ui_response", id: select.id, value: "Type a custom answer" });
			const input = await waitFor(() => uiRequests("input")[0], "Pi did not open the custom answer dialog", 15_000);
			expect(input).toMatchObject({ title: "First?", placeholder: "Type your answer" });
		}

		send({ id: "abort", type: "abort" });
		const abort = await waitFor(() => lines.find((line) => line.type === "response" && line.id === "abort"),
			`RPC abort stayed pending behind the open ${dialog} dialog`, 10_000);

		expect(abort).toMatchObject({ command: "abort", success: true });
		expect(uiRequests("select").map((request) => request.title)).toEqual(["First?"]);
		expect(uiRequests("input").map((request) => request.title)).toEqual(dialog === "input" ? ["First?"] : []);
		expect(lines.find((line) => line.type === "tool_execution_end" && line.toolName === CURSOR_ASK_QUESTION_TOOL_NAME)).toMatchObject({
			isError: false,
			result: {
				content: [{ type: "text", text: "User cancelled the question." }],
				details: { uiAvailable: true, cancelled: true, answers: [{ id: "first", question: "First?", answer: null, wasCustom, cancelled: true }] },
			},
		});
		expect(uiRequests("setStatus").filter((request) => request.statusKey === CURSOR_ASK_QUESTION_BLOCKED_EVENT)
			.map((request) => request.statusText)).toEqual(['{"active":true}', '{"active":false}']);
	} finally {
		stopReading();
		child.stdin.end();
		if (child.exitCode === null && child.signalCode === null) {
			const kill = setTimeout(() => child.kill("SIGKILL"), 5_000);
			await once(child, "exit");
			clearTimeout(kill);
		}
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);
