import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { CURSOR_API_KEY_CONFIG_VALUE } from "./cursor-api-key.js";
import { captureCursorCloudLifecycleRecorder } from "./cursor-cloud-lifecycle.js";
import { getCursorNativeToolDisplayState } from "./cursor-native-tool-display-state.js";
import { getRegisteredCursorPiToolBridge } from "./cursor-pi-tool-bridge.js";
import { createCursorLazyStream } from "./cursor-provider-lazy.js";
import { getCursorSessionScopeSnapshot } from "./cursor-session-scope.js";

export const CURSOR_PROVIDER_OWNERSHIP_ERROR = "Cursor provider ownership is unavailable: this request does not belong to the active Cursor registration. Bind this session's extensions and refresh Cursor models/reload it; use independent ModelRuntime instances for sibling sessions.";
interface ProviderBinding { active: boolean; closed: boolean }
const requestOwners = new WeakMap<object, ProviderBinding>();

/** One closure per ExtensionAPI, including direct compaction/tree/bug-report streams. */
export function registerCursorProviderBinding(pi: Pick<ExtensionAPI, "on" | "registerProvider">) {
	const binding: ProviderBinding = { active: false, closed: false };
	pi.on("before_provider_headers", (event) => {
		// Pi's SDK supplies this session-owned callback for ordinary and auxiliary
		// streams. ModelRuntime forwards the same real headers object to the provider.
		requestOwners.set(event.headers, binding);
	});
	const stream = createCursorLazyStream((options) => {
		const headers = options?.headers;
		const owner = headers && requestOwners.get(headers);
		if (headers) requestOwners.delete(headers);
		if (!binding.active || binding.closed) throw new Error("Cursor provider binding is not active. Bind this session's extensions, or reload the session after shutdown.");
		if (!owner) throw new Error("Cursor provider ownership is unavailable: this call has no native session request receipt. Bare modelRegistry.streamSimple calls are unsupported for Cursor; use the owning AgentSession's stream path or an independent child AgentSession.");
		if (owner !== binding) throw new Error(CURSOR_PROVIDER_OWNERSHIP_ERROR);
		return {
			scope: getCursorSessionScopeSnapshot(pi),
			bridge: getRegisteredCursorPiToolBridge(pi),
			nativeDisplay: getCursorNativeToolDisplayState(pi),
			recordCloudLifecycle: captureCursorCloudLifecycleRecorder(pi),
		};
	});
	pi.on("session_start", () => { if (!binding.closed) binding.active = true; });
	pi.on("session_shutdown", () => { binding.active = false; binding.closed = true; });
	return (models: ProviderModelConfig[]) => {
		if (binding.closed) return;
		pi.registerProvider("cursor", {
			name: "Cursor", baseUrl: "https://cursor.com", apiKey: CURSOR_API_KEY_CONFIG_VALUE,
			api: "cursor-sdk", models, streamSimple: stream,
		});
	};
}
