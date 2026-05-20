import fs from "node:fs";
import path from "node:path";

const root = new URL(".", import.meta.url).pathname;
const sessions = [
	"sessions/glm-5.1-p1/2026-05-20T11-46-08-587Z_019e4535-1a4b-7509-8f5d-f111345e6c3f.jsonl",
	"sessions/composer-2.5-p1/2026-05-20T11-46-37-196Z_019e4535-8a0c-765e-968d-2d6a67a04cb4.jsonl",
	"sessions/glm-5.1-p2/2026-05-20T11-46-18-730Z_019e4535-41ea-721f-9ec1-77f427508dfd.jsonl",
	"sessions/composer-2.5-p2/2026-05-20T11-46-43-873Z_019e4535-a421-75ae-9a07-2746accb0e02.jsonl",
	"sessions/glm-5.1-p3/2026-05-20T11-46-28-117Z_019e4535-6695-7721-8416-103ec9a509e4.jsonl",
	"sessions/composer-2.5-p3/2026-05-20T11-46-48-964Z_019e4535-b804-755a-9de0-51a06488a4db.jsonl",
];

for (const rel of sessions) {
	const file = path.join(root, rel);
	console.log(`\n### ${rel}`);
	const lines = fs.readFileSync(file, "utf8").trim().split("\n");
	for (const line of lines) {
		const entry = JSON.parse(line);
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") {
			const text =
				typeof message.content === "string"
					? message.content
					: Array.isArray(message.content)
						? message.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("")
						: String(message.content);
			console.log("user:", text.slice(0, 100));
			continue;
		}
		if (message.role === "assistant") {
			const summary = (message.content ?? []).map((block) => {
				if (block.type === "toolCall") return `toolCall:${block.name}(${JSON.stringify(block.arguments).slice(0, 80)})`;
				if (block.type === "text") return `text:${block.text.slice(0, 80)}`;
				if (block.type === "thinking") return `thinking:${block.thinking.slice(0, 80)}`;
				return block.type;
			});
			console.log("assistant:", message.stopReason, summary.join(" | "));
		}
		if (message.role === "toolResult") {
			const preview = message.content?.[0]?.text?.slice(0, 80) ?? "";
			console.log("toolResult:", message.toolName, message.isError ? "error" : "ok", preview);
		}
	}
}
