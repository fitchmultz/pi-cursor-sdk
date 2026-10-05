// Install the external SDK transport mock before the static provider dependency graph evaluates.
import "./helpers/cursor-provider-harness.js";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamCursor } from "./helpers/cursor-provider-ownership.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { buildCursorSessionStateRoot } from "../src/cursor-session-store.js";
import {
	collectEvents,
	makeContext,
	makeModel,
	mockCreatedAgent,
	mockedCreate,
	mockedCreateAgentPlatform,
	mockedMessagesList,
	resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";
import { installCursorSessionStoreMock } from "./helpers/cursor-session-store.js";

const changeDuringDrain = vi.hoisted(() => ({ root: undefined as string | undefined }));
vi.mock("../src/cursor-provider-live-run-drain.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/cursor-provider-live-run-drain.js")>();
	return { ...actual, drainExistingCursorLiveRunBeforeSend: async (...args: Parameters<typeof actual.drainExistingCursorLiveRunBeforeSend>) => {
		const result = await actual.drainExistingCursorLiveRunBeforeSend(...args);
		if (changeDuringDrain.root) vi.stubEnv("PI_CURSOR_SDK_STATE_ROOT", changeDuringDrain.root);
		return result;
	} };
});

describe("streamCursor session store", () => {
	beforeEach(resetCursorProviderTestState);
	let root: string | undefined;
	afterEach(() => {
		changeDuringDrain.root = undefined;
		vi.unstubAllEnvs();
		if (root) rmSync(root, { recursive: true, force: true });
		root = undefined;
	});

	it.each(["default", "custom"] as const)("threads the captured %s store through create, reads and checkpoints despite an env change during drain", async (domain) => {
		const storeMock = installCursorSessionStoreMock();
		let workspace = "/tmp/cursor-sdk-state/workspace";
		if (domain === "custom") {
			root = realpathSync(mkdtempSync(join(tmpdir(), "cursor-provider-custom-root-")));
			const selected = join(root, "captured");
			vi.stubEnv("PI_CURSOR_SDK_STATE_ROOT", selected);
			changeDuringDrain.root = join(root, "changed");
			workspace = join(selected, createHash("sha256").update(process.cwd()).digest("hex").slice(0, 32));
		}
		const scopeKey = "/tmp/provider-store-session.jsonl";
		cursorSessionScopeTestUtils.set(process.cwd(), scopeKey);
		mockCreatedAgent({
			send: vi.fn().mockResolvedValue({
				id: "run-store",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "run-store", status: "finished" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			}),
		});

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		const store = storeMock.stores[0];
		expect(storeMock.openSqliteStore).toHaveBeenCalledWith({
			workspaceRef: process.cwd(),
			stateRoot: toNamespacedPath(buildCursorSessionStateRoot(workspace, scopeKey)),
		});
		expect(mockedCreate.mock.calls[0][0].local?.store).toBe(store);
		expect(mockedMessagesList).toHaveBeenCalledWith("agent-1", expect.objectContaining({ store }));
		expect(mockedCreateAgentPlatform).toHaveBeenCalledWith(expect.objectContaining({ localStore: store }));
	});
});
