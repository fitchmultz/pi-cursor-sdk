import type { RegisteredTool } from "./pi-harness-types.js";

type ToolRenderCall = NonNullable<RegisteredTool["renderCall"]>;
type ToolRenderResult = NonNullable<RegisteredTool["renderResult"]>;

export type HarnessRenderTheme = Parameters<ToolRenderCall>[1];
export type HarnessRenderContext = Parameters<ToolRenderCall>[2];
type HarnessRenderContextWithObjectArgs = Omit<HarnessRenderContext, "args"> & {
	args: object;
	durationMs: number | undefined;
	outputPad: number;
};
export type HarnessRenderResultOptions = Parameters<ToolRenderResult>[1];

export function createRenderTheme(overrides: Partial<HarnessRenderTheme> = {}): HarnessRenderTheme {
	return {
		fg: (_style: string, text: string) => text,
		bold: (text: string) => text,
		...overrides,
	} as HarnessRenderTheme;
}

export function createRenderOptions(overrides: Partial<HarnessRenderResultOptions> = {}): HarnessRenderResultOptions {
	return {
		expanded: false,
		isPartial: false,
		...overrides,
	};
}

export function createRenderContext(overrides: Partial<HarnessRenderContextWithObjectArgs> = {}): HarnessRenderContextWithObjectArgs {
	return {
		args: {},
		toolCallId: "test-tool-call",
		invalidate: () => {},
		lastComponent: undefined,
		state: undefined,
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		durationMs: undefined,
		outputPad: 1,
		...overrides,
	};
}
