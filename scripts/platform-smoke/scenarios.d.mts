interface PlatformSmokeScenario {
	description: string;
	cursorCalls: number;
	env?: Record<string, string>;
	commands?: Record<string, { posix?: string; powershell?: string }>;
	promptTemplate?: string;
	finalMarker?: string | null;
	requiredCards?: string[];
	requiredJSONLTools?: Array<{ name: string }>;
	requiredJSONLResults?: Array<Record<string, unknown>>;
	expectedJSONLResultToolOrder?: string[];
	visualEvidence?: Array<Record<string, unknown>>;
	requiredBridgeDiagnostics?: boolean | "abort";
	storeRootRelative?: string;
}

interface PlatformSmokePromptScenario extends PlatformSmokeScenario {
	promptTemplate: string;
}

export const SCENARIOS: Record<string, PlatformSmokeScenario>;
export function getScenario(name: string): PlatformSmokeScenario | null;
export function renderPrompt(scenario: PlatformSmokePromptScenario, platform: string): string;
