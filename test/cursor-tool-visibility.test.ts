import { describe, expect, it } from "vitest";
import { classifyCursorToolVisibility } from "../src/cursor-tool-visibility.js";

describe("cursor tool visibility classification", () => {
	it("classifies fast local discovery tools from the shared policy", () => {
		for (const name of ["read", "grep", "glob", "ls"]) {
			expect(classifyCursorToolVisibility({ name })).toMatchObject({
				fastLocalDiscovery: true,
				lifecycleEligible: false,
			});
		}

		expect(classifyCursorToolVisibility({ name: "shell" })).toMatchObject({
			fastLocalDiscovery: false,
			normalizedName: "shell",
			activityTitle: "Cursor shell",
			incompleteTitle: "Cursor shell",
			lifecycleTitle: "Cursor shell",
			lifecycleEligible: true,
		});
	});
});
