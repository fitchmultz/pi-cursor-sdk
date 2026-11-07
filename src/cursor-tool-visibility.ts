import {
	getCursorReplayActivityTitle,
	getCursorToolVisibilityPolicy,
	normalizeCursorToolName as normalizeToolName,
} from "./cursor-tool-presentation-registry.js";
import { getToolArgs, getToolName } from "./cursor-transcript-utils.js";
import { resolveTranscriptToolName } from "./cursor-web-tool-activity.js";

export interface CursorToolVisibility {
	args: Record<string, unknown>;
	displayName: string;
	normalizedName: string;
	normalizedKey: string;
	activityTitle?: string;
	incompleteTitle?: string;
	lifecycleTitle?: string;
	lifecycleEligible: boolean;
	fastLocalDiscovery: boolean;
}

export function getNormalizedCursorToolName(toolCall: unknown): string {
	return classifyCursorToolVisibility(toolCall).normalizedName;
}

export function classifyCursorToolVisibility(toolCall: unknown): CursorToolVisibility {
	const args = getToolArgs(toolCall);
	const displayName = resolveTranscriptToolName(getToolName(toolCall), args);
	const normalizedName = normalizeToolName(displayName);
	const normalizedKey = normalizedName.toLowerCase();
	const config = getCursorToolVisibilityPolicy(normalizedKey);
	const replayActivityTitle = getCursorReplayActivityTitle(normalizedName);
	return {
		args,
		displayName,
		normalizedName,
		normalizedKey,
		activityTitle: replayActivityTitle ?? config?.incompleteTitle ?? config?.lifecycleTitle,
		incompleteTitle: replayActivityTitle ?? config?.incompleteTitle,
		lifecycleTitle: replayActivityTitle ?? config?.lifecycleTitle,
		lifecycleEligible: config?.lifecycleEligible ?? false,
		fastLocalDiscovery: config?.fastLocalDiscovery ?? false,
	};
}
