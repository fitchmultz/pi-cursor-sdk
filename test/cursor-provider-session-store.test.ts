import { toNamespacedPath } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamCursor } from "../src/cursor-provider.js";
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

describe("streamCursor session store", () => {
	beforeEach(resetCursorProviderTestState);

	it("threads one per-session store through create, message reads, and checkpoint lookup", async () => {
		const storeMock = installCursorSessionStoreMock();
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
			stateRoot: toNamespacedPath(buildCursorSessionStateRoot("/tmp/cursor-sdk-state", scopeKey, true)),
		});
		expect(mockedCreate.mock.calls[0][0].local?.store).toBe(store);
		expect(mockedMessagesList).toHaveBeenCalledWith("agent-1", expect.objectContaining({ store }));
		expect(mockedCreateAgentPlatform).toHaveBeenCalledWith(expect.objectContaining({ localStore: store }));
	});
});
