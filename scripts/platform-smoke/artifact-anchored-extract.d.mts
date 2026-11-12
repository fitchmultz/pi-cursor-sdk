type AnchoredArtifactFile = {
	path: string;
	content: Uint8Array;
};

type ArtifactExtractionOutcome = "committed" | "rejected" | "rolled-back" | "rollback-incomplete" | "unknown";

export function writeExtractedFilesAnchored(
	outputDir: string,
	files: readonly AnchoredArtifactFile[],
	expectedRoot: { dev: number | bigint; ino: number | bigint },
): ArtifactExtractionOutcome;
