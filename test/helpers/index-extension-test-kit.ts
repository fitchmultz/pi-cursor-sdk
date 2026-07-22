import { vi } from "vitest";
import {
	createExtensionRegistrationPi,
	type CursorExtensionRegistrationPi,
	type PiHarness,
	type PiHarnessOptions,
} from "./pi-harness.js";
import { __testUtils as nativeToolDisplayTestUtils } from "../../src/cursor-native-tool-display-state.js";
import { __testUtils as cursorPiToolBridgeTestUtils } from "../../src/cursor-pi-tool-bridge.js";
import { __testUtils as cursorSessionScopeTestUtils } from "../../src/cursor-session-scope.js";
import { __testUtils as cursorSessionResumeTestUtils } from "../../src/cursor-session-agent-resume.js";
import { __testUtils as cursorSdkProcessErrorGuardTestUtils } from "../../src/cursor-sdk-process-error-guard.js";

export {
	nativeToolDisplayTestUtils,
	cursorPiToolBridgeTestUtils,
	cursorSessionScopeTestUtils,
	cursorSessionResumeTestUtils,
};

export function createExtensionPi(
	initialTools?: PiHarnessOptions["initialTools"],
): PiHarness & CursorExtensionRegistrationPi {
	return createExtensionRegistrationPi(initialTools ? { initialTools } : undefined);
}

export async function resetIndexExtensionTestState(): Promise<void> {
	vi.clearAllMocks();
	delete process.env.PI_CURSOR_NATIVE_TOOL_DISPLAY;
	delete process.env.PI_CURSOR_REGISTER_NATIVE_TOOLS;
	delete process.env.PI_CURSOR_PI_TOOL_BRIDGE;
	delete process.env.PI_CURSOR_ASK_QUESTION;
	delete process.env.PI_CURSOR_AUTO_REVIEW;
	delete process.env.PI_CURSOR_SANDBOX;
	await cursorPiToolBridgeTestUtils.resetRegisteredBridgeForTests();
	cursorSessionScopeTestUtils.reset();
	cursorSessionResumeTestUtils.reset();
	cursorSdkProcessErrorGuardTestUtils.resetLifecycleSessionGuard();
	nativeToolDisplayTestUtils.reset();
}
