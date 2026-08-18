// Platform smoke configuration for pi-cursor-sdk.
// Reusable across pi extensions: change package name, model IDs, scenarios, and card matrix only.

import { LOCAL_RESUME_SUITE_NAMES } from "./scripts/platform-smoke/local-resume-suites.mjs";

export default {
	packageName: "pi-cursor-sdk",
	cursorModel: "cursor/grok-4.6",
	artifactRoot: ".artifacts/platform-smoke",
	artifactRetention: {
		maxRunDirs: 18,
		maxAgeDays: 14,
		preserveRecentHours: 24,
	},
	requiredTargets: ["macos", "ubuntu", "windows-native"],
	requiredSuites: [
		"platform-build",
		"cursor-native-visual-matrix",
		"cursor-http1-live",
		"cursor-bridge-visual-matrix",
		"cursor-abort-cleanup",
		...LOCAL_RESUME_SUITE_NAMES,
	],
	requiredCrabbox: {
		install: "Homebrew package or PLATFORM_SMOKE_CRABBOX override",
		minVersion: "0.26.0",
	},
	ubuntuContainerImage: "pi-cursor-sdk-platform-node:24.16-root",
	ubuntuContainerBaseImage: "cimg/node:24.16",
	nodeValidationMajor: 24,
	windowsParallels: {
		sourceVm: "pi-extension-windows-template",
		snapshot: "crabbox-ready",
		workRoot: "C:\\crabbox\\pi-cursor-sdk",
	},
};
