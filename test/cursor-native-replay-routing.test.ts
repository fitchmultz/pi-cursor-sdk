import { describe, it, expect } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import {
	isNativeToolActiveInContext,
	partitionNativeToolsByActiveContext,
	resolveNativeReplayDisposition,
} from "../src/cursor-native-replay-routing.js";

describe("cursor-native-replay-routing", () => {
	it("returns transcript_trace when native replay is disabled", () => {
		expect(
			resolveNativeReplayDisposition({
				toolName: "grep",
				useNativeToolReplay: false,
				activeToolNames: new Set(["grep"]),
				registeredToolNames: new Set(["grep"]),
				hasLiveRun: true,
			}),
		).toBe("transcript_trace");
	});

	it("treats undefined activeToolNames as all tools active", () => {
		expect(isNativeToolActiveInContext("grep", undefined)).toBe(true);
	});

	it("partitions native tools by context.tools snapshot", () => {
		const context = {
			systemPrompt: "",
			messages: [],
			tools: [{ name: "read", description: "read", parameters: {} }],
		} as unknown as Context;
		const { active, inactive } = partitionNativeToolsByActiveContext(context, [
			{ toolName: "read", id: "1" },
			{ toolName: "grep", id: "2" },
		]);
		expect(active.map((t) => t.toolName)).toEqual(["read"]);
		expect(inactive.map((t) => t.toolName)).toEqual(["grep"]);
	});
});
