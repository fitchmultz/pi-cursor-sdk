import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendOptions } from "@cursor/sdk";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CLOUD_AGENT_ID_PATTERN } from "../shared/cursor-cloud-lifecycle-constants.mjs";
import { streamCursor } from "../src/cursor-provider.js";
import {
	asMockCursorRun,
	collectEvents,
	collectTextDeltas,
	collectThinkingDeltas,
	createBuiltinToolInfo,
	getDoneEvent,
	getCreatedAgentOptions,
	isCursorToolStreamEvent,
	isToolCallBlock,
	makeContext,
	makeModel,
	mockCreatedAgent,
	registerBridgeForProviderTest,
	resetCursorProviderTestState,
} from "./helpers/cursor-provider-harness.js";
import { readInstalledPackageVersion } from "./helpers/installed-package.js";

const installedSdkVersion = readInstalledPackageVersion("@cursor/sdk");
const CLOUD_RUN_ID_PATTERN = /^run-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RENDER_WIDTH = 80;

interface CapturedCallbackFixture {
	fixtureKind: string;
	sdkVersion: string;
	sourceCapture: {
		agentId: string;
		runId: string;
		onDeltaCount: number;
		onStepCount: number;
		terminalStatus: "finished";
		cleanup: {
			archived: true;
			deleted: true;
			getNotFound: true;
			listExcluded: true;
		};
	};
	normalizedAgentId: string;
	normalizedRunId: string;
	callbacks: Array<
		| { channel: "onDelta"; args: Parameters<NonNullable<SendOptions["onDelta"]>>[0] }
		| { channel: "onStep"; args: Parameters<NonNullable<SendOptions["onStep"]>>[0] }
	>;
}

const fixture = JSON.parse(readFileSync(
	new URL("./fixtures/cursor-cloud-activity-callbacks-2026-07-19.json", import.meta.url),
	"utf8",
)) as CapturedCallbackFixture;

describe("cloud provider captured activity callbacks", () => {
	beforeEach(async () => {
		await resetCursorProviderTestState();
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await resetCursorProviderTestState();
	});

	it("routes normalized captured onDelta/onStep activity through the cloud coordinator without local replay or bridge leakage", async () => {
		expect(fixture.sdkVersion).toBe("1.0.23");
		expect(installedSdkVersion).toBe("1.0.27");
		expect(fixture.sourceCapture.agentId).toMatch(CLOUD_AGENT_ID_PATTERN);
		expect(fixture.sourceCapture.runId).toMatch(CLOUD_RUN_ID_PATTERN);
		expect(fixture.sourceCapture.terminalStatus).toBe("finished");
		expect(fixture.sourceCapture.cleanup).toEqual({
			archived: true,
			deleted: true,
			getNotFound: true,
			listExcluded: true,
		});
		const retainedDeltaCount = fixture.callbacks.filter((callback) => callback.channel === "onDelta").length;
		const retainedStepCount = fixture.callbacks.filter((callback) => callback.channel === "onStep").length;
		expect(fixture.sourceCapture.onDeltaCount).toBeGreaterThan(retainedDeltaCount);
		expect(fixture.sourceCapture.onStepCount).toBeGreaterThan(retainedStepCount);

		process.env.PI_CURSOR_RUNTIME = "cloud";
		process.env.PI_CURSOR_CLOUD_ACK = "1";
		process.env.PI_CURSOR_CLOUD_ALLOW_LOCAL_STATE = "1";
		process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY = "1";
		process.env.PI_CURSOR_REGISTER_NATIVE_TOOLS = "1";
		process.env.PI_CURSOR_PI_TOOL_BRIDGE = "1";
		process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
		registerBridgeForProviderTest({ active: ["read"], tools: [createBuiltinToolInfo("read")] });

		let observedSendOptions: SendOptions | undefined;
		const send = vi.fn(async (_message: unknown, options: SendOptions = {}) => {
			observedSendOptions = options;
			for (const callback of fixture.callbacks) {
				if (callback.channel === "onDelta") await options.onDelta?.(callback.args);
				else await options.onStep?.(callback.args);
			}
			return asMockCursorRun({
				id: fixture.normalizedRunId,
				agentId: fixture.normalizedAgentId,
				status: "finished",
				wait: vi.fn().mockResolvedValue({
					id: fixture.normalizedRunId,
					status: "finished",
					result: "CLOUD_ACTIVITY_FIXTURE_OK",
					git: { branches: [] },
				}),
			});
		});
		mockCreatedAgent({
			agentId: fixture.normalizedAgentId,
			send,
			listArtifacts: vi.fn().mockResolvedValue([]),
		});

		const events = await collectEvents(streamCursor(makeModel("composer-2-5"), makeContext(), { apiKey: "test-key" }));
		const trace = collectThinkingDeltas(events);
		const done = getDoneEvent(events);
		const createOptions = getCreatedAgentOptions();

		expect(fixture.fixtureKind).toContain("normalized-captured");
		expect(createOptions).toMatchObject({ cloud: {}, mode: "agent" });
		expect(createOptions).not.toHaveProperty("local");
		expect(createOptions).not.toHaveProperty("mcpServers");
		expect(createOptions).not.toHaveProperty("customTools");
		expect(createOptions).not.toHaveProperty("settingSources");
		expect(observedSendOptions).toMatchObject({ mode: "agent" });
		expect(observedSendOptions).not.toHaveProperty("local");
		expect(observedSendOptions).not.toHaveProperty("mcpServers");
		expect(observedSendOptions).not.toHaveProperty("cloud");

		expect(trace).toContain("read README.md");
		expect(trace).toContain("# normalized cloud fixture");
		expect(trace).toContain("$ printf cloud-shell-ok");
		expect(trace).toContain("cloud-shell-ok");
		expect(trace).toContain("Inspect normalized cloud activity");
		expect(collectTextDeltas(events)).toBe("CLOUD_ACTIVITY_FIXTURE_OK");
		expect(trace.length).toBeLessThan(2_000);
		expect(trace).not.toContain("pi__");
		expect(events.length).toBeLessThan(40);
		expect(events.filter(isCursorToolStreamEvent)).toHaveLength(0);
		expect(done.reason).toBe("stop");
		expect(done.message.content.some(isToolCallBlock)).toBe(false);
		expect(done.message.content.map((block) => block.type)).not.toContain("toolCall");

		initTheme("dark", false);
		const renderedLines = new AssistantMessageComponent(done.message).render(RENDER_WIDTH);
		expect(renderedLines.length).toBeGreaterThan(0);
		expect(renderedLines.length).toBeLessThan(40);
		for (const line of renderedLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(RENDER_WIDTH);
		}
		const renderedText = renderedLines.join("\n");
		expect(renderedText).toContain("read README.md");
		expect(renderedText).toMatch(/normalized cloud fixture/);
		expect(renderedText).toContain("$ printf cloud-shell-ok");
		expect(renderedText).toContain("cloud-shell-ok");
		expect(renderedText).toContain("Inspect normalized cloud activity");
		expect(renderedText).toContain("CLOUD_ACTIVITY_FIXTURE_OK");
		expect(renderedText).not.toContain("pi__");
		expect(renderedText).not.toMatch(/native.?replay|toolCall|toolUse/i);
	});
});
