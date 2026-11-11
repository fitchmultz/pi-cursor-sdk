export function parseReviewResponse(text) {
	const response = text.trim();
	const fenced = /(?:^|\n)```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/.exec(response);
	return {
		report: JSON.parse(fenced ? fenced[1] : response),
		commentary: fenced ? response.slice(0, fenced.index).trim() : "",
	};
}
