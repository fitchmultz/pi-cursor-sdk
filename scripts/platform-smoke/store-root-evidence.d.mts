export function collectStoreRootEvidence(
	configuredStoreRoot: string,
	workspaceDir: string,
): {
	configuredStoreRoot: string;
	workspaceDir: string;
	sqlitePaths: string[];
	piSessionSqlite: string[];
	defaultLayoutSqlite: string[];
	ok: boolean;
	reasons: string[];
};
