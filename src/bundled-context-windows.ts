// Generated from Cursor SDK checkpoint tokenDetails.maxTokens on 2026-08-18.
// Refresh with: npm run refresh:cursor-snapshots -- --write --context-windows ~/.pi/agent/cursor-sdk-context-windows.json
// Keys are current selectable model IDs. Equivalent default :fast/:slow selections
// collapse to one key; stale and ambiguous aliases are omitted. Values are observed
// or conservative default/non-Max-mode limits and may override a catalog context
// label when the completed SDK checkpoint reports a different effective limit.
export const BUNDLED_CONTEXT_WINDOWS = {
	"default": 200000,
	"auto-smart": 200000,
	"claude-fable-5@300k": 300000,
	"claude-haiku-4-5": 200000,
	"claude-opus-4-5": 200000,
	"claude-opus-4-8@1m": 300000,
	"composer-2": 200000,
	"composer-2.5": 200000,
	"gemini-2.5-flash": 200000,
	"gemini-3-flash": 200000,
	"gemini-3.1-pro": 200000,
	"gemini-3.5-flash": 200000,
	"gemini-3.6-flash": 200000,
	"gemini-3.7-flash": 200000,
	"glm-5.2": 200000,
	"gpt-5-5@272k": 272000,
	"gpt-5-mini": 272000,
	"gpt-5.1": 272000,
	"gpt-5.2": 272000,
	"gpt-5.3-codex": 272000,
	"gpt-5.4-mini": 272000,
	"gpt-5.4-nano": 272000,
	"gpt-5.5@272k": 272000,
	"gpt-5.6@1m": 272000,
	"grok-4.5": 256000,
	"grok-4.5:slow": 256000,
	"grok-4.6": 256000,
	"kimi-k2.7-code": 200000,
	"kimi-k3": 200000,
	"opus-4.8@1m": 300000,
	"opus-4.8@300k": 300000,
} as const satisfies Record<string, number>;
