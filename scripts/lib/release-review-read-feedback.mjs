import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createReviewReadCoverage } from "./release-review-read-coverage.mjs";
import { parseReviewResponse } from "./release-review-report.mjs";

export default function reviewReadFeedback(pi) {
	const inputPath = process.env.PI_RELEASE_REVIEW_FEEDBACK_INPUT;
	assert.ok(inputPath, "The isolated review must supply its feedback input path");
	const scope = JSON.parse(readFileSync(inputPath, "utf8"));
	const coverage = createReviewReadCoverage(process.cwd(), scope, inputPath);
	pi.on("tool_execution_start", coverage.observe);
	pi.on("tool_execution_end", coverage.observe);
	let report;
	pi.on("message_end", ({ message }) => {
		if (message.role !== "assistant") return;
		report = undefined;
		try {
			report = parseReviewResponse(message.content.filter(part => part.type === "text").map(part => part.text).join("")).report;
		} catch {
			// Invalid responses are rejected by the final gate, not repaired as read omissions.
		}
	});
	let previousMissing;
	pi.on("agent_before_settle", (event) => {
		if (event.outcome !== "completed" || report?.scopeId !== scope.scopeId || report.completed !== true
			|| !Array.isArray(report.materialLimitations) || report.materialLimitations.length) return;
		const { missing } = coverage.inspect();
		if (!missing.length) return;
		const currentMissing = JSON.stringify(missing);
		// Repeating an unchanged instruction cannot repair a reviewer that made no read progress.
		if (currentMissing === previousMissing) return;
		previousMissing = currentMissing;
		return {
			entries: [...event.entries, {
				type: "custom_message", customType: "release-review-missing-reads", display: false,
				content: `Release review read coverage: required inputs remain unread. Continue this same review, preserving all findings and prior analysis. Read the missing paths/ranges below with the read tool, paging until complete. Ranges are inclusive line numbers. For alternatives, complete any one path; unopened paths must first be opened. An unavailable image is a real limitation, not a completed read. Then reassess and return the full review JSON for the original scope. Do not mark an incomplete or failed review complete merely by changing metadata. If an input cannot be examined, report completed=false and its limitation. The independent final gate still applies.\n${currentMissing}`,
			}],
			continue: true,
		};
	});
}
