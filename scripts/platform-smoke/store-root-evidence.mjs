import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

function findNamedFiles(root, fileName, out = []) {
	if (!existsSync(root)) return out;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = resolve(root, entry.name);
		if (entry.isDirectory()) findNamedFiles(path, fileName, out);
		else if (entry.isFile() && entry.name === fileName) out.push(path);
	}
	return out;
}

/** Summarize custom storeRoot evidence after a persisted live session turn. */
export function collectStoreRootEvidence(configuredStoreRoot, workspaceDir) {
	const sqlitePaths = findNamedFiles(configuredStoreRoot, "index.db");
	const piSessionSqlite = sqlitePaths.filter((path) => path.includes("pi-sessions"));
	const defaultLayoutSqlite = findNamedFiles(workspaceDir, "index.db").filter(
		(path) => path.includes(".cursor") || path.includes("sdk-agent-store"),
	);
	const reasons = [];
	if (!existsSync(configuredStoreRoot)) reasons.push("configured storeRoot missing");
	if (piSessionSqlite.length === 0) reasons.push("no index.db under configured storeRoot pi-sessions");
	if (defaultLayoutSqlite.length > 0) reasons.push("workspace default-layout sqlite present");
	return {
		configuredStoreRoot,
		workspaceDir,
		sqlitePaths,
		piSessionSqlite,
		defaultLayoutSqlite,
		ok: reasons.length === 0,
		reasons,
	};
}
