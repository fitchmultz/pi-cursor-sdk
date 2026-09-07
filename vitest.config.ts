import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		maxWorkers: 4,
		// Existing hybrid/native coverage runs with an explicit opt-out. Lean tests
		// unset or enable this flag to exercise the production default separately.
		env: { PI_CURSOR_LEAN: "0" },
		include: ["test/**/*.test.ts"],
		exclude: ["test/**/*.compile.test.ts"],
	},
});
