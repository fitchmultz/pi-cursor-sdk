import ts from "@typescript/typescript6";
import { installedCursorModules } from "./cursor-sdk-installed-modules.js";

// The installed shell-exec module is the only owner of the close-timeout
// warning. Its text is read from the shipped factory, so a reworded template
// fails this contract instead of silently disabling the filter's prefix rule.
const CLOSE_TIMEOUT_HEAD = "[shell-exec] Close event did not fire within ";
// The SDK interpolates its `closeTimeout ?? 5e3` default; the value is not part
// of the filtered prefix, so one representative render covers every emitter.
const TIMEOUT_PLACEHOLDER = "5000";

export interface InstalledShellCloseTimeout {
	/** Shared template head, before the interpolated timeout. */
	head: string;
	/** Distinct complete warnings across every executor that emits them. */
	warnings: string[];
}

export async function installedShellCloseTimeout(): Promise<InstalledShellCloseTimeout> {
	const modules = await installedCursorModules();
	const source = modules.factorySource("../shell-exec/dist/api/index.js");
	const ast = ts.createSourceFile("shell-exec.js", `(${source})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
	const templates: ts.TemplateExpression[] = [];
	(function visit(node: ts.Node) {
		if (ts.isTemplateExpression(node)) templates.push(node);
		ts.forEachChild(node, visit);
	})(ast);
	const render = (template: ts.TemplateExpression) =>
		template.head.text + TIMEOUT_PLACEHOLDER + template.templateSpans.map(span => span.literal.text).join("");

	const heads = templates.filter(template => template.head.text.startsWith(CLOSE_TIMEOUT_HEAD));
	if (heads.length === 0) throw new Error("Installed close-timeout warning template changed or is absent");

	// zsh appends its two suffixes to a base bound in an enclosing block rather
	// than repeating the head, so follow that binding instead of matching text.
	function boundBases(appender: ts.TemplateExpression, name: string) {
		for (let scope: ts.Node | undefined = appender.parent; scope; scope = scope.parent) {
			if (!ts.isBlock(scope) && !ts.isSourceFile(scope) && !ts.isModuleBlock(scope)) continue;
			const bases = scope.statements.flatMap(statement => ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : [])
				.filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === name &&
					declaration.initializer !== undefined && ts.isTemplateExpression(declaration.initializer) &&
					declaration.initializer.head.text.startsWith(CLOSE_TIMEOUT_HEAD))
				.map(declaration => declaration.initializer as ts.TemplateExpression);
			if (bases.length) return bases;
		}
		return [];
	}

	const warnings = [...heads.map(render)];
	for (const appender of templates) {
		if (appender.head.text !== "" || appender.templateSpans.length !== 1) continue;
		const span = appender.templateSpans[0]!;
		if (!ts.isIdentifier(span.expression)) continue;
		for (const base of boundBases(appender, span.expression.text)) warnings.push(render(base) + span.literal.text);
	}
	return { head: heads[0]!.head.text, warnings: [...new Set(warnings)] };
}
