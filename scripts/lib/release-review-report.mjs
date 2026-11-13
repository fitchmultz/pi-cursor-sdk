export function parseReviewResponse(text) {
	const response = text.trim();
	const closeFence = /\r?\n```[ \t]*$/.exec(response);
	if (closeFence) {
		const beforeClose = response.slice(0, closeFence.index);
		const openFence = [...beforeClose.matchAll(/^```(?:json)?[ \t]*\r?\n/gm)].at(-1);
		if (openFence) {
			try {
				const report = JSON.parse(beforeClose.slice(openFence.index + openFence[0].length));
				if (report && typeof report === "object" && !Array.isArray(report)) {
					return { report, commentary: beforeClose.slice(0, openFence.index).trim() };
				}
			} catch {
				// Fall through when the trailing code block is not a JSON object verdict.
			}
		}
	}
	for (const match of [...response.matchAll(/\n[ \t]*\{/g)].reverse()) {
		try {
			const report = JSON.parse(response.slice(match.index + 1));
			if (report && typeof report === "object" && !Array.isArray(report)) {
				return { report, commentary: response.slice(0, match.index).trim() };
			}
		} catch {
			// Continue scanning earlier line-starting braces when a nested object or string precedes the outer brace.
		}
	}
	return { report: JSON.parse(response), commentary: "" };
}
