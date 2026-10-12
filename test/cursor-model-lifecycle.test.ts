import type { BeforeAgentStartEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerCursorModelLifecycle } from "../src/cursor-model-lifecycle.js";
import { createDefaultSystemPromptOptions, createExtensionTestContext } from "./helpers/context-fixtures.js";
import { createHarnessEventApi } from "./helpers/event-harness.js";
import { makeModel } from "./helpers/model-fixtures.js";

describe("registerCursorModelLifecycle", () => {
	it("runs one sync handler for effective model lifecycle phases", async () => {
		const events = createHarnessEventApi();
		const sync = vi.fn();
		registerCursorModelLifecycle(events, sync);

		const sessionModel = makeModel("session-model");
		const selectedModel = makeModel("selected-model");
		await events.runSessionStart({ model: sessionModel });
		await events.invokeEvent(
			"model_select",
			{ type: "model_select", model: selectedModel, previousModel: sessionModel, source: "set" },
			{ model: sessionModel },
		);
		await events.runTurnStart({ model: selectedModel });
		await events.runBeforeAgentStart({ model: selectedModel });

		expect(sync).toHaveBeenCalledTimes(4);
		expect(sync.mock.calls.map(([ctx]) => ctx.model?.id)).toEqual([
			"session-model",
			"selected-model",
			"selected-model",
			"selected-model",
		]);
	});

	it.each(["user", "custom"] as const)("runs phase-specific handlers for a %s start", async (messageType) => {
		const events = { on: vi.fn() };
		const calls: string[] = [];
		registerCursorModelLifecycle(events, {
			sessionStart: (_event, ctx) => {
				calls.push(`session:${ctx.model?.id}`);
			},
			sync: (ctx) => {
				calls.push(`sync:${ctx.model?.id}`);
			},
			beforeAgentStart: (event, ctx) => {
				calls.push(`before:${ctx.model?.id}:${event.systemPrompt}`);
				return { systemPrompt: `${event.systemPrompt} updated` };
			},
		});

		const model = makeModel("cursor-model");
		const ctx = createExtensionTestContext({ model });
		const sessionStart = events.on.mock.calls.find(([name]) => name === "session_start")![1];
		const beforeAgentStart = events.on.mock.calls.find(([name]) => name === "before_agent_start")![1];
		await sessionStart({ type: "session_start", reason: "startup" }, ctx);
		const shared = {
			type: "before_agent_start" as const,
			systemPrompt: "",
			systemPromptOptions: createDefaultSystemPromptOptions(ctx.cwd),
		};
		const userEvent = {
			...shared,
			messageType: "user",
			prompt: "start",
		} satisfies BeforeAgentStartEvent & { messageType: "user" };
		const customEvent = {
			...shared,
			messageType: "custom" as const,
			message: {
				role: "custom" as const,
				customType: "completion",
				content: "Background command finished",
				display: true,
				timestamp: 0,
			},
		};
		// Old hosts cannot emit this shape; new hosts must validate the complete event.
		customEvent satisfies (
			BeforeAgentStartEvent extends { messageType: string }
				? BeforeAgentStartEvent
				: Omit<BeforeAgentStartEvent, "prompt" | "images">
		);
		const result = await beforeAgentStart(messageType === "user" ? userEvent : customEvent, ctx);

		expect(calls).toEqual([
			"session:cursor-model",
			"sync:cursor-model",
			"sync:cursor-model",
			"before:cursor-model:",
		]);
		expect(result).toEqual({ systemPrompt: " updated" });
	});

	it("runs explicit model-select and turn-start handlers without raw event hooks", async () => {
		const events = createHarnessEventApi();
		const calls: string[] = [];
		registerCursorModelLifecycle(events, {
			modelSelect: (_event, ctx) => {
				calls.push(`select:${ctx.model?.id}`);
			},
			turnStart: (_event, ctx) => {
				calls.push(`turn:${ctx.model?.id}`);
			},
			beforeAgentStart: (event, ctx) => {
				calls.push(`before:${ctx.model?.id}`);
				return { systemPrompt: event.systemPrompt };
			},
		});

		const sessionModel = makeModel("session-model");
		const selectedModel = makeModel("selected-model");
		await events.invokeEvent(
			"model_select",
			{ type: "model_select", model: selectedModel, previousModel: sessionModel, source: "set" },
			{ model: sessionModel },
		);
		await events.runTurnStart({ model: selectedModel });
		await events.runBeforeAgentStart({ model: selectedModel });

		expect(calls).toEqual(["select:selected-model", "turn:selected-model", "before:selected-model"]);
	});
});
