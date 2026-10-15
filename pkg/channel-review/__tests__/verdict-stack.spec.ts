import { beforeEach, describe, expect, test } from "bun:test";
import { createStackReader } from "../src/verdict";
import { VerdictError } from "../src/verdict/types";

type Capture = {
	status: number;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
};

const ok = (stdout: string): Capture => ({
	status: 0,
	signal: null,
	stdout,
	stderr: "",
});
const fail = (status: number, stderr: string): Capture => ({
	status,
	signal: null,
	stdout: "",
	stderr,
});

const NO_HOSTS = { github: [], gitlab: [] };
const warnings: string[] = [];
const log = { warn: (message: string) => warnings.push(message) };

beforeEach(() => {
	warnings.length = 0;
});

const GITHUB_URL = "https://github.com/o/r/pull/10";
const prUrl = (n: number) => `https://github.com/o/r/pull/${n}`;

function pr(
	number: number,
	base: string,
	head: string,
	headRepo = "o/r",
	baseRepo = "o/r",
) {
	return {
		number,
		html_url: prUrl(number),
		state: "open",
		base: { ref: base, repo: { full_name: baseRepo } },
		head: { ref: head, repo: { full_name: headRepo } },
	};
}

const STACK = [
	pr(9, "main", "feat-root"),
	pr(10, "feat-root", "feat-a"),
	pr(11, "feat-a", "feat-b"),
	pr(12, "feat-b", "feat-c"),
	pr(13, "feat-a", "feat-d"),
	pr(14, "feat-a", "feat-e", "fork/r"),
];

function githubReader(
	pages: unknown[][],
	override?: () => Capture | Promise<Capture>,
	timeoutMs?: number,
) {
	const calls: { command: string; args: string[]; options: unknown }[] = [];
	const reader = createStackReader({
		hosts: NO_HOSTS,
		log,
		timeoutMs,
		runCapture: async (command: string, args: string[], opts?: unknown) => {
			calls.push({ command, args, options: opts });
			return override ? override() : ok(JSON.stringify(pages));
		},
	});
	return { reader, calls };
}

const descendants = (
	reader: ReturnType<typeof createStackReader>,
	url = GITHUB_URL,
	host: "github" | "gitlab" = "github",
) => reader.descendants({ url, host });

const failureCode = async (promise: Promise<unknown>) => {
	const error = await promise.catch((e: unknown) => e);
	expect(error).toBeInstanceOf(VerdictError);
	return (error as VerdictError).code;
};

describe("createStackReader github", () => {
	test("drops a descendant whose html_url is on another host and logs the drop", async () => {
		const { reader } = githubReader([
			[
				pr(10, "main", "a"),
				{ ...pr(11, "a", "b"), html_url: "https://evil.example.com/o/r/pull/11" },
				pr(12, "a", "c"),
			],
		]);
		expect(await descendants(reader)).toEqual([{ number: 12, url: prUrl(12) }]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("#11");
	});

	test("drops a descendant whose html_url is not a pull request link", async () => {
		const { reader } = githubReader([
			[pr(10, "main", "a"), { ...pr(11, "a", "b"), html_url: "https://github.com/o/r/issues/11" }],
		]);
		expect(await descendants(reader)).toEqual([]);
		expect(warnings).toHaveLength(1);
	});

	test("returns the descendants depth-first in PR number order with html_url and never the target or its parent", async () => {
		const { reader } = githubReader([STACK]);
		expect(await descendants(reader)).toEqual([
			{ number: 11, url: prUrl(11) },
			{ number: 12, url: prUrl(12) },
			{ number: 13, url: prUrl(13) },
		]);
	});

	test("orders siblings by number even when the fixture lists them out of order", async () => {
		const { reader } = githubReader([
			[
				pr(10, "main", "a"),
				pr(30, "a", "z"),
				pr(21, "a", "y"),
				pr(22, "y", "w"),
			],
		]);
		expect(
			(await descendants(reader)).map((entry: { number: number }) => entry.number),
		).toEqual([21, 22, 30]);
	});

	test("excludes a fork PR whose head branch collides with a stack branch", async () => {
		const { reader } = githubReader([STACK]);
		const numbers = (await descendants(reader)).map((entry: { number: number }) => entry.number);
		expect(numbers).not.toContain(14);
	});

	test("flattens a two-page slurp fixture", async () => {
		const { reader } = githubReader([
			STACK.slice(0, 3),
			STACK.slice(3),
		]);
		expect(
			(await descendants(reader)).map((entry: { number: number }) => entry.number),
		).toEqual([11, 12, 13]);
	});

	test("returns an empty list when nothing is stacked on the target", async () => {
		const { reader } = githubReader([[pr(10, "main", "feat-a")]]);
		expect(await descendants(reader)).toEqual([]);
	});

	test("ends the walk on a base/head cycle and never lists the target", async () => {
		const { reader } = githubReader([
			[pr(30, "main", "x"), pr(31, "x", "y"), pr(32, "y", "x")],
		]);
		expect(
			(await descendants(reader, prUrl(30))).map((entry: { number: number }) => entry.number),
		).toEqual([31, 32]);
	});

	test("maps a target missing from the open list to CR-302", async () => {
		const { reader } = githubReader([STACK.filter((row) => row.number !== 10)]);
		expect(await failureCode(descendants(reader))).toBe("CR-302");
	});

	test("lists open pulls of the parsed repository with --hostname, --paginate, --slurp, and a 60 s timeout", async () => {
		const { reader, calls } = githubReader([STACK]);
		await descendants(reader);
		const call = calls[0];
		expect(call?.command).toBe("gh");
		expect(
			call?.args.some((arg: string) => arg.startsWith("repos/o/r/pulls")),
		).toBe(true);
		expect(call?.args).toContain("--paginate");
		expect(call?.args).toContain("--slurp");
		expect(call?.args[(call?.args.indexOf("--hostname") ?? -2) + 1]).toBe(
			"github.com",
		);
		expect(call?.options).toMatchObject({ timeoutMs: 60_000 });
	});

	test("maps a gh login failure to CR-303", async () => {
		const { reader } = githubReader([], () => fail(4, "auth required"));
		expect(await failureCode(descendants(reader))).toBe("CR-303");
	});

	test("maps another gh failure to CR-304", async () => {
		const { reader } = githubReader([], () => fail(1, "HTTP 500"));
		expect(await failureCode(descendants(reader))).toBe("CR-304");
	});

	test("maps malformed JSON to CR-304", async () => {
		const { reader } = githubReader([], () => ok("not json"));
		expect(await failureCode(descendants(reader))).toBe("CR-304");
	});

	test("maps a hanging capture to CR-304 after the timeout", async () => {
		const { reader } = githubReader(
			[],
			() => new Promise<Capture>(() => {}),
			50,
		);
		expect(await failureCode(descendants(reader))).toBe("CR-304");
	});
});

const GL_HOST = "gitlab.example.com";
const GL_PATH = "group/sub/repo";
const glUrl = (iid: number) =>
	`https://${GL_HOST}/${GL_PATH}/-/merge_requests/${iid}`;

function mr(
	iid: number,
	target: string,
	source: string,
	sourceProject = 7,
	targetProject = 7,
) {
	return {
		iid,
		web_url: glUrl(iid),
		state: "opened",
		target_branch: target,
		source_branch: source,
		source_project_id: sourceProject,
		target_project_id: targetProject,
	};
}

function gitlabReader(
	pages: unknown[][],
	override?: (endpoint: string) => Capture | undefined,
) {
	const calls: { command: string; args: string[]; options: unknown }[] = [];
	const reader = createStackReader({
		hosts: { github: [], gitlab: [GL_HOST] },
		log,
		runCapture: async (command: string, args: string[], opts?: unknown) => {
			calls.push({ command, args, options: opts });
			const endpoint = args.find((arg: string) => arg.startsWith("projects/")) ?? "";
			const forced = override?.(endpoint);
			if (forced) return forced;
			const page = Number(endpoint.match(/[?&]page=(\d+)/)?.[1] ?? 1);
			return ok(JSON.stringify(pages[page - 1] ?? []));
		},
	});
	return { reader, calls };
}

const glDescendants = (
	reader: ReturnType<typeof createStackReader>,
	iid = 5,
) => reader.descendants({ url: glUrl(iid), host: "gitlab" });

describe("createStackReader gitlab", () => {
	test("drops a descendant whose web_url is on another host and logs the drop", async () => {
		const { reader } = gitlabReader([
			[
				mr(4, "main", "a"),
				{ ...mr(5, "a", "b"), web_url: "https://evil.example.com/group/sub/repo/-/merge_requests/5" },
			],
		]);
		expect(await glDescendants(reader, 4)).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("#5");
	});

	const chain = [
		mr(4, "main", "feat-root"),
		mr(5, "feat-root", "feat-a"),
		mr(6, "feat-a", "feat-b"),
		mr(7, "feat-b", "feat-c"),
		mr(8, "feat-a", "feat-d"),
		mr(9, "feat-a", "feat-e", 99, 7),
	];

	test("returns descendants by iid with web_url and excludes fork merge requests", async () => {
		const { reader } = gitlabReader([chain]);
		expect(await glDescendants(reader)).toEqual([
			{ number: 6, url: glUrl(6) },
			{ number: 7, url: glUrl(7) },
			{ number: 8, url: glUrl(8) },
		]);
	});

	test("calls glab api with --hostname and the encoded project path page by page", async () => {
		const filler = Array.from({ length: 100 }, (_, index) =>
			mr(1000 + index, "main", `pad-${index}`),
		);
		const { reader, calls } = gitlabReader([filler, chain]);
		const result = await glDescendants(reader);
		expect(result.map((entry: { number: number }) => entry.number)).toEqual([6, 7, 8]);
		expect(calls.length).toBeGreaterThanOrEqual(2);
		const encoded = encodeURIComponent(GL_PATH);
		for (const call of calls) {
			expect(call.command).toBe("glab");
			expect(call.args[call.args.indexOf("--hostname") + 1]).toBe(GL_HOST);
			expect(
				call.args.some((arg: string) =>
					arg.startsWith(`projects/${encoded}/merge_requests?state=opened`),
				),
			).toBe(true);
			expect(call.options).toMatchObject({ timeoutMs: 60_000 });
		}
	});

	test("ends the walk on a source/target cycle", async () => {
		const { reader } = gitlabReader([
			[mr(30, "main", "x"), mr(31, "x", "y"), mr(32, "y", "x")],
		]);
		expect(
			(await glDescendants(reader, 30)).map((entry: { number: number }) => entry.number),
		).toEqual([31, 32]);
	});

	test("maps a target that is not open to CR-302", async () => {
		const { reader } = gitlabReader([chain.filter((row) => row.iid !== 5)]);
		expect(await failureCode(glDescendants(reader))).toBe("CR-302");
	});

	test("maps a glab login failure to CR-303", async () => {
		const { reader } = gitlabReader([], () => fail(1, "401 Unauthorized"));
		expect(await failureCode(glDescendants(reader))).toBe("CR-303");
	});

	test("maps another glab failure to CR-304", async () => {
		const { reader } = gitlabReader([], () => fail(1, "500 Internal Server Error"));
		expect(await failureCode(glDescendants(reader))).toBe("CR-304");
	});

	test("maps malformed JSON to CR-304", async () => {
		const { reader } = gitlabReader([], () => ok("<html>"));
		expect(await failureCode(glDescendants(reader))).toBe("CR-304");
	});
});
