import { beforeEach, describe, expect, it, vi } from "vitest";
import { CURSOR_HTTP1_ENV } from "../src/cursor-config.js";
import { streamCursor } from "../src/cursor-provider.js";
import {
	collectEvents,
	makeContext,
	makeModel,
	mockCreatedAgent,
	mockedConfigureCursor,
	mockedCreate,
	resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";

function mockSuccessfulAgent(agentId = "agent-1") {
	const send = vi.fn().mockResolvedValue({
		id: "run-1",
		agentId,
		status: "finished",
		wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished" }),
		cancel: vi.fn(),
		supports: () => true,
		unsupportedReason: () => undefined,
	});
	mockCreatedAgent({
		agentId,
		send,
	});
	return send;
}

describe("Cursor provider HTTP/1.1 transport", () => {
	beforeEach(resetCursorProviderTestState);

	it.each([
		["true", true],
		["false", false],
	] as const)("configures explicit PI_CURSOR_HTTP_1_1=%s before creating a local agent", async (raw, value) => {
		process.env[CURSOR_HTTP1_ENV] = raw;
		const send = mockSuccessfulAgent();

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(mockedConfigureCursor).toHaveBeenCalledWith({ local: { useHttp1ForAgent: value } });
		expect(mockedConfigureCursor.mock.invocationCallOrder[0]).toBeLessThan(
			mockedCreate.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
		expect(mockedConfigureCursor.mock.invocationCallOrder[0]).toBeLessThan(
			send.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
		);
	});

	it("leaves the default local SDK path unconfigured", async () => {
		mockSuccessfulAgent();

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(mockedConfigureCursor).not.toHaveBeenCalled();
		expect(mockedCreate.mock.calls[0][0].local).toMatchObject({
			cwd: process.cwd(),
			settingSources: ["all"],
			store: expect.any(Object),
		});
	});

	it("does not configure the local transport for cloud agents", async () => {
		process.env.PI_CURSOR_RUNTIME = "cloud";
		process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE = "1";
		process.env.PI_CURSOR_CLOUD_ACK = "1";
		const cloudAgentId = "bc-00000000-0000-0000-0000-000000000001";
		mockSuccessfulAgent(cloudAgentId);

		await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(mockedConfigureCursor).not.toHaveBeenCalled();
		expect(mockedCreate).toHaveBeenCalledWith(expect.objectContaining({ cloud: {} }));
	});
});
