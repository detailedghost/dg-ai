import { getProvider } from "../provider/index";
import { type Issue, type ProviderKind, parseRepoRef, type RepoRef } from "../provider/types";
import { defineCommand, EXIT } from "../utils/legacy-command";
import { optionalOption, requireOption } from "../utils/options";

function printJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Gathers every occurrence of a repeatable flag, e.g. `--label bug --label triage` -> ["bug", "triage"]. */
function collectOption(args: string[], name: string): string[] {
	const values: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] !== name) continue;
		const value = args[i + 1];
		if (!value) throw new Error(`${name} requires a value`);
		values.push(value);
	}
	return values;
}

function parseLimit(args: string[]): number | undefined {
	const raw = optionalOption(args, "--limit");
	if (raw === undefined) return undefined;
	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`--limit requires a positive whole number, got "${raw}"`);
	}
	return parsed;
}

function parseRepoOption(args: string[]): RepoRef | undefined {
	const value = optionalOption(args, "--repo");
	return value === undefined ? undefined : parseRepoRef(value);
}

function parseProviderOption(args: string[]): ProviderKind | undefined {
	const value = optionalOption(args, "--provider");
	if (value === undefined) return undefined;
	if (value !== "github" && value !== "gitlab") {
		throw new Error(`--provider must be "github" or "gitlab", got "${value}"`);
	}
	return value;
}

function requireNumberArg(args: string[], commandName: string): number {
	const value = Number(positionals(args)[0]);
	if (!Number.isInteger(value) || value < 1) throw new Error(`${commandName} requires a positive issue number`);
	return value;
}

async function cmdCreate(args: string[]): Promise<number> {
	const provider = await getProvider(parseProviderOption(args));
	const repo = parseRepoOption(args);
	printJson(
		await provider.createIssue(
			{
				title: requireOption(args, "--title"),
				body: optionalOption(args, "--body"),
				labels: collectOption(args, "--label"),
				assignees: collectOption(args, "--assignee"),
			},
			repo,
		),
	);
	return EXIT.OK;
}

/**
 * A label an issue carries appears in every one of its buckets — a "bug"+"auth" issue lands in
 * both, so this is a fan-out grouping, not a partition. Unlabeled issues collect under "_unlabeled".
 */
function groupByLabel(issues: Issue[]): Record<string, Issue[]> {
	const buckets: Record<string, Issue[]> = Object.create(null);
	for (const issue of issues) {
		const labels = issue.labels.length ? issue.labels : ["_unlabeled"];
		for (const label of labels) {
			if (!buckets[label]) buckets[label] = [];
			buckets[label].push(issue);
		}
	}
	return buckets;
}

async function cmdList(args: string[]): Promise<number> {
	const provider = await getProvider(parseProviderOption(args));
	const repo = parseRepoOption(args);
	const limit = parseLimit(args);
	const issues = await provider.listIssues(
		{ limit, state: optionalOption(args, "--state"), label: optionalOption(args, "--label") },
		repo,
	);
	printJson(args.includes("--group-by-label") ? groupByLabel(issues) : issues);
	return EXIT.OK;
}

async function cmdView(args: string[]): Promise<number> {
	const provider = await getProvider(parseProviderOption(args));
	const repo = parseRepoOption(args);
	printJson(await provider.viewIssue(requireNumberArg(args, "view"), repo));
	return EXIT.OK;
}

/** Strips the shared and bucket flags, leaving plain positionals. */
function positionals(args: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--repo" || a === "--provider") {
			i++;
			continue;
		}
		if (a === "--create") continue;
		out.push(a);
	}
	return out;
}

async function cmdBucket(args: string[]): Promise<number> {
	const provider = await getProvider(parseProviderOption(args));
	const repo = parseRepoOption(args);
	const [label, ...numberStrs] = positionals(args);
	if (!label) throw new Error("bucket requires a <label> and at least one issue number");
	if (numberStrs.length === 0) throw new Error("bucket requires at least one issue number");
	const numbers = numberStrs.map((s) => {
		const n = Number(s);
		if (!Number.isInteger(n) || n < 1) throw new Error(`bucket requires positive whole issue numbers, got "${s}"`);
		return n;
	});

	if (args.includes("--create")) await provider.ensureLabel(label, repo);

	const results: Issue[] = [];
	const failures: string[] = [];
	for (const number of numbers) {
		try {
			results.push(await provider.addLabelsToIssue(number, [label], repo));
		} catch (error) {
			failures.push(`#${number}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	printJson(results);
	if (failures.length) throw new Error(`bucket failed for ${failures.join("; ")}`);
	return EXIT.OK;
}

const command = defineCommand({
	name: "dg-skills file",
	description: "File and organize issues on the repo's detected git provider (GitHub or GitLab).",
	subcommands: {
		create: {
			description: "Create an issue; requires --title, accepts --body, repeatable --label and --assignee",
			run: cmdCreate,
		},
		list: {
			description: "List issues as normalized JSON; --state open|closed|all, --label, --limit, --group-by-label",
			run: cmdList,
		},
		view: {
			description: "View one issue as normalized JSON",
			args: ["number"],
			run: cmdView,
		},
		bucket: {
			description:
				"Attach <label> to one or more issue numbers, bucketing them together; --create makes the label first",
			args: ["label", "numbers..."],
			run: cmdBucket,
		},
	},
});

/** Dispatch issue operations only when explicitly invoked. */
export async function main(argv: string[]): Promise<void> {
	await command.run(argv);
}
