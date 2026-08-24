import { isAbsolute } from "node:path";

export type StoreRootPathIssue = "relative" | "filesystem-root" | "unsafe-segment";

export function splitStoreRootSegments(value: string): string[] {
	return value.split(/[\\/]/).filter((segment) => segment !== "" && !/^[A-Za-z]:$/.test(segment));
}

export function validateStoreRootPath(value: string): StoreRootPathIssue | undefined {
	if (!isAbsolute(value)) return "relative";
	const segments = splitStoreRootSegments(value);
	if (segments.length === 0) return "filesystem-root";
	if (segments.some((segment) => segment === "." || segment === "..")) return "unsafe-segment";
	return undefined;
}
