import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const CURSOR_PROVIDER = "cursor";
export const CURSOR_SDK_API = "cursor-sdk";

export type CursorModelRef =
	| Pick<NonNullable<ExtensionContext["model"]>, "provider" | "api">
	| undefined;

export function isCursorModel(model: CursorModelRef): boolean {
	return model?.provider === CURSOR_PROVIDER || model?.api === CURSOR_SDK_API;
}
