import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { inspectCursorCloudLocalState } from "../src/cursor-cloud-local-state.js";
import { registerCursorRuntimeControls } from "../src/cursor-state.js";
import { registerCursorSessionScope } from "../src/cursor-session-scope.js";
import { streamCursor } from "./helpers/cursor-provider-ownership.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../src/cursor-session-scope.js";
import {
	collectEvents,
	collectThinkingDeltas,
	createPiHarness,
	getDoneEvent,
	getErrorEvent,
	getTextEndEvent,
	makeContext,
	makeModel,
	mockCreatedAgent,
	mockedCreate,
	mockedResume,
	resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";
import { initTrackedGitRepo } from "./helpers/git-repo.js";

vi.mock("../src/cursor-cloud-local-state.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/cursor-cloud-local-state.js")>();
	return { ...actual, inspectCursorCloudLocalState: vi.fn(actual.inspectCursorCloudLocalState) };
});

const mockedInspectCursorCloudLocalState = vi.mocked(inspectCursorCloudLocalState);

describe("streamCursor cloud request validation", () => {
	beforeEach(async () => {
		await resetCursorProviderTestState();
		mockedInspectCursorCloudLocalState.mockClear();
	});

	it("rejects an all-invalid PI_CURSOR_CLOUD_ENV request before SDK calls", async () => {
		process.env.PI_CURSOR_CLOUD_ENV = "bad-name,CURSOR_SECRET,9INVALID";
		const send = vi.fn();
		mockCreatedAgent({ send });

		const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(getErrorEvent(events).error.errorMessage).toContain(
			"Invalid PI_CURSOR_CLOUD_ENV: no valid environment variable names were requested.",
		);
		expect(mockedCreate).not.toHaveBeenCalled();
		expect(mockedResume).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});

	it("rejects credential-bearing cloud repo URLs before Agent.create without echoing credentials", async () => {
		process.env.PI_CURSOR_RUNTIME = "cloud";
		process.env.PI_CURSOR_CLOUD_ACK = "1";
		process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE = "1";
		process.env.PI_CURSOR_CLOUD_REPO = "https://repo-user:repo-secret@example.com/org/repo.git";

		const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));
		const message = getErrorEvent(events).error.errorMessage;

		expect(message).toContain("HTTPS repository URL without embedded credentials");
		expect(message).not.toContain("repo-user");
		expect(message).not.toContain("repo-secret");
		expect(mockedCreate).not.toHaveBeenCalled();
	});

	it("blocks cloud agent creation when the explicit repo does not match the local remote", async () => {
		const root = mkdtempSync(join(tmpdir(), "pi-cursor-cloud-target-"));
		const cleanHome = mkdtempSync(join(tmpdir(), "pi-cursor-cloud-target-home-"));
		const cleanXdg = mkdtempSync(join(tmpdir(), "pi-cursor-cloud-target-xdg-"));
		const previousHome = process.env.HOME;
		const previousXdg = process.env.XDG_CONFIG_HOME;
		process.env.HOME = cleanHome;
		process.env.XDG_CONFIG_HOME = cleanXdg;
		initTrackedGitRepo(root, "https://github.com/example/local.git");
		cursorSessionScopeTestUtils.set(root, join(root, "session.jsonl"), "test-session", true);
		process.env.PI_CURSOR_RUNTIME = "cloud";
		process.env.PI_CURSOR_CLOUD_ACK = "1";
		process.env.PI_CURSOR_CLOUD_REPO = "https://github.com/example/other.git";
		process.env.PI_CURSOR_CLOUD_BRANCH = "main";

		try {
			const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

			expect(mockedInspectCursorCloudLocalState).toHaveBeenCalledOnce();
			expect(getErrorEvent(events).error.errorMessage).toContain("cloud target has no locally verified tracking ref");
			expect(mockedCreate).not.toHaveBeenCalled();
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = previousXdg;
			rmSync(root, { recursive: true, force: true });
			rmSync(cleanHome, { recursive: true, force: true });
			rmSync(cleanXdg, { recursive: true, force: true });
		}
	});

	it("skips local Git inspection when the explicit local-state override is active", async () => {
		const missingRoot = join(tmpdir(), `pi-cursor-cloud-missing-${Date.now()}`);
		cursorSessionScopeTestUtils.set(missingRoot, join(missingRoot, "session.jsonl"), "test-session", true);
		process.env.PI_CURSOR_RUNTIME = "cloud";
		process.env.PI_CURSOR_CLOUD_ACK = "1";
		process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE = "1";
		const send = vi.fn().mockResolvedValue({
			id: "run-1",
			agentId: "bc-00000000-0000-0000-0000-000000000001",
			status: "finished",
			wait: vi.fn().mockResolvedValue({ id: "run-1", status: "finished", result: "cloud done" }),
			cancel: vi.fn(),
			supports: () => true,
			unsupportedReason: () => undefined,
		});
		mockCreatedAgent({ agentId: "bc-00000000-0000-0000-0000-000000000001", send });

		const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(mockedInspectCursorCloudLocalState).not.toHaveBeenCalled();
		expect(mockedCreate).toHaveBeenCalledOnce();
		expect(send).toHaveBeenCalledOnce();
		expect(getDoneEvent(events).reason).toBe("stop");
		expect(getTextEndEvent(events).content).toBe("cloud done");
		expect(collectThinkingDeltas(events)).toContain("Cursor cloud run:");
		expect(collectThinkingDeltas(events)).not.toContain("raw usage");
	});

	it("rejects an invalid cloud branch before Agent.create", async () => {
		process.env.PI_CURSOR_RUNTIME = "cloud";
		process.env.PI_CURSOR_CLOUD_ACK = "1";
		process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE = "1";
		process.env.PI_CURSOR_CLOUD_REPO = "https://github.com/example/repo.git";
		process.env.PI_CURSOR_CLOUD_BRANCH = "foo..bar";

		const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(getErrorEvent(events).error.errorMessage).toContain("valid Git branch name");
		expect(mockedCreate).not.toHaveBeenCalled();
	});

	it("keeps valid names from a mixed request for the existing forwarding preflight", async () => {
		process.env.PI_CURSOR_RUNTIME = "cloud";
		process.env.PI_CURSOR_CLOUD_ACK = "1";
		process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE = "1";
		process.env.PI_CURSOR_CLOUD_ENV = "bad-name,NODE_ENV,CURSOR_SECRET";

		const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		const message = getErrorEvent(events).error.errorMessage;
		expect(message).toContain("Cursor cloud env forwarding is not implemented");
		expect(message).not.toContain("no valid environment variable names");
		expect(mockedCreate).not.toHaveBeenCalled();
	});

	it("rejects an all-invalid --cursor-cloud-env request before SDK calls", async () => {
		const pi = createPiHarness({ flagValues: { "cursor-cloud-env": "bad-name,CURSOR_SECRET,9INVALID" } });
		registerCursorSessionScope(pi);
		registerCursorRuntimeControls(pi);
		await pi.runSessionStart({ model: makeModel("gpt-5.5@1m") });
		const send = vi.fn();
		mockCreatedAgent({ send });

		const events = await collectEvents(streamCursor(makeModel("gpt-5.5@1m"), makeContext(), { apiKey: "test-key" }));

		expect(getErrorEvent(events).error.errorMessage).toContain(
			"Invalid --cursor-cloud-env: no valid environment variable names were requested.",
		);
		expect(mockedCreate).not.toHaveBeenCalled();
		expect(mockedResume).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});
});
