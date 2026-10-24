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
};

const fileintoPattern =
	/\bfileinto(?:\s+:create)?\s+"((?:\\.|[^"\\])*)"/gi;
const addressPattern =
	/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function parseSieve(sieve: string): ParsedSieve {
	const requires = readRequires(sieve);
	const comments = readComments(sieve);
	const fileinto = unique(readFileinto(sieve));
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
	};
}

export function sieveLooksTruncated(sieve: string): boolean {
	const text = sieve.trim();
	if (!text) return true;
	if (/\[(?:email|number|phone)(?::|\])/i.test(text)) return true;
	if (!/\brequire\b/i.test(text)) return true;
	const quotes = text.match(/(?<!\\)"/g)?.length ?? 0;
	if (quotes % 2 === 1) return true;
	const opens = text.match(/\{/g)?.length ?? 0;
	const closes = text.match(/\}/g)?.length ?? 0;
	if (opens !== closes) return true;
	return !endsAsScript(text);
}

function endsAsScript(text: string): boolean {
	const lines = text.split("\n");
	while (lines.length > 0 && /^\s*(#.*)?$/.test(lines.at(-1) ?? "")) {
		lines.pop();
	}
	return /[;}]$/.test((lines.at(-1) ?? "").trim());
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

function readFileinto(sieve: string): string[] {
	return [...sieve.matchAll(fileintoPattern)].map((match) =>
		unescape(match[1] ?? "").trim(),
	);
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
