import { type CommandSpec, EXIT } from "../utils/legacy-command";
import { detectProvider } from "../provider/detect";
import { getProvider } from "../provider/index";
import type { ProviderKind } from "../provider/types";

interface DetectOutput {
	resolved: boolean;
	kind: ProviderKind | null;
	owner: string | null;
	repo: string | null;
	url: string | null;
	reason?: string;
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function printJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function cmdDetect(): Promise<number> {
	let kind: ProviderKind;
	try {
		kind = (await detectProvider()).kind;
	} catch (err) {
		printJson({
			resolved: false,
			kind: null,
			owner: null,
			repo: null,
			url: null,
			reason: errorMessage(err),
		} satisfies DetectOutput);
		return EXIT.OK;
	}

	try {
		const provider = await getProvider(kind);
		const info = await provider.repoInfo();
		printJson({
			resolved: true,
			kind,
			owner: info.owner,
			repo: info.repo,
			url: `https://${info.host}/${info.owner}/${info.repo}`,
		} satisfies DetectOutput);
	} catch (err) {
		printJson({
			resolved: true,
			kind,
			owner: null,
			repo: null,
			url: null,
			reason: errorMessage(err),
		} satisfies DetectOutput);
	}
	return EXIT.OK;
}

async function cmdCapabilities(): Promise<number> {
	const { kind } = await detectProvider();
	const provider = await getProvider(kind);
	printJson({ kind, ...provider.capabilities });
	return EXIT.OK;
}

/** Exit code IS the answer, so this drops straight into an `if` the way `gh auth status` did. */
async function cmdAuth(): Promise<number> {
	const provider = await getProvider();
	return (await provider.checkAuth()) ? EXIT.OK : EXIT.ERR;
}

function parseLimit(args: string[]): number | undefined {
	const index = args.indexOf("--limit");
	if (index === -1) return undefined;
	const raw = args[index + 1];
	const parsed = Number(raw);
	if (raw === undefined || !Number.isInteger(parsed) || parsed < 1) {
		throw new Error(`--limit requires a positive whole number, got "${raw ?? ""}"`);
	}
	return parsed;
}

function optionalOption(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (!value) throw new Error(`${name} requires a value`);
	return value;
}

function requireOption(args: string[], name: string): string {
	const value = optionalOption(args, name);
	if (!value) throw new Error(`${name} requires a value`);
	return value;
}

function requireNumberArg(args: string[], commandName: string): number {
	const value = Number(args[0]);
	if (!Number.isInteger(value) || value < 1) throw new Error(`${commandName} requires a positive issue/PR number`);
	return value;
}

async function cmdListPrs(args: string[]): Promise<number> {
	const provider = await getProvider();
	const limit = parseLimit(args);
	const head = optionalOption(args, "--head");
	printJson(
		await provider.listPullRequests({
			...(limit === undefined ? {} : { limit }),
			...(head === undefined ? {} : { head }),
		}),
	);
	return EXIT.OK;
}

async function cmdListIssues(args: string[]): Promise<number> {
	const provider = await getProvider();
	const limit = parseLimit(args);
	printJson(await provider.listIssues(limit === undefined ? {} : { limit }));
	return EXIT.OK;
}

async function cmdViewIssue(args: string[]): Promise<number> {
	const provider = await getProvider();
	printJson(await provider.viewIssue(requireNumberArg(args, "view-issue")));
	return EXIT.OK;
}

async function cmdViewPr(args: string[]): Promise<number> {
	const provider = await getProvider();
	printJson(await provider.viewPullRequest({ number: requireNumberArg(args, "view-pr") }));
	return EXIT.OK;
}

async function cmdListThreads(args: string[]): Promise<number> {
	const provider = await getProvider();
	printJson(await provider.listUnresolvedThreads({}, { number: requireNumberArg(args, "list-threads") }));
	return EXIT.OK;
}

async function cmdCreatePr(args: string[]): Promise<number> {
	const provider = await getProvider();
	printJson(
		await provider.createPullRequest({
			title: requireOption(args, "--title"),
			base: requireOption(args, "--base"),
			head: requireOption(args, "--head"),
			body: requireOption(args, "--body"),
			draft: args.includes("--draft"),
		}),
	);
	return EXIT.OK;
}

async function cmdMergedPrForBranch(args: string[]): Promise<number> {
	const branch = args[0];
	if (!branch) throw new Error("merged-pr-for-branch requires a <branch> argument");
	const provider = await getProvider();
	const matches = await provider.listPullRequests({ head: branch, state: "MERGED" });
	printJson(matches[0] ?? null);
	return EXIT.OK;
}

/** Declare the ten provider verbs; detect degrades to JSON nulls while other failures retain command error status. */
export const commandSpec = {
	name: "vcs-provider",
	description: "Query the detected VCS provider (GitHub or GitLab) for repo info, issues, and pull requests. Run dg-skills vcs-provider <subcommand>.",
	subcommands: {
		detect: {
			description: "Detect the provider and repo; always exits 0, degrading to nulls plus a reason on failure",
			run: cmdDetect,
		},
		capabilities: {
			description: "Print the resolved provider's capabilities; fails loud when no provider resolves",
			run: cmdCapabilities,
		},
		auth: {
			description: "Exit 0 when the provider's CLI is authenticated, non-zero otherwise; prints nothing on success",
			run: cmdAuth,
		},
		"list-prs": {
			description: "List pull requests for the current repo as a bare JSON array; --limit N caps the count, --head <branch> narrows to one source branch",
			run: cmdListPrs,
		},
		"list-issues": {
			description: "List open issues for the current repo as normalized JSON; --limit N caps the count",
			run: cmdListIssues,
		},
		"view-issue": {
			description: "View one issue as normalized JSON",
			args: ["number"],
			run: cmdViewIssue,
		},
		"view-pr": {
			description: "View one pull request or merge request as normalized JSON",
			args: ["number"],
			run: cmdViewPr,
		},
		"list-threads": {
			description: "List unresolved review threads for a pull request or merge request",
			args: ["number"],
			run: cmdListThreads,
		},
		"create-pr": {
			description: "Create a pull request or merge request; accepts --draft --title --base --head --body",
			run: cmdCreatePr,
		},
		"merged-pr-for-branch": {
			description: "Print the first merged pull request for <branch>, or JSON null",
			args: ["branch"],
			run: cmdMergedPrForBranch,
		},
	},
} satisfies CommandSpec;
