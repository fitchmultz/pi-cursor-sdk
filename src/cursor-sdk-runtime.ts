export type CursorSdkModule = typeof import("@cursor/sdk");

export async function loadCursorSdk(): Promise<CursorSdkModule> {
	return import("@cursor/sdk");
}
