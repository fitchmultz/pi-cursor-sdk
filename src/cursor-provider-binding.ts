import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Context, Model, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { cursorApiKeyAuth, normalizeCursorApiKey, resolveCursorCredentialApiKey } from "./cursor-api-key.js";
import { parseEnvBoolean } from "./cursor-env-boolean.js";
import { discoverModels, snapshotCursorModelMetadata, type CursorModelCatalogProvenance, type CursorModelFallbackIssue, type CursorModelMetadata } from "./model-discovery.js";
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
type ProviderBindingState = "registered" | "active" | "closed";
interface SharedProviderBinding {
	get active(): boolean;
	set active(active: false);
	get closed(): boolean;
	set closed(closed: true);
}
/**
 * Registered until its session starts, active until shutdown or observed disposal, then closed.
 * Receipts and catalog subscribers share bindings with other extension graph copies, including
 * other package releases, under the v1 keys: every copy reads `active`/`closed` and closes a
 * binding it may not own by assigning `active = false`, then `closed = true`. Only that `closed`
 * assignment changes this binding's state.
 */
class ProviderBinding implements SharedProviderBinding {
	#state: ProviderBindingState = "registered";
	get state(): ProviderBindingState { return this.#state; }
	activate(): boolean {
		if (this.#state === "closed") return false;
		this.#state = "active";
		return true;
	}
	get active(): boolean { return this.#state === "active"; }
	set active(_active: false) {}
	get closed(): boolean { return this.#state === "closed"; }
	set closed(closed: true) { if (closed) this.#state = "closed"; }
}
type CatalogListener = (provenance: CursorServedCatalogProvenance, metadata?: readonly CursorModelMetadata[]) => void;
interface RequestReceipt {
	binding: SharedProviderBinding;
	pi: BindingExtension;
	serve: ReturnType<typeof createCursorLazyStream>;
}
// Pi evaluates each extension instance with its own module graph. Hosts that share one
// ModelRuntime keep the first instance's provider, so receipts must be visible process-wide.
const REQUEST_OWNERS_KEY = Symbol.for("pi-cursor-sdk.provider-request-receipts.v1");
const processState = globalThis as typeof globalThis & ProviderProcessState;
const requestOwners = (processState[REQUEST_OWNERS_KEY] ??= new WeakMap<object, RequestReceipt>());
export type CursorServedCatalogProvenance = CursorModelCatalogProvenance | { source: "unknown"; issue?: CursorModelFallbackIssue };
// Released copies read and write the v1 `published`/`issue`/`metadata` fields and listener arguments.
// `provenance` is additive; a copy that predates it sends only the issue, so the source it served is unknown.
type CatalogWireListener = (issue?: CursorModelFallbackIssue, metadata?: readonly CursorModelMetadata[], provenance?: CursorModelCatalogProvenance) => void;
interface CatalogChannel { published: boolean; issue?: CursorModelFallbackIssue; metadata?: readonly CursorModelMetadata[]; provenance?: CursorModelCatalogProvenance }
interface CatalogSubscriber {
	stream: object;
	binding: SharedProviderBinding;
	pi: BindingExtension;
	listener: CatalogWireListener;
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
function closeBinding(binding: SharedProviderBinding): void {
	binding.active = false;
	binding.closed = true;
}
function collectAliasModelIds(metadata: readonly CursorModelMetadata[]): ReadonlySet<string> {
	const ids = new Set<string>();
	for (const entry of metadata) {
		if (entry.selectionModelId !== entry.baseModelId) ids.add(entry.piModelId);
	}
	return ids;
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
	const binding = new ProviderBinding();
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
			if (binding.state !== "active") return false;
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
			if (binding.state !== "active") throw inactiveError();
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
			if (binding.state === "closed" || (binding.state === "registered" && !owner)) throw inactiveError();
			if (!owner) throw new Error("Cursor provider ownership is unavailable: this call has no native session request receipt. Bare modelRegistry.streamSimple calls are unsupported for Cursor; use the owning AgentSession's stream path or an independent child AgentSession.");
			// A registrant that never started is a shared-runtime host's bootstrap instance
			// (e.g. PI WEB). It delegates to the module that issued the receipt.
			if (owner.binding !== binding && binding.state === "active") throw new Error(CURSOR_PROVIDER_OWNERSHIP_ERROR);
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
	const emitCatalog = (provenance: CursorModelCatalogProvenance, metadata: readonly CursorModelMetadata[]) => {
		if (binding.state === "closed") return;
		ownCatalog.published = true;
		ownCatalog.issue = provenance.issue;
		ownCatalog.metadata = metadata;
		ownCatalog.provenance = provenance;
		onCatalog?.(provenance, metadata);
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
			if (candidate.servingStream() === stream) candidate.listener(provenance.issue, metadata, provenance);
		}
	};
	pi.on("session_start", async (_event, ctx) => {
		if (!binding.activate()) return;
		registry = ctx.modelRegistry;
		unsubscribeServingCatalog();
		const nextSubscriber: CatalogSubscriber = {
			stream,
			binding,
			pi,
			listener: (issue, metadata, provenance) => onCatalog?.(provenance ?? { source: "unknown", issue }, metadata),
			servingStream: () => nativeCursorStream(registry),
		};
		subscriber = { strongAnchor: nextSubscriber, reference: new WeakRef(nextSubscriber) };
		catalogSubscribers.add(subscriber.reference);
		const serving = nextSubscriber.servingStream();
		if (serving && serving !== stream) {
			const servingCatalog = catalogChannelFor(serving);
			if (servingCatalog.published) nextSubscriber.listener(servingCatalog.issue, servingCatalog.metadata, servingCatalog.provenance);
		}
		// The genuine extension context supplies composed config auth; startup
		// selection already has the known baseline, without reading a default store.
		await registry.refresh({ providers: ["cursor"], allowNetwork: false });
	});
	pi.on("session_shutdown", () => {
		binding.closed = true;
		registry = undefined;
		unsubscribeServingCatalog();
	});
	return (
		models: Awaited<ReturnType<typeof discoverModels>>,
		catalogListener: CatalogListener,
		initialMetadata: readonly CursorModelMetadata[] = [],
	) => {
		if (binding.state === "closed") return;
		onCatalog = catalogListener;
		const toNative = (definitions: typeof models): Model<"cursor-sdk">[] =>
			definitions.map(({ compat: _compat, ...definition }) => ({
				...definition, provider: "cursor", api: "cursor-sdk", baseUrl: "https://cursor.com",
			}));
		let current = toNative(models);
		let aliasModelIds = collectAliasModelIds(initialMetadata);
		const provider: Provider<"cursor-sdk"> = {
			id: "cursor", name: "Cursor", baseUrl: "https://cursor.com",
			auth: { apiKey: cursorApiKeyAuth() },
			getModels: () => current,
			filterModels: (available) =>
				parseEnvBoolean(process.env.PI_CURSOR_MODEL_ALIASES, false)
					? available
					: available.filter((model) => !aliasModelIds.has(model.id)),
			stream: stream,
			streamSimple: stream,
			async refreshModels(context) {
				if (binding.state === "closed") return;
				const resolved = await registry?.getProviderAuth("cursor");
				context.signal.throwIfAborted();
				const credential = context.credential;
				const apiKey = registry
					? normalizeCursorApiKey(resolved?.auth.apiKey)
					: credential && credential.type !== "api_key" ? undefined
						: await resolveCursorCredentialApiKey(credential, async () => process.env.CURSOR_API_KEY);
				// The bootstrap never receives session_start, so a cache-only refresh cannot see composed
				// models.json auth. Keep a published live or cached catalog without a fallback issue instead
				// of publishing a missing key; republishing it is not a new live response.
				if (!registry && context.allowNetwork === false && !apiKey && ownCatalog.published && ownCatalog.issue === undefined) {
					const metadata = ownCatalog.metadata ?? snapshotCursorModelMetadata();
					await context.publish({ update: () => { emitCatalog({ source: "cache" }, metadata); } });
					return;
				}
				await discoverModels({
					apiKey, allowNetwork: context.allowNetwork, forceRefresh: context.force, signal: context.signal,
					publish: (definitions, provenance, update, metadata) => context.publish({
						update: () => {
							if (binding.state === "closed") return;
							update();
							current = toNative(definitions);
							aliasModelIds = collectAliasModelIds(metadata);
							// Do not infer logout before native composed auth is reachable.
							if (registry && !apiKey) clearModelListCache();
							emitCatalog(provenance, metadata);
						},
					}),
				});
			},
		};
		pi.registerProvider(provider);
	};
}
