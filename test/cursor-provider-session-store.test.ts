// Install the external SDK transport mock before the static provider dependency graph evaluates.
import "./helpers/cursor-provider-harness.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, toNamespacedPath } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamCursor } from "./helpers/cursor-provider-ownership.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import { buildCursorCustomWorkspaceRoot, buildCursorSessionStateRoot } from "../src/cursor-session-store.js";
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
			stateRoot: toNamespacedPath(buildCursorSessionStateRoot("/tmp/cursor-sdk-state/workspace", scopeKey)),
		});
		expect(mockedCreate.mock.calls[0][0].local?.store).toBe(store);
		expect(mockedMessagesList).toHaveBeenCalledWith("agent-1", expect.objectContaining({ store }));
		expect(mockedCreateAgentPlatform).toHaveBeenCalledWith(expect.objectContaining({ localStore: store }));
	});
	it("threads the configured base through the owned provider store", async () => {
		const base = mkdtempSync(join(tmpdir(), "cursor-provider-base-"));
		vi.stubEnv("PI_CURSOR_SDK_STATE_ROOT", base);
		const getter = vi.fn(() => { throw new Error("configured provider must bypass default migration"); });
		const storeMock = installCursorSessionStoreMock(getter);
		const scopeKey = "/tmp/configured-provider-session.jsonl";
		cursorSessionScopeTestUtils.set(process.cwd(), scopeKey);
		mockCreatedAgent({
			send: vi.fn().mockResolvedValue({
				id: "configured-store-run",
				agentId: "agent-1",
				status: "finished",
				wait: vi.fn().mockResolvedValue({ id: "configured-store-run", status: "finished" }),
				cancel: vi.fn(),
				supports: () => true,
				unsupportedReason: () => undefined,
			}),
		});
		try {
			await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));
			expect(getter).not.toHaveBeenCalled();
			expect(storeMock.openedOptions[0].stateRoot).toBe(toNamespacedPath(buildCursorSessionStateRoot(buildCursorCustomWorkspaceRoot(base, process.cwd()), scopeKey)));
			expect(mockedCreate.mock.calls[0][0].local?.store).toBe(storeMock.stores[0]);
			expect(mockedMessagesList).toHaveBeenCalledWith("agent-1", expect.objectContaining({ store: storeMock.stores[0] }));
		} finally {
			await resetCursorProviderTestState();
			vi.unstubAllEnvs();
			rmSync(base, { recursive: true, force: true });
		}
	});
});
