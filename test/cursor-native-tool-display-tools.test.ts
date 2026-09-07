import { describe, expect, it, vi } from "vitest";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as replay from "../src/cursor-native-tool-display-replay.js";
import { wrapNativeCursorTool } from "../src/cursor-native-tool-display-tools.js";
import { createExtensionTestContext } from "./helpers/pi-harness.js";
import { createRenderContext, createRenderOptions, createRenderTheme } from "./helpers/render-fixtures.js";

describe("wrapNativeCursorTool", () => {
	it("does not use Cursor replay rendering for ordinary pi edit toolCallIds", () => {
		const replaySpy = vi.spyOn(replay, "renderCursorReplayResult").mockReturnValue(new Text("", 0, 0));
		const parameters = Type.Object({});
		type EditToolDefinition = ToolDefinition<typeof parameters, unknown, unknown>;
		const delegateRenderResult = vi.fn<NonNullable<EditToolDefinition["renderResult"]>>(() => new Text("pi edit", 0, 0));
		const definition: EditToolDefinition = {
			name: "edit",
			label: "edit",
			description: "edit",
			parameters,
			execute: vi.fn(async () => ({ content: [], details: undefined })),
			renderResult: delegateRenderResult,
		};
		const wrapped = wrapNativeCursorTool(definition, () => definition);
		const theme = createRenderTheme();

		wrapped.renderResult?.(
			{
				content: [{ type: "text", text: "edit src/foo.ts" }],
				details: {
					path: "src/foo.ts",
					diffString: "--- a\n+++ b\n",
					linesAdded: 1,
					linesRemoved: 1,
				},
			},
			createRenderOptions(),
			theme,
			createRenderContext({ isError: false, toolCallId: "ordinary-edit-1" }),
		);

		expect(replaySpy).not.toHaveBeenCalled();
		expect(delegateRenderResult).toHaveBeenCalledOnce();
		replaySpy.mockRestore();
	});

	it("does not execute bash when a replay id has no recorded display", async () => {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }], details: undefined }));
		const parameters = Type.Object({});
		const definition: ToolDefinition<typeof parameters, unknown, unknown> = {
			name: "bash",
			label: "bash",
			description: "bash",
			parameters,
			execute,
		};
		const wrapped = wrapNativeCursorTool(definition, () => definition);

		await expect(
			wrapped.execute("cursor-replay-2-1-tool-1", {}, undefined, undefined, createExtensionTestContext()),
		).rejects.toThrow("replay-only call does not execute work directly");
		expect(execute).not.toHaveBeenCalled();
	});
});
