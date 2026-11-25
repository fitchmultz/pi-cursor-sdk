import type { AutocompleteItem } from "@earendil-works/pi-tui";

/** Prefix-filter fixed completion options by label (case-insensitive) and return null when none match. */
export function filterCompletionOptions(
	tokenPrefix: string,
	options: readonly AutocompleteItem[],
): AutocompleteItem[] | null {
	const normalized = tokenPrefix.toLowerCase();
	const matches = options
		.filter((option) => option.label.toLowerCase().startsWith(normalized))
		.map((option) => ({ ...option }));
	return matches.length > 0 ? matches : null;
}

/** Complete a single fixed-option slash-command argument; returns null once a second token starts. */
export function completeSingleTokenOptions(
	argumentPrefix: string,
	options: readonly AutocompleteItem[],
): AutocompleteItem[] | null {
	const trimmed = argumentPrefix.trimStart();
	if (/\s/.test(trimmed)) return null;
	return filterCompletionOptions(trimmed, options);
}
