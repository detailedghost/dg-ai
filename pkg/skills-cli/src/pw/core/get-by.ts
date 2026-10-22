const ALLOWED = new Set([
	"page",
	"getByRole",
	"getByText",
	"getByLabel",
	"getByPlaceholder",
	"getByAltText",
	"getByTitle",
	"getByTestId",
	"locator",
	"first",
	"last",
	"nth",
	"filter",
	"and",
	"or",
	"name",
	"exact",
	"hasText",
	"hasNotText",
	"has",
	"hasNot",
	"visible",
	"level",
	"checked",
	"disabled",
	"expanded",
	"includeHidden",
	"pressed",
	"selected",
	"true",
	"false",
	"null",
]);

const PUNCTUATION = new Set([".", "(", ")", ",", ":", "{", "}", "-"]);
const REGEX_PRECEDERS = new Set(["(", ",", ":"]);
const IDENTIFIER = /^[A-Za-z_$][\w$]*/;
const NUMBER = /^\d+(?:\.\d+)?/;
const FLAGS = /^[a-z]*/;

function skipString(source: string, start: number): number {
	const quote = source[start] as string;
	for (let i = start + 1; i < source.length; i++) {
		const char = source[i];
		if (char === "\\") i++;
		else if (quote === "`" && char === "$" && source[i + 1] === "{") return -1;
		else if (char === quote) return i + 1;
		else if (char === "\n" && quote !== "`") return -1;
	}
	return -1;
}

function skipRegex(source: string, start: number): number {
	let inClass = false;
	for (let i = start + 1; i < source.length; i++) {
		const char = source[i];
		if (char === "\n") return -1;
		if (char === "\\") i++;
		else if (char === "[") inClass = true;
		else if (char === "]") inClass = false;
		else if (char === "/" && !inClass) return i + 1 + (FLAGS.exec(source.slice(i + 1))?.[0].length ?? 0);
	}
	return -1;
}

export function assertSafeGetBy(source: string): void {
	const reject = (): never => {
		throw new Error(
			`Unsupported locator expression: ${source.slice(0, 80)}. Use getBy*/locator/first/last/nth/filter only.`,
		);
	};
	let previous = "";
	let i = 0;
	while (i < source.length) {
		const char = source[i] as string;
		if (/\s/.test(char)) {
			i++;
			continue;
		}
		const rest = source.slice(i);
		let next = -1;
		if (char === '"' || char === "'" || char === "`") next = skipString(source, i);
		else if (char === "/" && (previous === "" || REGEX_PRECEDERS.has(previous))) {
			if (source[i + 1] === "/" || source[i + 1] === "*") reject();
			next = skipRegex(source, i);
		} else if (PUNCTUATION.has(char)) next = i + 1;
		else if (NUMBER.test(rest)) next = i + (NUMBER.exec(rest)?.[0].length ?? 0);
		else {
			const identifier = IDENTIFIER.exec(rest)?.[0];
			if (identifier && ALLOWED.has(identifier)) next = i + identifier.length;
		}
		if (next === -1) reject();
		previous = char === '"' || char === "'" || char === "`" || char === "/" ? "x" : char;
		i = next;
	}
}
