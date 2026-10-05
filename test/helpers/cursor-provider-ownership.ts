import type { Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { captureCursorCloudLifecycleRecorder } from "../../src/cursor-cloud-lifecycle.js";
import { getCursorNativeToolDisplayState } from "../../src/cursor-native-tool-display-state.js";
import { getRegisteredCursorPiToolBridge } from "../../src/cursor-pi-tool-bridge.js";
import { streamCursor as streamOwnedCursor, type CursorProviderOwnership } from "../../src/cursor-provider.js";
import { captureCursorRequestProjection, resolveCursorRequestProvenance } from "../../src/cursor-request-provenance.js";
import { getCursorSessionScopeSnapshot } from "../../src/cursor-session-scope.js";
import { captureCursorUsageRecorder, type CursorUsageTurnRecorder } from "../../src/cursor-usage-ledger.js";
import { createExtensionTestContext, createPiHarness, type PiHarness } from "./pi-harness.js";

/** Explicit direct-provider fixture, not proof of native header receipt ownership. */
export function captureProviderTestOwnership(model: Model<Api>, context: Context, scope = getCursorSessionScopeSnapshot(), ownerPi?: PiHarness): CursorProviderOwnership {
	const pi = ownerPi ?? createPiHarness();
	const manager = SessionManager.inMemory(scope.cwd);
	const append = pi.appendEntry.getMockImplementation();
	pi.appendEntry.mockImplementation((type, data) => {
		manager.appendCustomEntry(type, data);
		append?.(type, data);
	});
	const ctx = { ...createExtensionTestContext({ cwd: scope.cwd }), sessionManager: manager };
	return {
		scope,
		// Direct tests deliberately register one display/bridge fixture globally.
		// Native multi-session ownership remains covered by the binding suites.
		bridge: getRegisteredCursorPiToolBridge(ownerPi),
		nativeDisplay: getCursorNativeToolDisplayState(ownerPi),
		recordCloudLifecycle: captureCursorCloudLifecycleRecorder(ownerPi),
		request: resolveCursorRequestProvenance(captureCursorRequestProjection(manager), model, context, "normal"),
		usageRecorder: captureCursorUsageRecorder(pi, ctx),
	};
}

export function streamCursor(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
	return streamOwnedCursor(model, context, options, captureProviderTestOwnership(model, context));
}

/** Phase-local unit tests supply accounting explicitly without executing agent creation. */
export function createProviderTestTurnUsage(): CursorUsageTurnRecorder {
	return {
		observeRawTurn: vi.fn(),
		recordRun: vi.fn().mockResolvedValue(undefined),
		recordTerminal: vi.fn().mockResolvedValue({ status: "unavailable", reason: "unsupported" }),
		recordSnapshot: vi.fn().mockResolvedValue({ status: "unavailable", reason: "unsupported" }),
		notePersistenceFailure: vi.fn(),
	};
}
