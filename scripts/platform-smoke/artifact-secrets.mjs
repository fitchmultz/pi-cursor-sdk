/**
 * Secret redaction and scanning shared by artifact scanning, bundle building, and extraction.
 */

import { isUtf8 } from "node:buffer";
import { extname } from "node:path";
import { TextDecoder } from "node:util";
import { scrubSensitiveText } from "../../shared/cursor-sensitive-text.mjs";
import { MAX_BUNDLE_FILE_BYTES } from "./artifact-bundle-contract.mjs";

export const SECRET_PATTERNS = [
	[/Authorization:\s*Bearer\s+[A-Za-z0-9\-._~+/]{20,}=*/gi, "Authorization header", "Authorization: Bearer [REDACTED_BEARER_TOKEN]"],
	[/(bearer\s+)[A-Za-z0-9\-._~+/]{20,}=*/gi, "bearer token", "$1[REDACTED_BEARER_TOKEN]"],
	[/connect\.sid=[A-Za-z0-9%]+/gi, "session cookie", "connect.sid=[REDACTED_SESSION_COOKIE]"],
	[/https?:\/\/[^/\s]*\/cursor-pi-tool-bridge\/[A-Za-z0-9_.:-]+\/mcp/gi, "bridge endpoint URL", "[REDACTED_BRIDGE_ENDPOINT_URL]"],
	[/"(apiKey|accessToken|refreshToken|session|cookie)"\s*:\s*"[^"\s]{12,}"/gi, "auth/token JSON field", '"$1":"[REDACTED_SECRET]"'],
	[/\b[a-z][a-z0-9+.-]*:\/\/(?!\[redacted\]@)[^\s/?#]*@[^\s/?#]+/gi, "credential-bearing URL", "[REDACTED_CREDENTIAL_URL]"],
	[/\b[^\s/:@]+:[^\s/]+@(?=[A-Za-z0-9.-]+(?::|\/|\s|$))/g, "credential-bearing SCP URL", "[REDACTED_CREDENTIAL_URL]"],
];

const AUTH_ASSIGNMENT_PATTERN = /(?:^|[^A-Za-z0-9_$])(?:authorization|api[_-]?key|apiKey|access[_-]?token|refresh[_-]?token|token)["']?\s*[:=]\s*/gim;
const UNQUOTED_SECRET_CHARACTER = /^[A-Za-z0-9._~+/=-]$/;

function authAssignmentSecretRanges(text) {
	const ranges = [];
	AUTH_ASSIGNMENT_PATTERN.lastIndex = 0;
	let match;
	while ((match = AUTH_ASSIGNMENT_PATTERN.exec(text))) {
		let start = AUTH_ASSIGNMENT_PATTERN.lastIndex;
		const quote = text[start];
		if (quote === '"' || quote === "'" || quote === "`") {
			let end = start + 1;
			while (end < text.length && text[end] !== quote) {
				end += text[end] === "\\" && end + 1 < text.length ? 2 : 1;
			}
			const sourceBearerTemplate = quote === "`" && /^Bearer\s+\$\{[A-Za-z_$][A-Za-z0-9_$.[\]]*\}$/.test(text.slice(start + 1, end));
			if (!sourceBearerTemplate && end - start - 1 >= 12) ranges.push({ start: start + 1, end });
			if (end >= text.length) break;
			AUTH_ASSIGNMENT_PATTERN.lastIndex = end + 1;
			continue;
		}
		let hasDigit = false;
		let end = start;
		while (end < text.length && UNQUOTED_SECRET_CHARACTER.test(text[end])) {
			hasDigit ||= /[0-9]/.test(text[end]);
			end++;
		}
		if (hasDigit && end - start >= 12) ranges.push({ start, end });
		AUTH_ASSIGNMENT_PATTERN.lastIndex = Math.max(end, start + 1);
	}
	return ranges;
}

function redactAuthAssignments(text) {
	let redacted = text;
	for (const range of authAssignmentSecretRanges(text).reverse()) {
		redacted = `${redacted.slice(0, range.start)}[REDACTED_SECRET]${redacted.slice(range.end)}`;
	}
	return redacted;
}

/** Redact known secret material before writing logs/artifacts. */
export function redactSecrets(text) {
	const cursorKey = process.env.CURSOR_API_KEY;
	let redacted = redactAuthAssignments(String(text ?? ""));
	redacted = scrubSensitiveText(redacted, cursorKey);
	if (cursorKey && cursorKey.length > 10) {
		redacted = redacted.split(cursorKey).join("[REDACTED_CURSOR_API_KEY]");
	}
	for (const [pattern, , replacement] of SECRET_PATTERNS) {
		redacted = redacted.replace(pattern, replacement);
	}
	return redacted;
}

/** Scrub decoded property names and strings, not JSON syntax or diagnostic scalars. */
export function redactArtifactText(path, text) {
	const extension = extname(path).toLowerCase();
	if (extension !== ".json" && extension !== ".jsonl") return redactSecrets(text);
	const replace = (key, value) => {
		if (value && typeof value === "object" && !Array.isArray(value)) {
			const redacted = Object.create(null);
			for (const [name, item] of Object.entries(value)) {
				const redactedName = redactSecrets(name);
				if (Object.hasOwn(redacted, redactedName)) throw new Error("invalid structured artifact");
				redacted[redactedName] = item;
			}
			return redacted;
		}
		if (typeof value !== "string") return value;
		// Ask the shared recognizer about the field name without passing secret contents.
		if (value && scrubSensitiveText(`${key}=x`) !== `${key}=x`) return "[redacted]";
		return redactSecrets(value);
	};
	const json = (record) => JSON.stringify(JSON.parse(record), replace);
	try {
		const redacted = extension === ".json"
			? `${json(text)}\n`
			: text.split(/\r?\n/).map((line) => line.trim() ? json(line) : line).join("\n");
		if (Buffer.byteLength(redacted) > MAX_BUNDLE_FILE_BYTES) throw new Error("invalid structured artifact");
		return redacted;
	} catch {
		throw new Error("invalid structured artifact");
	}
}

export function isBinaryArtifactContent(value) {
	return Buffer.isBuffer(value) && (!isUtf8(value) || value.includes(0));
}

function swapUtf16Bytes(value) {
	const result = Buffer.from(value);
	for (let index = 0; index + 1 < result.length; index += 2) {
		[result[index], result[index + 1]] = [result[index + 1], result[index]];
	}
	return result;
}

function encodeUtf32(value, littleEndian) {
	const codePoints = [...value].map((character) => character.codePointAt(0));
	const result = Buffer.alloc(codePoints.length * 4);
	for (let index = 0; index < codePoints.length; index++) {
		if (littleEndian) result.writeUInt32LE(codePoints[index], index * 4);
		else result.writeUInt32BE(codePoints[index], index * 4);
	}
	return result;
}

function decodeUtf32(value, littleEndian) {
	let result = "";
	const chunk = [];
	for (let offset = 0; offset + 3 < value.length; offset += 4) {
		const codePoint = littleEndian ? value.readUInt32LE(offset) : value.readUInt32BE(offset);
		chunk.push(codePoint <= 0x10ffff && (codePoint < 0xd800 || codePoint > 0xdfff) ? String.fromCodePoint(codePoint) : "\ufffd");
		if (chunk.length === 4096) {
			result += chunk.join("");
			chunk.length = 0;
		}
	}
	return result + chunk.join("");
}

function* binaryTextCandidates(value) {
	yield value.toString("latin1");
	for (let offset = 0; offset < Math.min(2, value.length); offset++) {
		const aligned = value.subarray(offset);
		yield new TextDecoder("utf-16le").decode(aligned);
		yield new TextDecoder("utf-16be").decode(aligned);
	}
	for (let offset = 0; offset < Math.min(4, value.length); offset++) {
		const aligned = value.subarray(offset);
		yield decodeUtf32(aligned, true);
		yield decodeUtf32(aligned, false);
	}
}

function bufferContainsEncodedSecret(value, secret) {
	const utf16Le = Buffer.from(secret, "utf16le");
	return [
		Buffer.from(secret, "utf8"), utf16Le, swapUtf16Bytes(utf16Le),
		encodeUtf32(secret, true), encodeUtf32(secret, false),
	].some((encoded) => encoded.length > 0 && value.indexOf(encoded) !== -1);
}

/** Scan text or binary content for secrets. Returns array of violation descriptions. */
export function scanForSecrets(value) {
	const buffer = Buffer.isBuffer(value) ? value : undefined;
	const binary = isBinaryArtifactContent(value);
	const plainText = buffer ? undefined : String(value ?? "");
	const violations = new Set();
	const cursorKey = process.env.CURSOR_API_KEY;
	if (cursorKey && cursorKey.length > 10 && (
		buffer ? bufferContainsEncodedSecret(buffer, cursorKey) : plainText.includes(cursorKey)
	)) {
		violations.add("CURSOR_API_KEY literal found");
	}
	const patterns = SECRET_PATTERNS.filter(([, label]) =>
		!binary || (label !== "credential-bearing URL" && label !== "credential-bearing SCP URL"));
	const texts = buffer ? (binary ? binaryTextCandidates(buffer) : [buffer.toString("utf8")]) : [plainText];
	for (const text of texts) {
		if (authAssignmentSecretRanges(text).length > 0) violations.add("potential auth/token assignment");
		for (const [pattern, label] of patterns) {
			pattern.lastIndex = 0;
			if (pattern.test(text)) violations.add(`potential ${label}`);
		}
	}
	return [...violations];
}
