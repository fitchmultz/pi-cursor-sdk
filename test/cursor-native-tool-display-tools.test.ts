import { describe, expect, it, vi } from "vitest";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { wrapNativeCursorTool } from "../src/cursor-native-tool-display-tools.js";
import { getCursorNativeToolDisplayState } from "../src/cursor-native-tool-display-state.js";
import { createRenderContext, createRenderOptions, createRenderTheme } from "./helpers/render-fixtures.js";

describe("wrapNativeCursorTool", () => {
	it("does not use Cursor replay rendering for ordinary pi edit toolCallIds", () => {
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
		const wrapped = wrapNativeCursorTool(definition, () => definition, getCursorNativeToolDisplayState());
		const theme = createRenderTheme();

		const rendered = wrapped.renderResult?.(
			{
				content: [{ type: "text", text: "edit src/foo.ts" }],
				details: {
					variant: "nativeEdit",
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

		expect(rendered?.render(120).join("\n").trimEnd()).toBe("pi edit");
		expect(delegateRenderResult).toHaveBeenCalledOnce();
	});
});
