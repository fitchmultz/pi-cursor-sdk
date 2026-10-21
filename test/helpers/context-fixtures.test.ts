import { describe, expect, it } from "vitest";
import { createExtensionTestContext } from "./context-fixtures.js";

describe("extension tool context fixtures", () => {
	it("rejects background runs without pretending to provide a native scheduler", () => {
		const context = createExtensionTestContext();
		// Official Pi does not yet declare the fork's tool-context method.
		expect(Reflect.get(context, "runInBackground")).toThrow(
			"Background tool runs require a native session in this test harness.",
		);
	});
});
