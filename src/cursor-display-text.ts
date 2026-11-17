/** Canonical single-line sanitization and truncation for Cursor replay/trace display. */
export function sanitizeCursorDisplayLine(value: string): string {
	return value
		.toWellFormed()
		.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function truncateCursorDisplayLine(value: string, maxLength = 240): string {
	if (maxLength <= 0) return "";
	const sanitized = sanitizeCursorDisplayLine(value);
	if (sanitized.length <= maxLength) return sanitized;
	if (maxLength === 1) return "…";
	return `${sanitized.slice(0, maxLength - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
}
