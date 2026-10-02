import type { Context } from "@earendil-works/pi-ai";
import { resolveCursorPiContext } from "./cursor-pi-context.js";

/** Tool names from the provider context snapshot at stream start (not live pi.getActiveTools()). */
export function getActiveContextToolNames(context: Context): ReadonlySet<string> | undefined {
	const { tools } = resolveCursorPiContext(context);
	return tools === undefined ? undefined : new Set(tools.map((tool) => tool.name));
}
