import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { bashCommand } from "../io";
import { invokesPrCommand } from "../pr-command";
import type { HookContext, HookHandler } from "../types";

interface Finding {
	line: number;
	message: string;
}

const HEREDOC = /(?<!<)<<(?!<)-?[ \t]*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/;
const BODY_FLAG =
	/--body|(^|[ \t])-b([ \t]|$)|(^|[ \t])-F([ \t]|$)|--description|(^|[ \t])-d([ \t]|$)/;
const VARIABLE_ONLY = /^\$[{(]?[A-Za-z_][A-Za-z0-9_]*[})]?$/;
const FILLER = [
	"comprehensive",
	"seamless",
	"cutting-edge",
	"best-in-class",
	"state-of-the-art",
	"delve",
	"game-chang",
	"revolutioniz",
	"synerg",
	"holistic",
	"effortless",
];
const VALE_HINT =
	"pr-prose: Vale is not installed, so style checks are off. Install it from https://vale.sh to add them. The built-in checks still ran.\n";

const VALE_UNCONFIGURED =
	"pr-prose: Vale is installed but HOOK_PR_PROSE_VALE_CONFIG is not set, so style checks are off. The built-in checks still ran.\n";
const VALE_FAILED =
	"pr-prose: the Vale run failed, so style checks were skipped. The built-in checks still ran.\n";

export function tokenize(source: string): string[] {
	const tokens: string[] = [];
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
				current += source[i] ?? "";
				started = true;
			} else if (c === " " || c === "\t" || c === "\n") {
				if (started) tokens.push(current);
				current = "";
				started = false;
			} else {
				current += c;
				started = true;
			}
		} else if (c === quote) quote = "";
		else if (quote === '"' && c === "\\") {
			i++;
			current += source[i] ?? "";
		} else {
			current += c;
			started = true;
		}
	}
	if (started) tokens.push(current);
	return tokens;
}

function collectHeredocs(lines: string[]) {
	const heredocs: { flagged: boolean; text: string }[] = [];
	for (let i = 0; i < lines.length; i++) {
		const match = HEREDOC.exec(lines[i]!);
		if (!match) continue;
		const opener = lines[i]!.slice(0, match.index);
		const delimiter = match[0].replace(/^<<-?[ \t]*/, "").replace(/['"]/g, "");
		let text = "";
		i++;
		while (i < lines.length && lines[i]!.trim() !== delimiter) {
			text += `${lines[i]}\n`;
			i++;
		}
		heredocs.push({ flagged: BODY_FLAG.test(opener), text });
	}
	return heredocs;
}

function readBodyFile(path: string, cwd: string): string | undefined {
	if (path === "" || path === "-") return undefined;
	try {
		const text = readFileSync(
			isAbsolute(path) ? path : resolve(cwd, path),
			"utf8",
		);
		return text === "" ? undefined : text;
	} catch {
		return undefined;
	}
}

export function extractBody(command: string, cwd: string): string {
	const heredocs = collectHeredocs(command.split("\n"));
	const flagged = heredocs.filter((h) => h.flagged);
	if (flagged.length > 0) return flagged.map((h) => h.text).join("");

	const isLiteral = (v: string) => v !== "" && !VARIABLE_ONLY.test(v);
	const tokens = tokenize(command);
	for (const [i, token] of tokens.entries()) {
		const next = tokens[i + 1];
		if (["--body", "-b", "--description", "-d"].includes(token)) {
			if (next !== undefined && isLiteral(next)) return `${next}\n`;
			continue;
		}
		const inline = /^--(?:body|description)=(.*)$/s.exec(token);
		if (inline) {
			if (isLiteral(inline[1]!)) return `${inline[1]}\n`;
			continue;
		}
		const fileValue = ["--body-file", "-F", "--description-file"].includes(
			token,
		)
			? next
			: /^--(?:body|description)-file=(.*)$/s.exec(token)?.[1];
		if (fileValue !== undefined) {
			const text = readBodyFile(fileValue, cwd);
			if (text !== undefined) return text;
		}
	}
	return heredocs.map((h) => h.text).join("");
}

const wordCount = (text: string) => {
	const trimmed = text.trim();
	return trimmed === "" ? 0 : trimmed.split(/[ \t]+/).length;
};

export function scanBody(body: string, maxSentence: number): Finding[] {
	const minProseWords = 4;
	const minBodyWords = 12;
	const findings: Finding[] = [];
	const add = (line: number, message: string) =>
		findings.push({ line, message });
	let fence = false;
	let totalWords = 0;
	let firstBullet = 0;
	let firstProse = 0;
	let paragraph = "";
	let paragraphLine = 0;

	const flush = () => {
		if (paragraph === "") {
			paragraphLine = 0;
			return;
		}
		for (const sentence of paragraph.split(/[.!?]+[ \t]+/)) {
			const count = wordCount(sentence);
			if (count > maxSentence)
				add(
					paragraphLine,
					`sentence runs ${count} words - split it into shorter ones`,
				);
		}
		const lower = paragraph.toLowerCase();
		for (const word of FILLER)
			if (lower.includes(word))
				add(
					paragraphLine,
					`marketing filler: '${word}' - say what it actually does`,
				);
		paragraph = "";
		paragraphLine = 0;
	};

	for (const [index, raw] of body.replace(/\n+$/, "").split("\n").entries()) {
		const lineNo = index + 1;
		const line = raw.replace(/\r$/, "").trim();
		if (/^(```|~~~)/.test(line)) {
			fence = !fence;
			continue;
		}
		if (fence) {
			totalWords += wordCount(line);
			continue;
		}
		if (line.includes("<!--") && !/^<!-- \/chain:(start|end) -->$/.test(line))
			add(
				lineNo,
				"unexpanded template comment - delete it or replace it with real text",
			);
		if (/(^|[^A-Za-z0-9])(TBD|TODO|FIXME|XXX)([^A-Za-z0-9]|$)/.test(line))
			add(lineNo, "placeholder marker left in the body");
		if (/\{\{|\[describe|\[explain|<placeholder>/.test(line))
			add(lineNo, "unfilled template placeholder");
		if (/(Fixes|Closes|Resolves)[ \t]*#[ \t]*($|[^0-9])/.test(line))
			add(lineNo, "issue reference with no issue number");

		if (line === "") {
			flush();
			continue;
		}
		if (/^[|>]/.test(line)) continue;
		if (line.includes("Generated with [Claude Code]")) continue;
		if (/^Co-[Aa]uthored-[Bb]y:/.test(line)) continue;
		if (/^(https?:\/\/|!\[|\[!\[)/.test(line)) continue;

		const bullet = /^([-*+]|[0-9]+\.)[ \t]/.test(line);
		if (bullet && firstBullet === 0) firstBullet = lineNo;
		if (!line.startsWith("#")) totalWords += wordCount(line);
		if (line.startsWith("#") || bullet) continue;

		if (wordCount(line) >= minProseWords && firstProse === 0)
			firstProse = lineNo;
		paragraph += ` ${line}`;
		if (paragraphLine === 0) paragraphLine = lineNo;
	}
	flush();

	if (firstProse === 0 && totalWords >= minBodyWords)
		add(
			1,
			"no prose summary - the body is headings, bullets, and code with no explanatory sentence",
		);
	else if (firstBullet > 0 && firstProse > firstBullet)
		add(
			firstBullet,
			"bullets start before any prose - open with a sentence saying what changed and why",
		);
	return findings;
}

async function valeFindings(
	body: string,
	config: string,
	ctx: HookContext,
): Promise<{ findings: Finding[]; notice: string }> {
	mkdirSync(ctx.scratchDir, { recursive: true, mode: 0o700 });
	const dir = mkdtempSync(join(ctx.scratchDir, "pr-prose."));
	try {
		writeFileSync(join(dir, "body.md"), `${body}\n`);
		const level = ctx.env["HOOK_PR_PROSE_LEVEL"] ?? "warning";
		const result = await ctx.seams.run(
			[
				"vale",
				`--config=${config}`,
				`--minAlertLevel=${level}`,
				'--filter=.Name != "Vale.Spelling"',
				"--output=line",
				"body.md",
			],
			{ cwd: dir },
		);
		const findings = result.stdout.split("\n").flatMap((row) => {
			const [, line, , check, ...rest] = row.split(":");
			if (!line || !check || rest.length === 0) return [];
			return [
				{
					line: Number(line),
					message: `${rest.join(":").trim()} (${check})`,
				},
			];
		});
		const failed =
			result.status === 127 || (result.status !== 0 && findings.length === 0);
		return { findings, notice: failed ? VALE_FAILED : "" };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function firstHint(ctx: HookContext): boolean {
	const marker = join(ctx.scratchDir, `pr-prose-hint.${ctx.sessionId}`);
	if (existsSync(marker)) return false;
	mkdirSync(ctx.scratchDir, { recursive: true, mode: 0o700 });
	writeFileSync(marker, "");
	return true;
}

const handler: HookHandler = async (input, ctx) => {
	const command = bashCommand(input);
	if (!invokesPrCommand(command, ["create", "edit", "update"]))
		return { exitCode: 0 };
	if (ctx.bypassed("pr-prose-disabled")) return { exitCode: 0 };
	const body = extractBody(command, input.cwd ?? process.cwd()).replace(
		/\n+$/,
		"",
	);
	if (body.trim() === "") return { exitCode: 0 };

	const findings = scanBody(body, ctx.number("HOOK_PR_PROSE_MAX_SENTENCE", 40));
	let hint = "";
	if (!ctx.seams.which("vale")) hint = VALE_HINT;
	else {
		const config = ctx.env["HOOK_PR_PROSE_VALE_CONFIG"];
		if (!config) hint = VALE_UNCONFIGURED;
		else {
			const vale = await valeFindings(
				body,
				resolve(input.cwd ?? process.cwd(), config),
				ctx,
			);
			findings.unshift(...vale.findings);
			hint = vale.notice;
		}
	}
	if (findings.length === 0)
		return hint && firstHint(ctx)
			? { exitCode: 0, additionalContext: hint.trim() }
			: { exitCode: 0 };

	const max = ctx.number("HOOK_PR_PROSE_MAX_FINDINGS", 12);
	const sorted = [...findings].sort((a, b) => a.line - b.line);
	const lines = [
		`PR body does not read as plain English (${sorted.length} issue(s)):`,
		...sorted.slice(0, max).map((f) => `  body line ${f.line}: ${f.message}`),
	];
	if (sorted.length > max)
		lines.push(
			`  ... (${sorted.length - max} more, raise HOOK_PR_PROSE_MAX_FINDINGS to see all)`,
		);
	lines.push(
		"fix: rewrite the body as plain English - short active sentences that say what changed and why - then retry.",
	);
	return { exitCode: 2, stderr: `${hint}${lines.join("\n")}\n` };
};

export default handler;
