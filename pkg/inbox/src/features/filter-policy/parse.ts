export type SieveHeaderStyle =
	| "extension-requires"
	| "email-organizer"
	| "plain";

export type ParsedSieve = {
	style: SieveHeaderStyle;
	requires: string[];
	comments: string[];
	fileinto: string[];
	plusTags: string[];
	dotTags: string[];
	domains: string[];
	truncated: boolean;
	unreadable: boolean;
};

export type SieveArg =
	| { type: "tag"; name: string }
	| { type: "string"; values: string[]; isList: boolean }
	| { type: "number" };

export type SieveTest = {
	name: string;
	args: SieveArg[];
	tests: SieveTest[];
};

export type SieveCommand = {
	name: string;
	args: SieveArg[];
	test?: SieveTest;
	block?: SieveCommand[];
};

type Token =
	| { kind: "string" | "tag" | "word" | "number" | "punct" | "other"; value: string };

const redactionPattern = /\[(?:email|number|phone)(?::|\])/i;
const closers: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
const closing = Object.values(closers);
const fileintoTags = ["copy", "create", "flags"];
const addressPattern =
	/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function parseSieve(sieve: string): ParsedSieve {
	const requires = readRequires(sieve);
	const comments = readComments(sieve);
	const commands = parseCommands(sieve);
	const fileintoCommands = commands
		? flattenCommands(commands).filter((command) => command.name === "fileinto")
		: [];
	const destinations = fileintoCommands.map(fileintoDestination);
	const fileinto = unique(
		destinations.filter((path): path is string => path !== undefined),
	);
	const { plusTags, dotTags } = readTags(sieve);
	const domains = unique(
		[...sieve.matchAll(addressPattern)].map((match) =>
			match[0].split("@")[1]!.toLowerCase(),
		),
	);
	const style = headerStyle(requires, comments);
	return {
		style,
		requires,
		comments,
		fileinto,
		plusTags,
		dotTags,
		domains,
		truncated: sieveLooksTruncated(sieve),
		unreadable: !commands || destinations.includes(undefined),
	};
}

export function sieveLooksTruncated(sieve: string): boolean {
	const text = sieve.trim();
	if (!text) return true;
	if (redactionPattern.test(text)) return true;
	const { tokens, complete } = tokenize(sieve);
	if (!complete || !delimitersBalanced(tokens)) return true;
	const last = tokens.at(-1);
	return !(last?.kind === "punct" && (last.value === ";" || last.value === "}"));
}

function delimitersBalanced(tokens: Token[]): boolean {
	const expected: string[] = [];
	for (const token of tokens) {
		if (token.kind !== "punct") continue;
		const closer = closers[token.value];
		if (closer) expected.push(closer);
		else if (closing.includes(token.value) && expected.pop() !== token.value) {
			return false;
		}
	}
	return expected.length === 0;
}

function tokenize(src: string): { tokens: Token[]; complete: boolean } {
	const tokens: Token[] = [];
	let i = 0;
	while (i < src.length) {
		const ch = src[i] ?? "";
		if (/\s/.test(ch)) {
			i += 1;
		} else if (ch === "#") {
			const end = src.indexOf("\n", i);
			i = end === -1 ? src.length : end + 1;
		} else if (src.startsWith("/*", i)) {
			const end = src.indexOf("*/", i + 2);
			if (end === -1) return { tokens, complete: false };
			i = end + 2;
		} else if (ch === '"') {
			let value = "";
			i += 1;
			while (src[i] !== '"') {
				if (i >= src.length) return { tokens, complete: false };
				if (src[i] === "\\") i += 1;
				if (i >= src.length) return { tokens, complete: false };
				value += src[i];
				i += 1;
			}
			i += 1;
			tokens.push({ kind: "string", value });
		} else if (ch === ":" && /[A-Za-z_]/.test(src[i + 1] ?? "")) {
			const name = /^[A-Za-z0-9_]+/.exec(src.slice(i + 1))?.[0] ?? "";
			tokens.push({ kind: "tag", value: name.toLowerCase() });
			i += 1 + name.length;
		} else if (/[A-Za-z_]/.test(ch)) {
			const name = /^[A-Za-z0-9_]+/.exec(src.slice(i))?.[0] ?? "";
			i += name.length;
			if (name.toLowerCase() === "text" && src[i] === ":") {
				const lineEnd = src.indexOf("\n", i);
				const body = lineEnd === -1 ? undefined : src.slice(lineEnd + 1);
				const close = body === undefined ? null : /^\.[ \t]*\r?$/m.exec(body);
				if (body === undefined || !close) return { tokens, complete: false };
				tokens.push({ kind: "string", value: body.slice(0, close.index) });
				i = lineEnd + 1 + close.index + close[0].length;
			} else {
				tokens.push({ kind: "word", value: name });
			}
		} else if (/[0-9]/.test(ch)) {
			const digits = /^[0-9]+[KMGkmg]?/.exec(src.slice(i))?.[0] ?? ch;
			tokens.push({ kind: "number", value: digits });
			i += digits.length;
		} else {
			tokens.push({
				kind: "{}()[],;".includes(ch) ? "punct" : "other",
				value: ch,
			});
			i += 1;
		}
	}
	return { tokens, complete: true };
}

class SieveSyntaxError extends Error {}

export function parseCommands(sieve: string): SieveCommand[] | undefined {
	const { tokens, complete } = tokenize(sieve);
	if (!complete) return undefined;
	let pos = 0;
	const isPunct = (value: string): boolean => {
		const token = tokens[pos];
		return token?.kind === "punct" && token.value === value;
	};
	const expectPunct = (value: string): void => {
		if (!isPunct(value)) throw new SieveSyntaxError();
		pos += 1;
	};
	const word = (): string => {
		const token = tokens[pos];
		if (token?.kind !== "word") throw new SieveSyntaxError();
		pos += 1;
		return token.value.toLowerCase();
	};
	const stringList = (): SieveArg => {
		const values: string[] = [];
		for (;;) {
			const token = tokens[pos];
			if (token?.kind !== "string") throw new SieveSyntaxError();
			values.push(token.value);
			pos += 1;
			if (!isPunct(",")) break;
			pos += 1;
		}
		expectPunct("]");
		return { type: "string", values, isList: true };
	};
	const args = (): SieveArg[] => {
		const out: SieveArg[] = [];
		for (;;) {
			const token = tokens[pos];
			if (token?.kind === "tag") {
				out.push({ type: "tag", name: token.value });
			} else if (token?.kind === "number") {
				out.push({ type: "number" });
			} else if (token?.kind === "string") {
				out.push({ type: "string", values: [token.value], isList: false });
			} else if (isPunct("[")) {
				pos += 1;
				out.push(stringList());
				continue;
			} else {
				return out;
			}
			pos += 1;
		}
	};
	const test = (): SieveTest => {
		const name = word();
		if (name === "not") return { name, args: [], tests: [test()] };
		if (name !== "allof" && name !== "anyof") {
			return { name, args: args(), tests: [] };
		}
		expectPunct("(");
		const tests = [test()];
		while (isPunct(",")) {
			pos += 1;
			tests.push(test());
		}
		expectPunct(")");
		return { name, args: [], tests };
	};
	const block = (): SieveCommand[] => {
		expectPunct("{");
		const commands: SieveCommand[] = [];
		while (!isPunct("}")) commands.push(command());
		pos += 1;
		return commands;
	};
	const command = (): SieveCommand => {
		const name = word();
		if (name === "if" || name === "elsif") {
			return { name, args: [], test: test(), block: block() };
		}
		if (name === "else") return { name, args: [], block: block() };
		const commandArgs = args();
		if (isPunct("{")) return { name, args: commandArgs, block: block() };
		expectPunct(";");
		return { name, args: commandArgs };
	};
	try {
		const commands: SieveCommand[] = [];
		while (pos < tokens.length) commands.push(command());
		return commands;
	} catch (error) {
		if (error instanceof SieveSyntaxError) return undefined;
		throw error;
	}
}

export function flattenCommands(commands: SieveCommand[]): SieveCommand[] {
	return commands.flatMap((command) => [
		command,
		...flattenCommands(command.block ?? []),
	]);
}

export function fileintoDestination(command: SieveCommand): string | undefined {
	const tags = command.args.flatMap((arg) =>
		arg.type === "tag" ? [arg.name] : [],
	);
	if (tags.some((name) => !fileintoTags.includes(name))) return undefined;
	const strings = command.args.filter((arg) => arg.type === "string");
	const flags = tags.filter((name) => name === "flags").length;
	const target = command.args.at(-1);
	if (strings.length !== 1 + flags) return undefined;
	if (target?.type !== "string" || target.isList) return undefined;
	const path = target.values[0] ?? "";
	return path.includes("${") ? undefined : path.trim();
}

export function normalizeSieve(sieve: string): string {
	return sieve.replace(/\r\n/g, "\n").trim();
}

export function fullSieveOrThrow(rule: {
	conditions?: string[];
	actions?: string[];
}): string {
	const conditions = rule.conditions ?? [];
	const actions = rule.actions ?? [];
	const fromConditions = conditions[0] ?? "";
	const fromActions = actions[0] ?? "";
	const candidate = /\brequire\b/i.test(fromConditions)
		? fromConditions
		: /\brequire\b/i.test(fromActions)
			? fromActions
			: fromConditions || fromActions;
	if (sieveLooksTruncated(candidate)) {
		throw new Error(
			"Refusing a truncated or redacted filter snapshot. Import from the live Proton filter, not filters.json.",
		);
	}
	return candidate;
}

function headerStyle(
	requires: string[],
	comments: string[],
): SieveHeaderStyle {
	if (comments.some((comment) => /email-organizer/i.test(comment))) {
		return "email-organizer";
	}
	if (
		requires.some((item) => item === "include" || item === "environment")
	) {
		return "extension-requires";
	}
	return "plain";
}

function readRequires(sieve: string): string[] {
	const match = /\brequire\s+(\[[^\]]*\]|"[^"]*")/i.exec(sieve);
	if (!match?.[1]) return [];
	return [...match[1].matchAll(/"((?:\\.|[^"\\])*)"/g)].map((item) =>
		unescape(item[1] ?? ""),
	);
}

function readComments(sieve: string): string[] {
	return sieve
		.split("\n")
		.map((line) => /^\s*#(.*)$/.exec(line)?.[1]?.trim() ?? "")
		.filter(Boolean);
}

function readTags(sieve: string): { plusTags: string[]; dotTags: string[] } {
	const plus = new Set<string>();
	const dot = new Set<string>();
	for (const match of sieve.matchAll(addressPattern)) {
		const local = match[0].split("@")[0] ?? "";
		collectLocal(local, plus, dot);
	}
	for (const match of sieve.matchAll(
		/address\s+:localpart\s+:(?:matches|is)\s+"[^"]+"\s+"([^"]+)"/gi,
	)) {
		collectLocal(match[1] ?? "", plus, dot);
	}
	return {
		plusTags: [...plus],
		dotTags: [...dot],
	};
}

function collectLocal(
	local: string,
	plus: Set<string>,
	dot: Set<string>,
): void {
	const plusMatch = /\+([a-z0-9]+)/i.exec(local);
	if (plusMatch?.[1]) plus.add(plusMatch[1].toLowerCase());
	const dotMatch = /(?:^|\*)\.([a-z0-9]+)$/i.exec(local.replace(/^\*+/, ""));
	if (dotMatch?.[1]) dot.add(dotMatch[1].toLowerCase());
	const dotted = /^[a-z0-9]+\.([a-z0-9]+)$/i.exec(local);
	if (dotted?.[1]) dot.add(dotted[1].toLowerCase());
}

function unescape(value: string): string {
	return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

function unique(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}
