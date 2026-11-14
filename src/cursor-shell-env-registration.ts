import type { ExtensionAPI, ExtensionHandler, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { applyPiShellToCursorProcess } from "./cursor-shell-env.js";

interface CursorShellEnvExtensionApi {
	/** Throws until Pi initializes the extension runtime. */
	getSettings?(): ReturnType<ExtensionAPI["getSettings"]>;
	on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
}

/**
 * `pi.getSettings()` throws until Pi finishes initializing the extension
 * runtime, so reading it in the extension factory failed the whole extension
 * load. `session_start` is the earliest point where settings are readable and
 * Cursor has not spawned a shell yet.
 */
export function registerCursorShellEnv(pi: CursorShellEnvExtensionApi): void {
	pi.on("session_start", () => {
		try {
			applyPiShellToCursorProcess(pi.getSettings?.().shellPath);
		} catch {
			// Advisory only: an unreadable shell path leaves Cursor's own choice.
		}
	});
}
