import { describe, expect, it, vi } from "vitest";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import * as replay from "../src/cursor-native-tool-display-replay.js";
import { wrapNativeCursorTool } from "../src/cursor-native-tool-display-tools.js";
import { createExtensionTestContext } from "./helpers/pi-harness.js";
import { createRenderContext, createRenderOptions, createRenderTheme } from "./helpers/render-fixtures.js";

describe("wrapNativeCursorTool", () => {
	it("does not rerun a Cursor bash replay when its recorded result is missing", async () => {
		const parameters = Type.Object({ command: Type.String() });
		const execute = vi.fn(async () => ({ content: [], details: undefined }));
		const definition: ToolDefinition<typeof parameters, unknown, unknown> = {
			name: "bash",
			label: "bash",
			description: "bash",
			parameters,
			execute,
		};
		const wrapped = wrapNativeCursorTool(definition, () => definition);
		const signal = new AbortController().signal;
		const context = createExtensionTestContext();

		await expect(wrapped.execute("cursor-replay-123-1-tool-1", { command: "echo duplicate" }, signal, undefined, context)).rejects.toThrow(
			"No recorded Cursor bash result was available",
		);
		expect(execute).not.toHaveBeenCalled();

		await wrapped.execute("ordinary-bash-1", { command: "echo normal" }, signal, undefined, context);
		expect(execute).toHaveBeenCalledOnce();
	});

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
});
