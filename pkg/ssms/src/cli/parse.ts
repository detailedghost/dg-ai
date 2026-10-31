const FLAGS = [
	"help",
	"json",
	"config",
	"dry-run",
	"yes",
	"name",
	"limit",
	"timeout-ms",
	"conversation",
	"text",
	"emoji",
	"target-timestamp",
	"target-author",
	"attachment",
	"quote-timestamp",
	"quote-author",
	"quote-text",
	"draft",
	"remove",
] as const;

const VALUE_FLAGS = new Set([
	"config",
	"name",
	"limit",
	"timeout-ms",
	"conversation",
	"text",
	"emoji",
	"target-timestamp",
	"target-author",
	"attachment",
	"quote-timestamp",
	"quote-author",
	"quote-text",
	"draft",
]);

export interface ParsedArgs {
	help: boolean;
	json: boolean;
	dryRun: boolean;
	yes: boolean;
	remove: boolean;
	provider?: string;
	verb?: string;
	conversation?: string;
	name?: string;
	config?: string;
	text?: string;
	emoji?: string;
	draft?: string;
	quoteText?: string;
	targetAuthor?: string;
	quoteAuthor?: string;
	limit?: number;
	timeoutMs?: number;
	targetTimestamp?: number;
	quoteTimestamp?: number;
	attachments: string[];
}

export class UsageError extends Error {
	readonly code = 2;
	constructor(message: string) {
		super(message);
		this.name = "UsageError";
	}
}

function integer(flag: string, value: string): number {
	if (!/^\d+$/.test(value)) throw new UsageError(`${flag} expects a non-negative integer`);
	return Number(value);
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
	const parsed: ParsedArgs = {
		help: false,
		json: false,
		dryRun: false,
		yes: false,
		remove: false,
		attachments: [],
	};
	const positionals: string[] = [];
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i] ?? "";
		if (token === "--") {
			positionals.push(...argv.slice(i + 1));
			break;
		}
		if (!token.startsWith("--")) {
			positionals.push(token);
			continue;
		}
		const body = token.slice(2);
		const eq = body.indexOf("=");
		const name = eq === -1 ? body : body.slice(0, eq);
		if (!FLAGS.includes(name as (typeof FLAGS)[number])) {
			throw new UsageError(`unknown flag --${name}`);
		}
		if (!VALUE_FLAGS.has(name)) {
			if (eq !== -1) throw new UsageError(`--${name} does not take a value`);
			if (name === "help") parsed.help = true;
			else if (name === "json") parsed.json = true;
			else if (name === "dry-run") parsed.dryRun = true;
			else if (name === "yes") parsed.yes = true;
			else parsed.remove = true;
			continue;
		}
		const value = eq === -1 ? argv[++i] : body.slice(eq + 1);
		if (value === undefined || value.startsWith("--")) {
			throw new UsageError(`--${name} needs a value`);
		}
		if (name === "attachment") parsed.attachments.push(value);
		else if (name === "limit") parsed.limit = integer("--limit", value);
		else if (name === "timeout-ms") parsed.timeoutMs = integer("--timeout-ms", value);
		else if (name === "target-timestamp") parsed.targetTimestamp = integer("--target-timestamp", value);
		else if (name === "quote-timestamp") parsed.quoteTimestamp = integer("--quote-timestamp", value);
		else if (name === "config") parsed.config = value;
		else if (name === "name") parsed.name = value;
		else if (name === "conversation") parsed.conversation = value;
		else if (name === "text") parsed.text = value;
		else if (name === "emoji") parsed.emoji = value;
		else if (name === "target-author") parsed.targetAuthor = value;
		else if (name === "quote-author") parsed.quoteAuthor = value;
		else if (name === "quote-text") parsed.quoteText = value;
		else parsed.draft = value;
	}
	parsed.provider = positionals[0];
	parsed.verb = positionals[1];
	if (!parsed.conversation && positionals[2]) parsed.conversation = positionals[2];
	if (positionals.length > 3) throw new UsageError("too many arguments");
	return parsed;
}
