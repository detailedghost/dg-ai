import { isAbsolute, resolve } from "node:path";

export type PrAction = "create" | "edit" | "update";

const WRAPPERS = new Set(["sudo", "env", "command", "time", "exec", "nice"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const RESERVED = new Set([
	"if",
	"then",
	"else",
	"elif",
	"do",
	"while",
	"until",
	"!",
	"{",
]);
const ASSIGNMENT = /^[A-Za-z_]\w*=/;
const HEREDOC = /^<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/;

interface Scan {
	end: number;
	inner: string[];
}

function skipHeredoc(
	src: string,
	i: number,
	delimiter: string,
	tabs: boolean,
): number {
	let at = i;
	while (at < src.length) {
		const nl = src.indexOf("\n", at);
		const line = src.slice(at, nl < 0 ? src.length : nl);
		const next = nl < 0 ? src.length : nl + 1;
		if ((tabs ? line.replace(/^\t+/, "") : line) === delimiter) return next;
		at = next;
	}
	return src.length;
}

function substitution(src: string, at: number, inner: string[]): number {
	const backtick = src[at] === "`";
	const start = at + (backtick ? 1 : 2);
	const sub = scan(src, start, backtick ? "`" : ")", false);
	inner.push(src.slice(start, sub.end), ...sub.inner);
	return sub.end + 1;
}

function scanDouble(src: string, i: number, inner: string[]): number {
	let at = i;
	while (at < src.length) {
		const c = src[at]!;
		if (c === "\\") at += 2;
		else if (c === '"') return at + 1;
		else if (c === "`" || (c === "$" && src[at + 1] === "("))
			at = substitution(src, at, inner);
		else at++;
	}
	return src.length;
}

function scan(src: string, i: number, close: string, split: boolean): Scan {
	const inner: string[] = [];
	const heredocs: { delimiter: string; tabs: boolean }[] = [];
	let at = i;
	while (at < src.length) {
		const c = src[at]!;
		if (c === "\\") {
			at += 2;
			continue;
		}
		if (close && c === close) return { end: at, inner };
		if (split && ";&|)".includes(c)) return { end: at, inner };
		if (c === "#" && (at === i || /[\s;&|()]/.test(src[at - 1] ?? " "))) {
			const nl = src.indexOf("\n", at);
			at = nl < 0 ? src.length : nl;
			continue;
		}
		if (c === "\n") {
			if (heredocs.length > 0) {
				let body = at + 1;
				for (const h of heredocs.splice(0))
					body = skipHeredoc(src, body, h.delimiter, h.tabs);
				if (split)
					return { end: body >= src.length ? src.length : body - 1, inner };
				at = body;
				continue;
			}
			if (split) return { end: at, inner };
			at++;
			continue;
		}
		if (c === "'") {
			const end = src.indexOf("'", at + 1);
			at = end < 0 ? src.length : end + 1;
		} else if (c === '"') at = scanDouble(src, at + 1, inner);
		else if ((c === "`" && close !== "`") || (c === "$" && src[at + 1] === "("))
			at = substitution(src, at, inner);
		else if (c === "(" && !split) {
			const sub = scan(src, at + 1, ")", false);
			inner.push(src.slice(at + 1, sub.end), ...sub.inner);
			at = sub.end + 1;
		} else if (c === "<" && src[at + 1] === "<" && src[at + 2] !== "<") {
			const match = HEREDOC.exec(src.slice(at));
			if (match)
				heredocs.push({ delimiter: match[3]!, tabs: match[1] === "-" });
			at += match ? match[0].length : 2;
		} else at++;
	}
	return { end: src.length, inner };
}

/** Splits a shell script into simple-command spans; command substitutions come back as their own scripts. */
export function commandSegments(script: string): {
	segments: string[];
	nested: string[];
} {
	const src = script.replace(/\\\n/g, "");
	const segments: string[] = [];
	const nested: string[] = [];
	let at = 0;
	while (at < src.length) {
		while (at < src.length && /[\s;&|()]/.test(src[at]!)) at++;
		if (at >= src.length) break;
		const part = scan(src, at, "", true);
		segments.push(src.slice(at, part.end));
		nested.push(...part.inner);
		at = part.end + 1;
	}
	return { segments, nested };
}

/** Shell words of one simple command, with quotes and line continuations removed. */
export function shellWords(source: string): string[] {
	const words: string[] = [];
	let current = "";
	let started = false;
	let quote = "";
	for (let i = 0; i < source.length; i++) {
		const c = source[i]!;
		if (quote === "") {
			if (c === "'" || c === '"') {
				quote = c;
				started = true;
			} else if (c === "\\") {
				i++;
				if (source[i] !== "\n") {
					current += source[i] ?? "";
					started = true;
				}
			} else if (c === " " || c === "\t" || c === "\n") {
				if (started) words.push(current);
				current = "";
				started = false;
			} else {
				current += c;
				started = true;
			}
		} else if (c === quote) quote = "";
		else if (
			quote === '"' &&
			c === "\\" &&
			'$`"\\\n'.includes(source[i + 1] ?? "")
		) {
			i++;
			if (source[i] !== "\n") current += source[i] ?? "";
		} else {
			current += c;
			started = true;
		}
	}
	if (started) words.push(current);
	return words;
}

function skipFlags(words: string[], i: number, stop: string): number {
	let at = i;
	while (at < words.length && words[at]!.startsWith("-")) {
		const value = words[at + 1];
		const takesValue =
			/^-[A-Za-z]$|^--(?:repo|hostname)$/.test(words[at]!) &&
			value !== undefined &&
			!value.startsWith("-") &&
			value !== stop;
		at += takesValue ? 2 : 1;
	}
	return at;
}

function commandStart(words: string[]): number {
	let at = 0;
	while (at < words.length) {
		const word = words[at]!;
		if (ASSIGNMENT.test(word) || RESERVED.has(word)) at++;
		else if (WRAPPERS.has(word)) {
			at++;
			while (
				at < words.length &&
				(words[at]!.startsWith("-") || ASSIGNMENT.test(words[at]!))
			)
				at++;
		} else return at;
	}
	return at;
}

function matchesPr(words: string[], actions: readonly PrAction[]): boolean {
	const at = commandStart(words);
	const tool = words[at];
	const noun = tool === "gh" ? "pr" : tool === "glab" ? "mr" : undefined;
	if (!noun) return false;
	const nounAt = skipFlags(words, at + 1, noun);
	if (words[nounAt] !== noun) return false;
	const action = words[skipFlags(words, nounAt + 1, "")];
	return actions.includes(action as PrAction);
}

function shellScript(words: string[]): string | undefined {
	const at = commandStart(words);
	if (!SHELLS.has(words[at]?.split("/").pop() ?? "")) return undefined;
	for (let i = at + 1; i < words.length; i++) {
		const word = words[i]!;
		if (!word.startsWith("-")) return undefined;
		if (/^-[A-Za-z]*c[A-Za-z]*$/.test(word)) return words[i + 1];
	}
	return undefined;
}

export interface PrCall {
	source: string;
	cwd: string | undefined;
}

function changedDir(words: string[], cwd: string | undefined) {
	const at = commandStart(words);
	if (words[at] !== "cd") return cwd;
	const target = words[at + 1];
	if (!target || target === "-" || target.startsWith("~")) return undefined;
	if (isAbsolute(target)) return target;
	return cwd === undefined ? undefined : resolve(cwd, target);
}

/** Every GitHub or GitLab PR CLI call with one of the actions at command position, with the directory a prior cd left. */
export function prInvocations(
	command: string,
	actions: readonly PrAction[],
	cwd?: string,
	depth = 0,
): PrCall[] {
	if (depth > 4) return [];
	const { segments, nested } = commandSegments(command);
	const found: PrCall[] = [];
	let dir = cwd;
	for (const segment of segments) {
		const words = shellWords(segment);
		if (matchesPr(words, actions)) found.push({ source: segment, cwd: dir });
		const inner = shellScript(words);
		if (inner !== undefined)
			found.push(...prInvocations(inner, actions, dir, depth + 1));
		dir = changedDir(words, dir);
	}
	for (const script of nested)
		found.push(...prInvocations(script, actions, dir, depth + 1));
	return found;
}

/** True when a shell command runs the GitHub or GitLab PR CLI with one of the actions at command position. */
export function invokesPrCommand(
	command: string,
	actions: readonly PrAction[],
): boolean {
	return prInvocations(command, actions).length > 0;
}
