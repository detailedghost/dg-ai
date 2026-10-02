import { Command } from "commander";

export type CliFlags = Record<string, string | boolean>;

export type ParsedArgs = {
	group: string;
	action: string;
	rest: string[];
	flags: CliFlags;
};

type CliOption = {
	flags: string;
	description: string;
};

const cliOptions = [
	{ flags: "--config [path]", description: "Path to organizer config JSON." },
	{
		flags: "--provider [name]",
		description: "Mail provider: protonmail, outlook, or gmail.",
	},
	{
		flags: "--data-path [path]",
		description: "Use a local fixture dataset for the selected provider.",
	},
	{
		flags: "--plan-path [path]",
		description: "Use a local cleanup plan JSON file.",
	},
	{
		flags: "--patch-path [path]",
		description: "Use a local cleanup plan patch JSON file.",
	},
	{
		flags: "--spec-path [path]",
		description: "Use a local spec markdown file.",
	},
	{
		flags: "--gmail-data-path [path]",
		description: "Use a local Gmail fixture dataset.",
	},
	{ flags: "--dir [path]", description: "Workspace directory." },
	{
		flags: "--dirs [paths]",
		description: "Comma-separated workspace directories.",
	},
	{
		flags: "--account-profile [name]",
		description: "Workspace account profile name.",
	},
	{
		flags: "--username [email]",
		description: "Workspace login email metadata.",
	},
	{ flags: "--folder [folder]", description: "Source folder selector." },
	{ flags: "--limit [number]", description: "Maximum rows or messages." },
	{
		flags: "--concurrency [number]",
		description: "Maximum concurrent async operations.",
	},
	{
		flags: "--workers [number]",
		description: "Batch writer threads (0/unset = auto, scaled to CPU cores).",
	},
	{
		flags: "--ids [list]",
		description: "Comma-separated work-item ids to restrict a decision to.",
	},
	{
		flags: "--ids-file [path]",
		description:
			"File of work-item ids (one per line or JSON array) to restrict a decision to.",
	},
	{
		flags: "--to [selector]",
		description:
			"Destination parent folder for relocate ('root' for top level).",
	},
	{
		flags: "--rename [name]",
		description: "New folder display name for relocate.",
	},
	{ flags: "--group-limit [number]", description: "Maximum probe groups." },
	{ flags: "--by [field]", description: "Analysis grouping field." },
	{ flags: "--domain [domain]", description: "Filter by exact sender domain." },
	{
		flags: "--domain-contains [text]",
		description: "Filter by sender domain substring.",
	},
	{
		flags: "--proposal-limit [number]",
		description: "Maximum proposals to print.",
	},
	{
		flags: "--sample-limit [number]",
		description: "Maximum samples per recommendation.",
	},
	{
		flags: "--min-count [number]",
		description: "Minimum recommendation count.",
	},
	{
		flags: "--min-domains [number]",
		description: "Minimum generated domains.",
	},
	{ flags: "--action [action]", description: "Decision action." },
	{ flags: "--target-folder [folder]", description: "Target folder selector." },
	{ flags: "--reason [text]", description: "Decision reason." },
	{
		flags: "--decision-action [action]",
		description: "Filter by existing decision action.",
	},
	{ flags: "--status [status]", description: "Filter by pipeline status." },
	{ flags: "--profile [name]", description: "Route profile name." },
	{
		flags: "--invoice-name [name]",
		description: "Grouped invoice filter name.",
	},
	{ flags: "--spam-name [name]", description: "Grouped spam filter name." },
	{ flags: "--hunt-name [name]", description: "Grouped hunt filter name." },
	{
		flags: "--live-browser [true|false]",
		description: "Use live Proton browser access.",
	},
	{
		flags: "--session-profile [path]",
		description: "Browser session profile path.",
	},
	{
		flags: "--browser-type [name]",
		description: "Browser type for live access.",
	},
	{
		flags: "--browser-executable-path [path]",
		description: "Browser executable path.",
	},
	{
		flags: "--browser-headless [true|false]",
		description: "Run live browser headlessly.",
	},
	{
		flags: "--login-timeout [seconds]",
		description: "Seconds to wait for interactive Proton login.",
	},
	{
		flags: "--dry-run",
		description: "Plan without mutating the mailbox or local data.",
	},
	{
		flags: "--confirm",
		description: "Apply a previously dry-run mailbox mutation.",
	},
	{ flags: "--full", description: "Print full output." },
	{ flags: "--write", description: "Write local decision updates." },
	{
		flags: "--write-archive-decisions",
		description: "Rewrite safe archive follow-up decisions.",
	},
	{
		flags: "--only-target-mismatch",
		description: "Only update items not already at the target.",
	},
	{
		flags: "--mark-read [true|false]",
		description: "Override mark-read decision behavior.",
	},
	{
		flags: "--no-open",
		description: "Do not open generated browser artifacts.",
	},
	{
		flags: "--no-wait",
		description:
			"Generate and open review artifacts without waiting for browser submission.",
	},
	{
		flags: "--review-timeout [seconds]",
		description: "Seconds to wait for cleanup visualize review submission.",
	},
	{ flags: "--ai", description: "Enable Codex-friendly output mode." },
	{ flags: "--ai-summary", description: "Print compact AI summary output." },
	{ flags: "--ai-limit [number]", description: "Limit AI output rows." },
	{
		flags: "--ai-fields [fields]",
		description: "Comma-separated fields for AI output.",
	},
	{
		flags: "--ai-redacted [true|false]",
		description: "Control redacted AI output.",
	},
	{ flags: "--help", description: "Display help." },
] satisfies CliOption[];

export type CliCommandSpec = {
	nameAndArgs: string;
	description: string;
};

export const cliCommandSpecs = [
	{
		nameAndArgs: "init",
		description: "Initialize login metadata and config-home files.",
	},
	{
		nameAndArgs: "login",
		description: "Open a browser to establish a reusable live Proton session.",
	},
	{
		nameAndArgs: "load <folders|labels|filters>",
		description: "Load provider folder, label/category, or filter snapshots.",
	},
	{
		nameAndArgs: "classify-doc",
		description: "Write the local classification guide.",
	},
	{
		nameAndArgs: "folders plan-tree",
		description: "Plan a provider cleanup folder tree.",
	},
	{
		nameAndArgs: "folders apply-tree",
		description: "Confirm a previously planned provider folder tree.",
	},
	{
		nameAndArgs: "folders inventory",
		description: "Inspect saved folder paths and ambiguous names.",
	},
	{
		nameAndArgs: "folders relocate",
		description:
			"Move a folder (to another parent or 'root') and/or rename it, then refresh the snapshot.",
	},
	{
		nameAndArgs: "labels plan",
		description: "Plan provider label/category cleanup.",
	},
	{
		nameAndArgs: "labels apply",
		description:
			"Confirm a previously planned provider label/category cleanup.",
	},
	{
		nameAndArgs: "labels inventory",
		description: "Inspect saved labels or Outlook categories.",
	},
	{ nameAndArgs: "probe", description: "Read-only source folder summary." },
	{
		nameAndArgs: "batch",
		description: "Create one redacted work item per message.",
	},
	{
		nameAndArgs: "analyze",
		description: "Group local work items by domain, status, or folder.",
	},
	{
		nameAndArgs: "sample",
		description: "Print redacted local message samples.",
	},
	{ nameAndArgs: "suggest", description: "Suggest local cleanup decisions." },
	{
		nameAndArgs: "decide",
		description: "Write local decisions for selected messages.",
	},
	{
		nameAndArgs: "recommend filters",
		description: "Recommend provider filters from routed messages.",
	},
	{
		nameAndArgs: "filters plan",
		description: "Plan subject-aware provider rules.",
	},
	{
		nameAndArgs: "filters apply",
		description: "Dry-run or create recommended Proton filters.",
	},
	{
		nameAndArgs: "filters consolidate",
		description: "Merge generated filters into existing filters.",
	},
	{
		nameAndArgs: "filters group",
		description: "Promote generated filters into grouped filters.",
	},
	{
		nameAndArgs: "filters route",
		description: "Dry-run or apply a configured route profile.",
	},
	{
		nameAndArgs: "inbox projects",
		description:
			"Discover project-folder candidates from redacted local Inbox work items.",
	},
	{
		nameAndArgs: "cleanup verify",
		description:
			"Verify applied cleanup reports against the loaded JSON policy.",
	},
	{
		nameAndArgs: "cleanup validate",
		description: "Validate the loaded cleanup policy JSON.",
	},
	{
		nameAndArgs: "cleanup visualize",
		description: "Render and open an HTML cleanup policy review.",
	},
	{
		nameAndArgs: "cleanup plan-patch",
		description: "Dry-run or confirm an edited cleanup policy patch.",
	},
	{
		nameAndArgs: "validate spec",
		description: "Validate create-spec frontmatter without external yq.",
	},
	{
		nameAndArgs: "inbox review-queue",
		description: "Export redacted skipped Inbox review queues.",
	},
	{
		nameAndArgs: "inbox route-plan",
		description: "Plan Inbox routes from the loaded JSON policy.",
	},
	{
		nameAndArgs: "inbox route-apply",
		description: "Confirm previously planned Inbox routes.",
	},
	{
		nameAndArgs: "status",
		description: "Print local message pipeline status.",
	},
	{ nameAndArgs: "summary", description: "Print mailbox workspace summary." },
	{ nameAndArgs: "review", description: "Create a mailbox review plan." },
	{
		nameAndArgs: "apply",
		description: "Dry-run or confirm provider-backed mailbox mutations.",
	},
	{
		nameAndArgs: "cleanup",
		description:
			"Delete disposable local artifacts while preserving login metadata.",
	},
] satisfies CliCommandSpec[];

export function parseArgs(argv: string[]): ParsedArgs {
	const commanderFlags = parseCommanderFlags(argv);
	const positional: string[] = [];
	const flags: CliFlags = {};

	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (!token.startsWith("--")) {
			positional.push(token);
			continue;
		}

		const withoutPrefix = token.slice(2);
		const [inlineKey, inlineValue] = withoutPrefix.split("=", 2);
		if (inlineValue !== undefined) {
			flags[inlineKey] ??= inlineValue;
			continue;
		}

		const next = argv[index + 1];
		if (next && !next.startsWith("--")) {
			flags[inlineKey] ??= next;
			index += 1;
			continue;
		}

		flags[inlineKey] ??= true;
	}

	for (const [key, value] of Object.entries(commanderFlags)) {
		flags[key] ??= value;
	}

	const [group = "help", action = ""] = positional;
	return { group, action, rest: positional.slice(2), flags };
}

export function createCliProgram(): Command {
	const program = new Command()
		.name("dg-skills inbox")
		.description("Review-first Proton Mail cleanup workflow.")
		.helpOption(false)
		.allowUnknownOption(true)
		.allowExcessArguments(true)
		.argument("[tokens...]", "command and optional action");

	for (const option of cliOptions) {
		program.option(option.flags, option.description);
	}

	return program;
}

export function createHelpProgram(): Command {
	const program = new Command()
		.name("dg-skills inbox")
		.description("Review-first Proton Mail cleanup workflow.")
		.helpOption("-h, --help", "display help for command");

	for (const option of cliOptions.filter(
		(option) => option.flags !== "--help",
	)) {
		program.option(option.flags, option.description);
	}

	return program;
}

export function commandHelpText(): string {
	return [
		"Commands:",
		...cliCommandSpecs.map(
			(spec) => `  ${spec.nameAndArgs.padEnd(28)} ${spec.description}`,
		),
		"",
		"AI output flags:",
		"  --ai --ai-summary --ai-limit <n> --ai-fields id,name --ai-redacted",
		"",
		"Live browser flags:",
		"  --live-browser true|false --session-profile <path> --browser-type <name> --browser-executable-path <path> --browser-headless true|false",
	].join("\n");
}

function parseCommanderFlags(argv: string[]): CliFlags {
	const program = createCliProgram();
	program.configureOutput({
		writeOut: () => undefined,
		writeErr: () => undefined,
	});
	program.parse(argv, { from: "user" });
	return optionsToFlags(program.opts<Record<string, string | boolean>>());
}

function optionsToFlags(
	options: Record<string, string | boolean | undefined>,
): CliFlags {
	return Object.fromEntries(
		Object.entries(options)
			.filter(
				(entry): entry is [string, string | boolean] => entry[1] !== undefined,
			)
			.map(([key, value]) => [
				key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
				value,
			]),
	);
}

export function getStringFlag(
	flags: CliFlags,
	key: string,
	fallback = "",
): string {
	const value = flags[key];
	return typeof value === "string" ? value : fallback;
}

export function getNumberFlag(
	flags: CliFlags,
	key: string,
	fallback: number,
): number {
	const value = flags[key];
	if (typeof value !== "string") {
		return fallback;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

export function getBooleanFlag(flags: CliFlags, key: string): boolean {
	return flags[key] === true || flags[key] === "true";
}

export function getListFlag(
	flags: CliFlags,
	key: string,
): string[] | undefined {
	const value = flags[key];
	if (typeof value !== "string" || value.trim() === "") {
		return undefined;
	}
	return value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
}
