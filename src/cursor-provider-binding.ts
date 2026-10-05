import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { cursorApiKeyAuth, normalizeCursorApiKey } from "./cursor-api-key.js";
import { discoverModels, type CursorModelFallbackIssue } from "./model-discovery.js";
import { clearModelListCache } from "./model-list-cache.js";
import { captureCursorCloudLifecycleRecorder } from "./cursor-cloud-lifecycle.js";
import { captureCursorUsageRecorder, type CursorUsageRecorder } from "./cursor-usage-ledger.js";
import { getCursorNativeToolDisplayState } from "./cursor-native-tool-display-state.js";
import { getRegisteredCursorPiToolBridge } from "./cursor-pi-tool-bridge.js";
import { createCursorLazyStream } from "./cursor-provider-lazy.js";
import { getCursorSessionScopeSnapshot } from "./cursor-session-scope.js";
import { captureCursorRequestProjection, resolveCursorRequestProvenance, type CursorRequestProjectionSnapshot, type CursorRequestProvenance } from "./cursor-request-provenance.js";
import type { CursorSdkOutputNoticeHandler } from "./cursor-sdk-output-filter.js";

export const CURSOR_PROVIDER_OWNERSHIP_ERROR = "Cursor provider ownership is unavailable: this request does not belong to the active Cursor registration. Bind this session's extensions and refresh Cursor models/reload it; use independent ModelRuntime instances for sibling sessions.";
interface ProviderBinding { active: boolean; closed: boolean }
interface RequestReceipt {
	binding: ProviderBinding;
	scope: ReturnType<typeof getCursorSessionScopeSnapshot>;
	projection: CursorRequestProjectionSnapshot;
	usageRecorder: CursorUsageRecorder;
	reportSdkNotice: CursorSdkOutputNoticeHandler;
}
const requestOwners = new WeakMap<object, RequestReceipt>();

/** One closure per ExtensionAPI, including direct compaction/tree/bug-report streams. */
export function registerCursorProviderBinding(
	pi: Pick<ExtensionAPI, "on" | "registerProvider" | "appendEntry">,
	onCatalog: (issue?: CursorModelFallbackIssue) => void,
) {
	const binding: ProviderBinding = { active: false, closed: false };
	let registry: ExtensionContext["modelRegistry"] | undefined;
	const operations = new WeakMap<AbortSignal, CursorRequestProvenance["purpose"]>();
	pi.on("session_before_compact", (event) => { operations.set(event.signal, "compaction"); });
	pi.on("session_before_tree", (event) => { operations.set(event.signal, "tree"); });
	pi.on("before_provider_headers", (event, ctx) => {
		const notices = new Set<string>();
		// Pi's SDK supplies this session-owned callback for ordinary and auxiliary
		// streams. ModelRuntime forwards the same real headers object to the provider.
		requestOwners.set(event.headers, {
			binding,
			scope: getCursorSessionScopeSnapshot(pi),
			projection: captureCursorRequestProjection(ctx.sessionManager),
			usageRecorder: captureCursorUsageRecorder(pi, ctx),
			reportSdkNotice: (kind, message) => {
				if (!binding.active || binding.closed) return false;
				if (notices.has(kind)) return;
				pi.appendEntry("pi-cursor-sdk:capability-notice", { kind, message });
				if (ctx.hasUI) ctx.ui.notify(message, "warning");
				else console.warn(message);
				notices.add(kind);
			},
		});
	});
	const stream = createCursorLazyStream((model, context, options) => {
		const headers = options?.headers;
		const owner = headers && requestOwners.get(headers);
		if (headers) requestOwners.delete(headers);
		if (!binding.active || binding.closed) throw new Error("Cursor provider binding is not active. Bind this session's extensions, or reload the session after shutdown.");
		if (!owner) throw new Error("Cursor provider ownership is unavailable: this call has no native session request receipt. Bare modelRegistry.streamSimple calls are unsupported for Cursor; use the owning AgentSession's stream path or an independent child AgentSession.");
		if (owner.binding !== binding) throw new Error(CURSOR_PROVIDER_OWNERSHIP_ERROR);
		return {
			request: resolveCursorRequestProvenance(owner.projection, model, context, options?.signal && operations.get(options.signal) || "normal"),
			usageRecorder: owner.usageRecorder,
			scope: owner.scope,
			bridge: getRegisteredCursorPiToolBridge(pi),
			nativeDisplay: getCursorNativeToolDisplayState(pi),
			recordCloudLifecycle: captureCursorCloudLifecycleRecorder(pi),
			reportSdkNotice: owner.reportSdkNotice,
		};
	});
	pi.on("session_start", async (_event, ctx) => {
		if (binding.closed) return;
		binding.active = true;
		registry = ctx.modelRegistry;
		// The genuine extension context supplies composed config auth; startup
		// selection already has the known baseline, without reading a default store.
		await registry.refresh({ providers: ["cursor"], allowNetwork: false });
	});
	pi.on("session_shutdown", () => { binding.active = false; binding.closed = true; registry = undefined; });
	return (models: Awaited<ReturnType<typeof discoverModels>>) => {
		if (binding.closed) return;
		const toNative = (definitions: typeof models): Model<"cursor-sdk">[] =>
			definitions.map(({ compat: _compat, ...definition }) => ({
				...definition, provider: "cursor", api: "cursor-sdk", baseUrl: "https://cursor.com",
			}));
		let current = toNative(models);
		const provider: Provider<"cursor-sdk"> = {
			id: "cursor", name: "Cursor", baseUrl: "https://cursor.com",
			auth: { apiKey: cursorApiKeyAuth() },
			getModels: () => current,
			stream: stream,
			streamSimple: stream,
			async refreshModels(context) {
				if (binding.closed) return;
				const resolved = await registry?.getProviderAuth("cursor");
				context.signal.throwIfAborted();
				const credential = context.credential;
				const apiKey = registry
					? normalizeCursorApiKey(resolved?.auth.apiKey)
					: credential?.type === "api_key"
						? normalizeCursorApiKey(credential.key)
							?? normalizeCursorApiKey(credential.env?.CURSOR_API_KEY)
							?? normalizeCursorApiKey(process.env.CURSOR_API_KEY)
						: credential ? undefined : normalizeCursorApiKey(process.env.CURSOR_API_KEY);
				let issue: CursorModelFallbackIssue | undefined;
				await discoverModels({
					apiKey, allowNetwork: context.allowNetwork, forceRefresh: context.force, signal: context.signal,
					onFallback: (next) => { issue = next; },
					publish: (definitions, update) => context.publish({
						update: () => {
							if (binding.closed) return;
							update();
							current = toNative(definitions);
							// Do not infer logout before native composed auth is reachable.
							if (registry && !apiKey) clearModelListCache();
							onCatalog(issue);
						},
					}),
				});
			},
		};
		pi.registerProvider(provider);
	};
}
