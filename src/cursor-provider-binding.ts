import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Context, Model, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { cursorApiKeyAuth, normalizeCursorApiKey, resolveCursorCredentialApiKey } from "./cursor-api-key.js";
import { discoverModels, snapshotCursorModelMetadata, type CursorModelFallbackIssue, type CursorModelMetadata } from "./model-discovery.js";
import { clearModelListCache } from "./model-list-cache.js";
import { captureCursorCloudLifecycleRecorder } from "./cursor-cloud-lifecycle.js";
import { captureCursorUsageRecorder } from "./cursor-usage-ledger.js";
import { getCursorNativeToolDisplayState } from "./cursor-native-tool-display-state.js";
import { getRegisteredCursorPiToolBridge } from "./cursor-pi-tool-bridge.js";
import { createCursorLazyStream } from "./cursor-provider-lazy.js";
import { getCursorSessionScopeSnapshot, isCursorExtensionDisposed } from "./cursor-session-scope.js";
import { captureCursorRequestProjection, resolveCursorRequestProvenance, type CursorRequestProvenance } from "./cursor-request-provenance.js";
import type { CursorSdkOutputNoticeHandler } from "./cursor-sdk-output-filter.js";

export const CURSOR_PROVIDER_OWNERSHIP_ERROR = "Cursor provider ownership is unavailable: this request does not belong to the active Cursor registration. Reload this session's extensions to restore its Cursor registration; use independent ModelRuntime instances for sibling sessions.";
type BindingExtension = Pick<ExtensionAPI, "on" | "registerProvider" | "appendEntry"> & { getSessionName?(): string | undefined };
interface ProviderBinding { active: boolean; closed: boolean }
type CatalogListener = (issue?: CursorModelFallbackIssue, metadata?: readonly CursorModelMetadata[]) => void;
interface RequestReceipt {
	binding: ProviderBinding;
	pi: BindingExtension;
	serve: ReturnType<typeof createCursorLazyStream>;
}
// Pi evaluates each extension instance with its own module graph. Hosts that share one
// ModelRuntime keep the first instance's provider, so receipts must be visible process-wide.
const REQUEST_OWNERS_KEY = Symbol.for("pi-cursor-sdk.provider-request-receipts.v1");
const processState = globalThis as typeof globalThis & ProviderProcessState;
const requestOwners = (processState[REQUEST_OWNERS_KEY] ??= new WeakMap<object, RequestReceipt>());
interface CatalogChannel { published: boolean; issue?: CursorModelFallbackIssue; metadata?: readonly CursorModelMetadata[] }
interface CatalogSubscriber {
	stream: object;
	binding: ProviderBinding;
	pi: BindingExtension;
	listener: CatalogListener;
	servingStream(): object | undefined;
}
// Sessions served by another instance's provider learn its catalog provenance here.
// The channel is keyed by the raw native stream. Subscribers resolve that stream through
// ModelRegistry.getRegisteredNativeProvider so composed and virtual-model wrappers still match,
// including when a sibling registration replaces the provider after session_start.
const CATALOG_CHANNELS_KEY = Symbol.for("pi-cursor-sdk.provider-catalog-channels.v1");
const CATALOG_SUBSCRIBERS_KEY = Symbol.for("pi-cursor-sdk.provider-catalog-subscribers.v1");
interface ProviderProcessState {
	[REQUEST_OWNERS_KEY]?: WeakMap<object, RequestReceipt>;
	[CATALOG_CHANNELS_KEY]?: WeakMap<object, CatalogChannel>;
	[CATALOG_SUBSCRIBERS_KEY]?: Set<WeakRef<CatalogSubscriber>>;
}
const catalogChannels = (processState[CATALOG_CHANNELS_KEY] ??= new WeakMap<object, CatalogChannel>());
const catalogSubscribers = (processState[CATALOG_SUBSCRIBERS_KEY] ??= new Set<WeakRef<CatalogSubscriber>>());
function catalogChannelFor(stream: object): CatalogChannel {
	let channel = catalogChannels.get(stream);
	if (!channel) catalogChannels.set(stream, channel = { published: false });
	return channel;
}
function closeBinding(binding: ProviderBinding): void {
	binding.active = false;
	binding.closed = true;
}
type CursorRegistry = {
	getProvider(id: string): { streamSimple?: object } | undefined;
	getRegisteredNativeProvider?(id: string): { streamSimple?: object } | undefined;
};
function nativeCursorStream(registry: CursorRegistry | undefined): object | undefined {
	if (registry && typeof registry.getRegisteredNativeProvider === "function") {
		const native = registry.getRegisteredNativeProvider("cursor")?.streamSimple;
		if (native) return native;
	}
	return registry?.getProvider("cursor")?.streamSimple;
}

/** One closure per ExtensionAPI, including direct compaction/tree/bug-report streams. */
export function registerCursorProviderBinding(
	pi: BindingExtension,
) {
	const binding: ProviderBinding = { active: false, closed: false };
	let registry: ExtensionContext["modelRegistry"] | undefined;
	const operations = new WeakMap<AbortSignal, CursorRequestProvenance["purpose"]>();
	const inactiveError = () => new Error("Cursor provider binding is not active. Bind this session's extensions, or reload the session after shutdown.");
	pi.on("session_before_compact", (event) => { operations.set(event.signal, "compaction"); });
	pi.on("session_before_tree", (event) => { operations.set(event.signal, "tree"); });
	pi.on("before_provider_headers", (event, ctx) => {
		const notices = new Set<string>();
		// Pi's SDK supplies this session-owned callback for ordinary and auxiliary
		// streams. ModelRuntime forwards the same real headers object to the provider.
		const scope = getCursorSessionScopeSnapshot(pi);
		const projection = captureCursorRequestProjection(ctx.sessionManager);
		const usageRecorder = captureCursorUsageRecorder(pi, ctx);
		const reportSdkNotice: CursorSdkOutputNoticeHandler = (kind, message) => {
			if (!binding.active || binding.closed) return false;
			if (notices.has(kind)) return;
			pi.appendEntry("pi-cursor-sdk:capability-notice", { kind, message });
			if (ctx.hasUI) ctx.ui.notify(message, "warning");
			else console.warn(message);
			notices.add(kind);
		};
		const operationPurpose = (signal: AbortSignal | undefined) => signal && operations.get(signal);
		// serve closes over this module's streamCursor, agent pool, settings and lifecycle.
		// A shared-runtime bootstrap delegates here instead of executing in its own graph.
		const serve = createCursorLazyStream((model, context, options) => {
			if (binding.closed || !binding.active) throw inactiveError();
			return {
				request: resolveCursorRequestProvenance(projection, model, context, operationPurpose(options?.signal) || "normal"),
				usageRecorder,
				scope,
				bridge: getRegisteredCursorPiToolBridge(pi),
				nativeDisplay: getCursorNativeToolDisplayState(pi),
				recordCloudLifecycle: captureCursorCloudLifecycleRecorder(pi),
				reportSdkNotice,
			};
		});
		requestOwners.set(event.headers, { binding, pi, serve });
	});
	const stream = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
		let serve: RequestReceipt["serve"] | undefined;
		try {
			const headers = options?.headers;
			const owner = headers && requestOwners.get(headers);
			if (headers) requestOwners.delete(headers);
			if (owner && isCursorExtensionDisposed(owner.pi)) closeBinding(owner.binding);
			if (binding.closed || (!binding.active && !owner)) throw inactiveError();
			if (!owner) throw new Error("Cursor provider ownership is unavailable: this call has no native session request receipt. Bare modelRegistry.streamSimple calls are unsupported for Cursor; use the owning AgentSession's stream path or an independent child AgentSession.");
			// A registrant that never started is a shared-runtime host's bootstrap instance
			// (e.g. PI WEB). It delegates to the module that issued the receipt.
			if (owner.binding !== binding && binding.active) throw new Error(CURSOR_PROVIDER_OWNERSHIP_ERROR);
			if (!owner.binding.active || owner.binding.closed) throw inactiveError();
			serve = owner.serve;
		} catch (error) {
			return createCursorLazyStream(() => { throw error; })(model, context, options);
		}
		return serve(model, context, options);
	};
	const ownCatalog = catalogChannelFor(stream);
	let onCatalog: CatalogListener | undefined;
	// strongAnchor is intentionally unread: this session closure keeps the weakly registered subscriber alive.
	let subscriber: { strongAnchor: CatalogSubscriber; reference: WeakRef<CatalogSubscriber> } | undefined;
	const unsubscribeServingCatalog = () => {
		if (subscriber) catalogSubscribers.delete(subscriber.reference);
		subscriber = undefined;
	};
	const emitCatalog = (issue: CursorModelFallbackIssue | undefined, metadata: readonly CursorModelMetadata[]) => {
		if (binding.closed) return;
		ownCatalog.published = true;
		ownCatalog.issue = issue;
		ownCatalog.metadata = metadata;
		onCatalog?.(issue, metadata);
		for (const reference of [...catalogSubscribers]) {
			const candidate = reference.deref();
			if (!candidate) {
				catalogSubscribers.delete(reference);
				continue;
			}
			if (candidate.binding.closed || isCursorExtensionDisposed(candidate.pi)) {
				closeBinding(candidate.binding);
				catalogSubscribers.delete(reference);
				continue;
			}
			if (candidate.stream === stream) continue;
			if (candidate.servingStream() === stream) candidate.listener(issue, metadata);
		}
	};
	pi.on("session_start", async (_event, ctx) => {
		if (binding.closed) return;
		binding.active = true;
		registry = ctx.modelRegistry;
		unsubscribeServingCatalog();
		const nextSubscriber: CatalogSubscriber = {
			stream,
			binding,
			pi,
			listener: (issue, metadata) => onCatalog?.(issue, metadata),
			servingStream: () => nativeCursorStream(registry),
		};
		subscriber = { strongAnchor: nextSubscriber, reference: new WeakRef(nextSubscriber) };
		catalogSubscribers.add(subscriber.reference);
		const serving = nextSubscriber.servingStream();
		if (serving && serving !== stream) {
			const servingCatalog = catalogChannelFor(serving);
			if (servingCatalog.published) nextSubscriber.listener(servingCatalog.issue, servingCatalog.metadata);
		}
		// The genuine extension context supplies composed config auth; startup
		// selection already has the known baseline, without reading a default store.
		await registry.refresh({ providers: ["cursor"], allowNetwork: false });
	});
	pi.on("session_shutdown", () => {
		closeBinding(binding);
		registry = undefined;
		unsubscribeServingCatalog();
	});
	return (models: Awaited<ReturnType<typeof discoverModels>>, catalogListener: CatalogListener) => {
		if (binding.closed) return;
		onCatalog = catalogListener;
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
					: credential && credential.type !== "api_key" ? undefined
						: await resolveCursorCredentialApiKey(credential, async () => process.env.CURSOR_API_KEY);
				// The bootstrap never receives session_start, so a cache-only refresh cannot see
				// composed models.json auth. Keep a live catalog instead of publishing a missing key.
				if (!registry && context.allowNetwork === false && !apiKey && ownCatalog.published && ownCatalog.issue === undefined) {
					const metadata = snapshotCursorModelMetadata();
					await context.publish({ update: () => { emitCatalog(undefined, metadata); } });
					return;
				}
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
							emitCatalog(issue, snapshotCursorModelMetadata());
						},
					}),
				});
			},
		};
		pi.registerProvider(provider);
	};
}
