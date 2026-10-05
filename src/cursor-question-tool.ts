import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { arePiToolsDisabled } from "./cursor-active-tools.js";
import { parseEnvBoolean } from "./cursor-env-boolean.js";
import { isCursorModel } from "./cursor-model.js";
import { registerCursorModelLifecycle, type CursorModelLifecycleExtensionApi } from "./cursor-model-lifecycle.js";
import { resolveCursorPiToolBridgeEnabled } from "./cursor-pi-tool-bridge-env.js";

export const CURSOR_ASK_QUESTION_TOOL_NAME = "cursor_ask_question";
export const CURSOR_ASK_QUESTION_ENV = "PI_CURSOR_ASK_QUESTION";

export function resolveCursorAskQuestionEnabled(env: Record<string, string | undefined> = process.env): boolean {
	return parseEnvBoolean(env[CURSOR_ASK_QUESTION_ENV], true);
}

/** Package-namespaced event while `cursor_ask_question` awaits pi UI input. */
export const CURSOR_ASK_QUESTION_BLOCKED_EVENT = "pi-cursor-sdk:ask-question:blocked";

export interface CursorAskQuestionBlockedEventPayload {
	active: boolean;
}

interface CursorQuestionOption {
	label: string;
	value: string;
	description?: string;
}

interface CursorQuestion {
	id: string;
	question: string;
	options: CursorQuestionOption[];
	allowCustom: boolean;
}

interface CursorQuestionAnswer {
	id: string;
	question: string;
	answer: string | null;
	value?: string;
	wasCustom: boolean;
	cancelled: boolean;
}

interface CursorQuestionDetails {
	questions: CursorQuestion[];
	answers: CursorQuestionAnswer[];
	uiAvailable: boolean;
	cancelled: boolean;
}

interface CursorQuestionToolExtensionApi
	extends Pick<ExtensionAPI, "getActiveTools" | "registerTool" | "setActiveTools" | "events">,
		CursorModelLifecycleExtensionApi {}

type RawQuestionOption = string | { label?: string; value?: string; description?: string };

type RawQuestion = {
	id?: string;
	question?: string;
	prompt?: string;
	options?: RawQuestionOption[];
	choices?: RawQuestionOption[];
	allowCustom?: boolean;
};

type CursorAskQuestionParams = RawQuestion & {
	questions?: RawQuestion[];
};

const QuestionOptionSchema = Type.Union([
	Type.String(),
	Type.Object({
		label: Type.String({ description: "User-facing option label" }),
		value: Type.Optional(Type.String({ description: "Optional value returned to Cursor; defaults to label" })),
		description: Type.Optional(Type.String({ description: "Optional helper text shown by compatible pi UIs" })),
	}),
]);

const QuestionSchema = Type.Object({
	id: Type.Optional(Type.String({ description: "Stable question identifier" })),
	question: Type.Optional(Type.String({ description: "Question to ask the user" })),
	prompt: Type.Optional(Type.String({ description: "Alias for question" })),
	options: Type.Optional(Type.Array(QuestionOptionSchema, { description: "Choices the user can select" })),
	choices: Type.Optional(Type.Array(QuestionOptionSchema, { description: "Alias for options" })),
	allowCustom: Type.Optional(Type.Boolean({ description: "Allow a typed answer in addition to listed options; defaults to true" })),
});

const CursorAskQuestionParamsSchema = Type.Object({
	question: Type.Optional(Type.String({ description: "Question to ask the user" })),
	prompt: Type.Optional(Type.String({ description: "Alias for question" })),
	options: Type.Optional(Type.Array(QuestionOptionSchema, { description: "Choices the user can select" })),
	choices: Type.Optional(Type.Array(QuestionOptionSchema, { description: "Alias for options" })),
	allowCustom: Type.Optional(Type.Boolean({ description: "Allow a typed answer in addition to listed options; defaults to true" })),
	questions: Type.Optional(Type.Array(QuestionSchema, { description: "Ask multiple questions sequentially" })),
});

function normalizeOption(option: RawQuestionOption, index: number): CursorQuestionOption | undefined {
	if (typeof option === "string") {
		const trimmed = option.trim();
		return trimmed ? { label: trimmed, value: trimmed } : undefined;
	}
	const label = option.label?.trim() || option.value?.trim() || `Option ${index + 1}`;
	return {
		label,
		value: option.value?.trim() || label,
		...(option.description?.trim() ? { description: option.description.trim() } : {}),
	};
}

function normalizeOptions(options: RawQuestionOption[] | undefined): CursorQuestionOption[] {
	return (options ?? []).map(normalizeOption).filter((option): option is CursorQuestionOption => option !== undefined);
}

function normalizeQuestion(raw: RawQuestion, index: number): CursorQuestion | undefined {
	const question = raw.question?.trim() || raw.prompt?.trim();
	if (!question) return undefined;
	return {
		id: raw.id?.trim() || `question_${index + 1}`,
		question,
		options: normalizeOptions(raw.options ?? raw.choices),
		allowCustom: raw.allowCustom !== false,
	};
}

function normalizeQuestions(params: CursorAskQuestionParams): CursorQuestion[] {
	const rawQuestions = Array.isArray(params.questions) && params.questions.length > 0 ? params.questions : [params];
	return rawQuestions.map(normalizeQuestion).filter((question): question is CursorQuestion => question !== undefined);
}

function summarizeAnswers(answers: CursorQuestionAnswer[]): string {
	if (answers.length === 0) return "No answer was collected.";
	if (answers.length === 1) {
		const [answer] = answers;
		return answer.cancelled || answer.answer === null ? "User cancelled the question." : `User answered: ${answer.answer}`;
	}
	return [
		"User answered:",
		...answers.map((answer) => {
			const value = answer.cancelled || answer.answer === null ? "cancelled" : answer.answer;
			return `- ${answer.id}: ${value}`;
		}),
	].join("\n");
}

function buildDetails(questions: CursorQuestion[], answers: CursorQuestionAnswer[], uiAvailable: boolean): CursorQuestionDetails {
	return {
		questions,
		answers,
		uiAvailable,
		cancelled: answers.some((answer) => answer.cancelled),
	};
}

async function askOneQuestion(question: CursorQuestion, ctx: { ui: ExtensionContext["ui"] }): Promise<CursorQuestionAnswer> {
	if (question.options.length > 0) {
		const labels = question.options.map((option) => option.description ? `${option.label} — ${option.description}` : option.label);
		const customLabel = "Type a custom answer";
		const choices = question.allowCustom ? [...labels, customLabel] : labels;
		const selected = await ctx.ui.select(question.question, choices);
		if (!selected) {
			return { id: question.id, question: question.question, answer: null, wasCustom: false, cancelled: true };
		}
		if (selected === customLabel) {
			const customAnswer = await ctx.ui.input(question.question, "Type your answer");
			const trimmed = customAnswer?.trim();
			return trimmed
				? { id: question.id, question: question.question, answer: trimmed, value: trimmed, wasCustom: true, cancelled: false }
				: { id: question.id, question: question.question, answer: null, wasCustom: true, cancelled: true };
		}
		const selectedIndex = labels.indexOf(selected);
		const selectedOption = selectedIndex >= 0 ? question.options[selectedIndex] : undefined;
		const answer = selectedOption?.label ?? selected;
		return {
			id: question.id,
			question: question.question,
			answer,
			value: selectedOption?.value ?? answer,
			wasCustom: false,
			cancelled: false,
		};
	}

	const answer = await ctx.ui.input(question.question, "Type your answer");
	const trimmed = answer?.trim();
	return trimmed
		? { id: question.id, question: question.question, answer: trimmed, value: trimmed, wasCustom: true, cancelled: false }
		: { id: question.id, question: question.question, answer: null, wasCustom: true, cancelled: true };
}

function syncCursorQuestionToolForModel(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">, model: ExtensionContext["model"]): void {
	const activeToolNames = new Set(pi.getActiveTools());
	const shouldBeActive = !arePiToolsDisabled(pi) && isCursorModel(model) && resolveCursorPiToolBridgeEnabled();
	const alreadyActive = activeToolNames.has(CURSOR_ASK_QUESTION_TOOL_NAME);
	if (shouldBeActive === alreadyActive) return;
	if (shouldBeActive) {
		activeToolNames.add(CURSOR_ASK_QUESTION_TOOL_NAME);
	} else {
		activeToolNames.delete(CURSOR_ASK_QUESTION_TOOL_NAME);
	}
	pi.setActiveTools([...activeToolNames]);
}

function emitCursorAskQuestionBlockedEvent(
	pi: Pick<ExtensionAPI, "events">,
	payload: CursorAskQuestionBlockedEventPayload,
): void {
	pi.events.emit(CURSOR_ASK_QUESTION_BLOCKED_EVENT, payload);
}

export function registerCursorQuestionTool(pi: CursorQuestionToolExtensionApi): void {
	if (!resolveCursorAskQuestionEnabled()) return;

	pi.registerTool({
		name: CURSOR_ASK_QUESTION_TOOL_NAME,
		label: "Cursor question",
		description:
			"Ask the user a clarifying question from Cursor. Use when user preferences materially affect the next step; provide options when possible.",
		promptSnippet: "Ask the user a clarifying question through pi UI when material choices affect Cursor's next step",
		executionMode: "sequential",
		parameters: CursorAskQuestionParamsSchema,
		promptGuidelines: [
			"Use cursor_ask_question only when running a Cursor model and user input would materially change the plan, scope, platform, or implementation path.",
			"Prefer cursor_ask_question with 2-4 concrete options instead of guessing when Cursor plan mode needs user choices.",
		],
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const questions = normalizeQuestions(params as CursorAskQuestionParams);
			if (questions.length === 0) {
				throw new Error("No valid question was provided.");
			}
			if (!ctx.hasUI) {
				throw new Error(
					"Cannot ask the user because pi UI is unavailable. Make a reasonable default choice and state the assumption before proceeding.",
				);
			}

			// Emit a package-namespaced blocked signal while the questionnaire
			// awaits input so consumers (e.g. Herdr) can map it to blocked/working.
			emitCursorAskQuestionBlockedEvent(pi, { active: true });
			try {
				const answers: CursorQuestionAnswer[] = [];
				for (const question of questions) {
					const answer = await askOneQuestion(question, ctx);
					answers.push(answer);
					if (answer.cancelled) break;
				}

				return {
					content: [{ type: "text" as const, text: summarizeAnswers(answers) }],
					details: buildDetails(questions, answers, true),
				};
			} finally {
				emitCursorAskQuestionBlockedEvent(pi, { active: false });
			}
		},
		renderCall(args, theme) {
			const questions = normalizeQuestions(args as CursorAskQuestionParams);
			const label = questions[0]?.question ?? "Ask the user";
			return new Text(theme.fg("toolTitle", theme.bold("cursor question ")) + theme.fg("muted", label), 0, 0);
		},
	});

	registerCursorModelLifecycle(pi, (ctx) => {
		syncCursorQuestionToolForModel(pi, ctx.model);
	});
}
