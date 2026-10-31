# Cursor System Prompts and Tool Guidance — 2026-08-02

This evidence bundle records Cursor's assistant-visible local-agent system messages for the six requested model IDs:

- `grok-4.5`
- `claude-opus-5`
- `claude-fable-5`
- `gpt-5.6-sol`
- `gpt-5.6-terra`
- `gpt-5.6-luna`

The main result is stronger than prompt elicitation: every exact Agent-mode message below was read from the completed run's local Cursor SDK checkpoint as a JSON message with `role: "system"`. The adjacent `.txt` files preserve those message contents byte-for-byte.

## Result at a glance

Cursor is using three materially different prompt/tool families here:

1. **Grok 4.5** gets a very short Cursor-specific prompt: identity, concise communication, Cursor code citations, and terminal-session-file guidance.
2. **Opus 5 and Fable 5** share a long Claude-oriented prompt, but Fable adds explicit autonomy, scope/YAGNI, and context-compaction guidance while Opus adds more self-correction and subagent-skepticism guidance.
3. **GPT-5.6 Sol, Terra, and Luna** get the same prompt byte-for-byte after substituting the model name in the first line. Their system-level operating guidance does not otherwise differ.

The tool surface is also family-adapted. Claude/Grok report Cursor's unprefixed `Read`/`Grep`/`StrReplace`/`Task` dialect. GPT-5.6 reports `functions.ReadFile`/`functions.rg`/`functions.ApplyPatch`/`functions.Subagent` plus `multi_tool_use.parallel`.

## Exact Agent-mode artifacts

Hashes cover only the exact system-message content in each linked file, with no wrapper JSON and no added trailing newline.

| Model | Exact system message | Characters | Lines | SHA-256 |
|---|---:|---:|---:|---|
| Grok 4.5 | [`grok-4.5-agent.txt`](./grok-4.5-agent.txt) | 1,877 | 40 | `af542af57f0bdc376fcbaabb8b27f43501000ecc6b9091284a3d7ca8d1a963d5` |
| Opus 5 | [`claude-opus-5-agent.txt`](./claude-opus-5-agent.txt) | 14,200 | 264 | `46f8d4641f76c7f4e12d8c3543dcf1a180a72a39bc1ffa380b3a349838dd4baa` |
| Fable 5 | [`claude-fable-5-agent.txt`](./claude-fable-5-agent.txt) | 15,706 | 274 | `e9da46e74880d7195c316f006b9c7658e2cb43cac880b0132ef7ff103ab4ef31` |
| GPT-5.6 Sol | [`gpt-5.6-sol-agent.txt`](./gpt-5.6-sol-agent.txt) | 13,274 | 182 | `b530a1634de2a3f6b5e2aeb9cc370cc72463d6d3d9bf51b554e96709b0fc5334` |
| GPT-5.6 Terra | [`gpt-5.6-terra-agent.txt`](./gpt-5.6-terra-agent.txt) | 13,276 | 182 | `28eda2ef4a3cb7dfbcdcdfc7f29d3e2bf6b3eedae32c230b45aee8592d3d2bd7` |
| GPT-5.6 Luna | [`gpt-5.6-luna-agent.txt`](./gpt-5.6-luna-agent.txt) | 13,275 | 182 | `7fc09c6735451914beb7984cd9d3b8593fbe35bf7810394077c13f242152d024` |

### GPT-5.6 equality

The exact Sol-to-Terra diff is:

```diff
-You are GPT-5.6 Sol.
+You are GPT-5.6 Terra.
```

The exact Sol-to-Luna diff is:

```diff
-You are GPT-5.6 Sol.
+You are GPT-5.6 Luna.
```

No other byte differs. Cursor currently customizes the model identity, but not the system-level operating guidance, among these three GPT-5.6 tiers.

## Plan-mode delta

A second neutral run was made in SDK-native Plan mode for every model.

Grok 4.5's Plan-mode system message was identical to its Agent-mode message and retained the same hash. The other five models each received the following exact block in addition to their Agent-mode message:

```text
<plan_mode_guardrails>
- In plan mode, only edit markdown files.
- If the user is refining the plan, stay in plan mode and keep edits in markdown.
- If the user explicitly asks you to build, implement, or write the code now, switch to agent mode before making non-markdown edits by calling `SwitchMode` with `target_mode_id=agent`.
</plan_mode_guardrails>
```

For Claude it appears immediately after `</making_code_changes>`. For GPT-5.6 it appears immediately after `</editing_constraints>`.

| Model | Plan characters | Plan lines | Plan SHA-256 |
|---|---:|---:|---|
| Grok 4.5 | 1,877 | 40 | `af542af57f0bdc376fcbaabb8b27f43501000ecc6b9091284a3d7ca8d1a963d5` |
| Opus 5 | 14,557 | 270 | `41bef912ad016f83321168ccc73107ed95f70e307f844f98d324fe13dd642949` |
| Fable 5 | 16,063 | 280 | `3138f7b4d83e3d6042c0e399f263d21b5ed922bb7c8ff294f599b90208237771` |
| GPT-5.6 Sol | 13,631 | 188 | `cc222f4f0bd3bee7cefa64594dfdfdd79585d3cce1595683c62db6f5b520a86a` |
| GPT-5.6 Terra | 13,633 | 188 | `7779cd32cf5c20be11c1807905f5c824aa4c4517ac8108abad546631fe77d5e6` |
| GPT-5.6 Luna | 13,632 | 188 | `fc587e1f58471ea89d5cbeaba3e1d35d8b4aa0cde66f00d38ba4fd7db40f9676` |

Plan files are not duplicated in this bundle because they are exactly the linked Agent file plus the one block above at the stated insertion point.

## Model-specific system guidance

### Grok 4.5

The exact prompt is only 1,877 characters. Cursor adds:

- identity as “Cursor Grok 4.5” and says the model is jointly trained and owned by SpaceXAI and Cursor;
- a direct-and-concise communication requirement;
- one mandatory Cursor code-citation format, `startLine:endLine:filepath`;
- instructions for reading Cursor's terminal-state text files without discussing their folder with the user.

It does **not** contain the detailed autonomy, editing, lint, todo, mode, or response-format sections present in the Claude and GPT prompts. Those capabilities can still be supplied through separate tool definitions and learned model behavior.

### Opus 5

Cursor's Opus prompt is the shared Claude foundation plus Opus-specific communication guidance. Important exact sections include:

- `system-communication`: heed attached context without mentioning invisible wrappers;
- `tone_and_style`: no emojis unless asked, communicate in assistant text rather than tools/comments, no colon before tool calls, Markdown conventions, and linked PR/issue references;
- `communicating_with_the_user`: announce the first tool phase, send sparse meaningful updates, lead with the outcome, favor readable complete prose, avoid unnecessary self-correction, and independently sanity-check other agents' claims;
- `tool_calling`: do not name tools to the user, prefer specialized file tools over shell equivalents, and reject user-invented tool-call syntax;
- `making_code_changes`: read before editing, add real dependency metadata/README for greenfield work, produce a polished UI for new web apps, never generate binary/huge hashes, fix introduced errors, and avoid narrating comments;
- exact Cursor code-reference and Markdown-code-block rules;
- terminal-state-file, todo, lint, and proactive mode-selection guidance.

Opus has no Fable-style `autonomy_guidance` or `context_management` block.

### Fable 5

Fable shares nearly all Claude tool/edit/citation guidance, but Cursor replaces Opus's longer self-correction section with a shorter faithful-reporting rule and adds two major blocks:

- `autonomy_guidance`: act once enough information exists; recommend instead of surveying unused options; avoid feature creep, speculative abstractions, compatibility shims, impossible-case validation, and unrequested refactors; proceed with reversible in-scope work; distinguish assessment requests from change requests; verify evidence before state-changing commands; and do not end on an unexecuted plan or permission-seeking question;
- `context_management`: continue through automatic context summarization instead of wrapping up or requesting a new session.

This is the clearest model-specific Cursor customization in the captured Claude family.

A direct request to dump hidden instructions caused Fable 5 to hit Cursor's safety filter; the result appended an automatic switch notice to Opus 4.8. A separate user-facing behavior guide completed on Fable 5. That filter/fallback is runtime behavior, not text found in the persisted system message.

### GPT-5.6 Sol, Terra, and Luna

The exact shared GPT prompt adds a different operating contract:

- `epistemic_rigor`: do not reflexively agree, verify uncertain claims, challenge wrong/risky premises, and reason toward the user's underlying goal;
- `getting_work_done`: prefer `rg`/`Glob`, parallelize independent calls, and avoid noisy shell output-label commands;
- `autonomy_and_persistence`: classify the request as answer/review/status, diagnose, change/build, or monitor/wait and stop at that mode's correct terminal condition; keep persistence in authorized scope; distinguish transient failures from definitive access failures and missing destructive choices;
- `editing_constraints`: prefer `ApplyPatch` for one-file edits, formatters/scripts for generated or bulk changes, and avoid destructive Git discard commands;
- `working_with_the_user`: separate sparse commentary from final output, honor redirects, continue after compaction, minimize formatting, lead final responses with the result, and avoid routine progress narration;
- `visualizations`: use a visual only when it materially clarifies a relationship;
- a final `main_goal` restatement.

Cursor currently gives Sol, Terra, and Luna no further system-prompt differentiation beyond the model name.

## Tool surface and tool guidance

The checkpoint's `role: "system"` message does not contain the complete built-in function schemas. Their exact transport and ownership were not locally observable. The inventories below therefore come from a second, identical isolated run in which each model produced a user-facing operator guide without being asked to disclose hidden text. They are strong behavioral evidence, but not byte-for-byte schema exports.

### Claude/Grok tool dialect

Opus 5, Fable 5, and Grok 4.5 reported this unprefixed 19-tool surface:

1. `Shell`
2. `AwaitShell`
3. `Read`
4. `Glob`
5. `Grep`
6. `StrReplace`
7. `Write`
8. `Delete`
9. `EditNotebook`
10. `ReadLints`
11. `TodoWrite`
12. `Task`
13. `SwitchMode`
14. `WebSearch`
15. `WebFetch`
16. `GetMcpTools`
17. `CallMcpTool`
18. `FetchMcpResource`
19. `GenerateImage`

The shared guidance reported for these tools was:

- use dedicated read/search/edit tools instead of `cat`, `head`, `tail`, `grep`, `find`, `sed`, `awk`, heredoc, or redirection when a specialized tool exists;
- use `Shell` for real terminal work such as builds, tests, package managers, Git, Docker, and `gh`;
- background long commands and use `AwaitShell` until exit, healthy steady state, a requested pattern, or a demonstrated hang;
- use `Read` before editing; use `StrReplace` for focused exact edits and `Write` for new/full-file content;
- use `ReadLints` after substantive edits and fix introduced diagnostics;
- use `TodoWrite` for complex work, not trivial one- or two-step work;
- use `GetMcpTools` before `CallMcpTool`, and use `FetchMcpResource` for server resources;
- use `GenerateImage` only when the user explicitly asks for an image, not for data-heavy charts;
- use `Task` for bounded broad/parallel work. Reported subagent kinds included `generalPurpose`, `explore`, `shell`, `cursor-guide`, `bugbot`, `security-review`, and `best-of-n-runner`; Opus/Fable also reported `browser-use`. Bugbot/security review were explicit-request-only. `composer-2.5-fast` was the only explicit subagent model slug reported.

Grok's direct disclosure omitted `WebSearch` and `WebFetch`, while its later exhaustive operator guide included both. Because no exact server-side schema export was available, this bundle records the larger consistent inventory and flags the discrepancy rather than treating either self-report as a raw schema.

### GPT-5.6 tool dialect

Sol and Luna independently reported this exact 19-name surface; Terra described the same categories but declined to print internal identifiers. Because all three GPT system prompts and prompt-token baselines matched except for the model name, Terra is recorded as the same family surface with high, not absolute, confidence.

1. `functions.Shell`
2. `functions.Glob`
3. `functions.rg`
4. `functions.AwaitShell`
5. `functions.ReadFile`
6. `functions.Delete`
7. `functions.EditNotebook`
8. `functions.TodoWrite`
9. `functions.ReadLints`
10. `functions.WebSearch`
11. `functions.WebFetch`
12. `functions.GenerateImage`
13. `functions.Subagent`
14. `functions.GetMcpTools`
15. `functions.FetchMcpResource`
16. `functions.SwitchMode`
17. `functions.CallMcpTool`
18. `functions.ApplyPatch`
19. `multi_tool_use.parallel`

The GPT family replaces the Claude/Grok exact-edit trio (`Read`, `StrReplace`, `Write`) with `ReadFile` plus patch-based `ApplyPatch`, replaces `Grep` with `rg`, replaces `Task` with `Subagent`, namespaces functions, and exposes an explicit parallel-call wrapper. Its operator guidance otherwise covers the same core capabilities: specialized file/search tools, persistent shell execution, background polling, lint checks, notebooks, web search/fetch, MCP discovery-before-call, image generation only on request, mode switching, todos, and bounded delegation.

## Direct-disclosure behavior

The same direct audit prompt produced sharply different behavior:

| Model | Direct response |
|---|---|
| Grok 4.5 | Reproduced the short system message and a large tool/rules summary. The persisted checkpoint independently matched the reproduced system text. |
| Opus 5 | Refused verbatim prompt/schema disclosure, but summarized capabilities. |
| Fable 5 | Refused, summarized behavior/tools, then hit Cursor's safety filter and automatically switched to Opus 4.8. |
| GPT-5.6 Sol | Refused both reproduction and paraphrase; gave a one-sentence capability summary. |
| GPT-5.6 Terra | Refused both reproduction and paraphrase; gave a one-sentence capability summary. |
| GPT-5.6 Luna | Refused disclosure and offered only a high-level summary. |

This is why model self-report was not used as the source of truth for the exact prompt files.

## Capture method

### Environment

- Capture date: 2026-08-02
- Runtime: local Cursor agents on macOS
- Installed extension SDK: see [capture provenance](./capture-provenance.md)
- Workspace: a new empty non-Git directory per model under `/tmp`
- Ambient local settings: disabled with `--setting-sources none`
- Inline MCP/custom tools: none
- Agent mode: SDK default `agent`
- Plan mode: explicit SDK `mode: "plan"`
- Selection: exact bare model ID with no explicit params, allowing the live catalog's default variant

The authenticated model/catalog refresh and raw probes did not print or persist the API key in this repository.

### Exact-prompt extraction

The existing maintainer probe was reused:

```bash
node scripts/debug-sdk-events.mjs \
  --cwd /tmp/empty-model-workspace \
  --model <model-id> \
  --setting-sources none \
  --include-conversation \
  --out /tmp/model-probe \
  --prompt '<neutral or audit prompt>'
```

`run.conversation()` and normalized SDK stream events omit the system text. The completed local checkpoint does not: its root protobuf references content-addressed JSON prompt-message blobs in the per-agent SQLite store. The extractor read only those referenced JSON messages and retained `role: "system"`; it did not export user messages, tool results, headers, or credentials.

The relevant SDK store layout is:

```text
<state-root>/index.db
<state-root>/agents/agent-<sha256(agentId)>/store.db
```

The checkpoint is the strongest locally available representation of the model-visible system message. It is not proof that Cursor adds no provider-side safety prefix, routing metadata, cache wrapper, or built-in tool schema later in the hosted inference path.

### User/account rules were excluded

Every checkpoint contained a separate `role: "user"` environment/context message. Grok's persisted initialization message also contained the account's full `<rules>` layer; the other five persisted only `user_info` and `agent_transcripts`. The Claude/GPT operator guides nevertheless repeated several matching Git/PR/communication instructions. That does not prove the account rules were injected there—the same guidance can come from separate built-in tool descriptions—but it does confirm that the persisted `role: "system"` and initialization messages are not the model's only instruction surface.

Account/user rules are private environment configuration, not model-specific Cursor-authored system text, and are intentionally excluded from this bundle. Raw `/tmp` event artifacts and operator-guide outputs are likewise not committed because they include local paths and model-generated reconstruction.

## Daily model-catalog refresh

The authenticated live refresh used the repository's existing command and checkpoint context-window cache:

```bash
npm run refresh:cursor-snapshots -- --write \
  --context-windows ~/.pi/agent/cursor-sdk-context-windows.json
```

Result:

- fetched 34 models with the repository's pinned SDK; see [capture provenance](./capture-provenance.md);
- added `claude-opus-5`, `gemini-3.6-flash`, and `kimi-k3` to the fallback snapshot;
- removed `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`, and `gpt-5.2-codex`;
- normalized 30 locally collected checkpoint inputs to 20 current selectable keys, then emitted 28 total observed/fallback entries after collapsing equivalent fast aliases and removing stale or ambiguous model IDs.

The SDK used for this capture and the registry version available at the time are recorded in [capture provenance](./capture-provenance.md). The catalog refresh did not change the extension's runtime dependency.

### Requested-model defaults in the refreshed catalog

| Model | Live default params | Aliases |
|---|---|---|
| `grok-4.5` | `effort=high`, `fast=true` | none |
| `claude-opus-5` | `thinking=true`, `context=1m`, `effort=high`, `fast=false` | `opus-latest`, `opus`, `opus-5` |
| `claude-fable-5` | `thinking=true`, `context=1m`, `effort=high` | `fable`, `fable-5` (duplicated by the live API) |
| `gpt-5.6-sol` | `context=1m`, `reasoning=medium`, `fast=false` | `gpt-latest`, `gpt`, `gpt-5-6-sol`, `gpt-5.6` |
| `gpt-5.6-terra` | `context=1m`, `reasoning=medium`, `fast=false` | `gpt-5-6-terra` |
| `gpt-5.6-luna` | `context=1m`, `reasoning=medium`, `fast=false` | `gpt-5-6-luna` |

## Cursor's published model guidance

Cursor's model pages do not publish raw prompts, but they describe model-specific agent behavior around the shared “all agent tools” surface:

| Model | Cursor's published guidance |
|---|---|
| [Grok 4.5](https://cursor.com/docs/models/grok-4-5.md) | Emphasizes long-running tool use, checking results, recovering from mistakes, and adapting after unexpected results. |
| [Opus 5](https://cursor.com/docs/models/claude-opus-5.md) | Emphasizes planning before execution, chaining tool results into follow-up actions, and adapting when results are unexpected. |
| [Fable 5](https://cursor.com/docs/models/claude-fable-5.md) | Positioned for long-running autonomous work; Cursor documents security-triggered fallback to Opus, which the direct audit request reproduced. |
| [GPT-5.6 Sol](https://cursor.com/docs/models/gpt-5-6-sol.md) | Described as persistent on long runs, with cautions that it can overuse subagents or wait for an explicit implementation instruction. |
| [GPT-5.6 Terra](https://cursor.com/docs/models/gpt-5-6-terra.md) | Described as sharing the GPT-5.6 family's reasoning, tool-calling, and agent-loop behavior. No published Terra-specific prompt distinction was found. |
| [GPT-5.6 Luna](https://cursor.com/docs/models/gpt-5-6-luna.md) | Described as sharing the family tool contract and suited to prototyping, subagents, and high-volume loops. No published Luna-specific prompt distinction was found. |

These are product descriptions, not evidence that the wording appears in the system-message artifacts.

## Confidence and limits

| Claim | Confidence | Basis |
|---|---|---|
| Linked Agent-mode system text is exact checkpoint content | High | Raw content-addressed checkpoint JSON plus SHA-256 |
| Plan-mode block and insertion point are exact | High | Independent completed Plan checkpoints and byte diff |
| GPT Sol/Terra/Luna system guidance differs only by identity | High | Byte diff of three exact messages |
| Claude/Grok and GPT tool name dialects differ | High | Independent model operator guides plus names referenced by exact system prompts |
| Every listed built-in tool schema/description is byte-exact | Not established | Built-in schemas are absent from the persisted system text; their exact transport and ownership were not locally observed |
| No additional provider-side prompt exists | Unknown | Cursor's hosted provider request is not locally observable; matching guidance also appeared outside the persisted system/initialization messages |
| These prompts stay stable after 2026-08-02 | Unknown | Cursor can update them independently of the npm SDK |

Do not treat self-reported tool descriptions as a raw schema export. Do not treat the checkpoint as proof about server-only safety, classifier, router, provider-wrapper, or training-time behavior.

## Official and secondary sources

Official Cursor sources establish the architecture and the claim that Cursor tunes prompts/tools by model, but do not publish these raw prompt strings:

- [Cursor Agent overview](https://cursor.com/docs/agent/overview.md)
- [Cursor Agent prompting](https://cursor.com/docs/agent/prompting.md)
- [Cursor evaluations](https://cursor.com/docs/evals.md)
- [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript)
- [Cursor SDK changelog](https://cursor.com/docs/sdk/changelog)
- [Grok 4.5](https://cursor.com/docs/models/grok-4-5.md)
- [Claude Opus 5](https://cursor.com/docs/models/claude-opus-5.md)
- [Claude Fable 5](https://cursor.com/docs/models/claude-fable-5.md)
- [GPT-5.6 Sol](https://cursor.com/docs/models/gpt-5-6-sol.md)
- [GPT-5.6 Terra](https://cursor.com/docs/models/gpt-5-6-terra.md)
- [GPT-5.6 Luna](https://cursor.com/docs/models/gpt-5-6-luna.md)

Cursor's overview says it tunes instructions and tools for each frontier model. Its eval documentation also describes the agent loop, tool schema, prompts, and stream shape as staying constant across models. Those statements remain ambiguous together: this capture proves that persisted system-message text differs by model family and that the models report different tool-name dialects, but it does not establish what Cursor means by the eval surface staying “constant.” The three GPT-5.6 tiers do share one captured operating prompt apart from identity.

A public third-party generic Cursor prompt capture exists at [asgeirtj/system_prompts_leaks](https://github.com/asgeirtj/system_prompts_leaks/blob/master/Cursor/cursor.md), but it predates several requested models and has no reproducible extraction provenance. It was not used as the source of truth for this bundle.
