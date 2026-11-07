import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// 3-4 vCPU CI runners keep 4 workers; larger machines use half their cores.
		maxWorkers: Math.max(4, Math.floor(availableParallelism() / 2)),
		// Legacy hybrid/native tests opt out; lean suites exercise the production default.
		env: { PI_CURSOR_LEAN: "0" },
		include: ["test/**/*.test.ts"],
		exclude: ["test/**/*.compile.test.ts"],
	},
});
