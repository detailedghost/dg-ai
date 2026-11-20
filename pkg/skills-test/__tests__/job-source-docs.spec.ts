import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ROUTES } from "../../dg/src/main";
import { parseJobDeclaration } from "../../dg-daemon/src/jobs/declaration";
import { parseSetupAnswers } from "../../dg-daemon/src/jobs/setup-answers";
import { RESERVED_CREDENTIAL_PREFIXES } from "../../common/src/credentials-format";
import { dgCommandForms, runDgHelp } from "./docs-help-kit";
import { ADR_SECTIONS, count, REPO_ROOT, readRepoFile } from "./test-support";

const JOBS = "docs/jobs-and-services.md";
const SERVICE_API = "docs/service-api.md";
const CHANNEL_REVIEW = "docs/channel-review.md";
const SECURITY = "SECURITY.md";
const SKILL = "plugins/dg/skills/jobs/SKILL.md";
const TOC = "docs/adr/toc.md";
const RECORD_FILE = "0052-job-sources-and-credentials.md";
const RECORD = `docs/adr/${RECORD_FILE}`;
const ADR_0043 = "docs/adr/0043-outside-services.md";
const CHANGED = [JOBS, SERVICE_API, CHANNEL_REVIEW, SECURITY, RECORD];
const ROUTE_NAMES = Object.keys(ROUTES);

const SOURCE_FILES = [
	"dg-daemon/src/commands/jobs.ts",
	"dg-daemon/src/commands/job-source.ts",
	"dg-daemon/src/commands/job-update.ts",
	"dg-daemon/src/commands/job-local.ts",
	"dg-daemon/src/commands/job-setup.ts",
	"dg-daemon/src/commands/job-support.ts",
	"dg-daemon/src/jobs/config.ts",
	"dg-daemon/src/jobs/declaration.ts",
	"dg-daemon/src/jobs/sources.ts",
	"dg-daemon/src/jobs/sanitize.ts",
	"dg-daemon/src/jobs/setup-answers.ts",
	"dg-daemon/src/jobs/secret-sources.ts",
	"dg-daemon/src/jobs/credential-refresh.ts",
	"dg-daemon/src/jobs/launcher.ts",
	"dg-daemon/src/server/job-credentials.ts",
	"dg-daemon/src/server/service-api.ts",
	"common/src/credentials-format.ts",
	"common/src/node/job-credentials-client.ts",
	"common/src/node/dg-paths.ts",
	"common/src/chat-format.ts",
	"skills-cli/src/channel-review/export.ts",
];

const read = (path: string): string => readRepoFile(...path.split("/"));
const source = (): string => SOURCE_FILES.map((file) => readRepoFile("pkg", ...file.split("/"))).join("\n");
const flat = (text: string): string => text.replace(/\s+/g, " ");

function heading(text: string, title: string): string {
	const lines = text.split("\n");
	const start = lines.findIndex((l) => /^#+ /.test(l) && l.replace(/^#+ /, "").trim() === title);
	if (start < 0) return "";
	const level = /^#+/.exec(lines[start])?.[0].length ?? 1;
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((l) => {
		const h = /^(#{1,6}) /.exec(l)?.[1].length;
		return h !== undefined && h <= level;
	});
	return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

function jsonBlocks(text: string): string[] {
	return [...text.matchAll(/^```json\n([\s\S]*?)^```$/gm)].map((m) => m[1]);
}

function firstCodeIndex(text: string, needle: string): number {
	for (const m of text.matchAll(/^```[\s\S]*?^```$|`[^`\n]+`/gm)) {
		const at = m[0].indexOf(needle);
		if (at >= 0) return (m.index ?? 0) + at;
	}
	return -1;
}

function slug(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^\w\s-]/g, "")
		.replace(/\s/g, "-");
}

const NEW_SECTIONS = [
	"Add a job from a repository",
	"Add a local script or folder",
	"Credentials: enable and setup",
	"Answers with --setup",
	"Refresh a credential",
];

const SHARED_PHRASES = [
	"one fetch for one credential in 60 s",
	"can run the code of that repository with no question",
	"holds credentials",
	"the daemon runs no `git` command",
	"with the fixed argv of the declared source",
];

describe("docs/jobs-and-services.md job sources", () => {
	const doc = read(JOBS);

	test("gives dg job add, dg job enable and dg job setup in that order", () => {
		const order = ["dg job add", "dg job enable", "dg job setup"].map((s) => firstCodeIndex(doc, s));
		for (const i of order) expect(i).toBeGreaterThanOrEqual(0);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});

	test("holds the five sections as H2 headings after Job verbs and before Old and new commands", () => {
		const lines = doc.split("\n");
		const at = (title: string) => lines.indexOf(`## ${title}`);
		const positions = ["Job verbs", ...NEW_SECTIONS, "Old and new commands", "Run rules"].map(at);
		for (const p of positions) expect(p).toBeGreaterThanOrEqual(0);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		expect(doc.search(/^#+ Start at login$/m)).toBeGreaterThan(at("Run rules"));
	});

	test("links the five sections from the top and the local section links forward to credentials", () => {
		const top = doc.slice(0, doc.indexOf("A job is a command"));
		for (const title of NEW_SECTIONS) expect(top).toContain(`](#${slug(title)})`);
		expect(heading(doc, "Add a local script or folder")).toContain("(#credentials-enable-and-setup)");
	});

	test("every in-page link names a heading of the document", () => {
		const slugs = new Set(doc.split("\n").filter((l) => /^#+ /.test(l)).map((l) => slug(l.replace(/^#+ /, ""))));
		for (const m of doc.matchAll(/\]\(#([^)]+)\)/g)) expect([m[1], slugs.has(m[1])]).toEqual([m[1], true]);
	});

	test("shows the commands and paths of the repository section", () => {
		const section = heading(doc, "Add a job from a repository");
		for (const w of [
			"dg job add <git-url>[@ref]",
			"dg job update <job>",
			"dg job remove <job>",
			"<data>/jobs/sources.json",
			"<data>/jobs/<source>/",
			"<state>/jobs/<name>/",
			"`update` of a repository job moves each job of that repository",
			"A failed build of `add` leaves nothing",
			"leaves the source at the old commit",
			"the clone can hold build output of the new commit",
			"`Update to this commit? [y/N]`",
			"`Apply these changes? [y/N]`",
			"`replaced <name>.<key>`",
			"`discarded local changes in the clone of \"<source>\"`",
			"`next: dg job setup <name>`",
			"`--yes` gives the consent with no terminal",
		])
			expect([w, flat(section).includes(w)]).toEqual([w, true]);
		expect(section.indexOf("dg job add")).toBeLessThan(section.indexOf("dg job enable"));
	});

	test("shows the local section commands and rules", () => {
		const section = flat(heading(doc, "Add a local script or folder"));
		for (const w of [
			"dg job add ./script.ts --every 15m",
			"dg job enable script",
			"a record of kind `path`",
			"`dg job remove <name>` removes it",
			"`dg job update <name>`",
		])
			expect([w, section.includes(w)]).toEqual([w, true]);
	});

	test("states the credential rules", () => {
		const section = flat(heading(doc, "Credentials: enable and setup"));
		for (const w of [
			"Fetch each credential from its declared source, or ask for it with a hidden prompt",
			"--rotate-token",
			"`This job can read these credentials. Continue? [y/N]`",
			"needs one `y` at a terminal, also for an agent",
			"`--credential <name>=<NAME>`",
			"The child and its children see the value in their environment",
			"is required at launch",
			"`required: false` is refused",
			"is a reserved name",
			"64 characters at most",
			"never printed back",
			"`update` asks no question for a new credential",
		])
			expect([w, section.includes(w) || flat(doc).includes(w)]).toEqual([w, true]);
		expect(flat(doc)).toContain("AWS Secrets Manager is the one source type of this release");
	});

	test("states the --setup rules", () => {
		const section = flat(heading(doc, "Answers with --setup"));
		for (const w of ["a file path or `-`", "never JSON text", "other users can read", "`chmod 600`"])
			expect([w, section.includes(w)]).toEqual([w, true]);
	});

	test("states the refresh rules", () => {
		const section = flat(heading(doc, "Refresh a credential"));
		for (const w of [
			"dg job setup <name> --refresh",
			"dg job restart <name>",
			"the operation `refresh`",
			"`get`",
			"60 s",
			"dg starts no refresh on its own",
			"recorded profile and the environment of the named job",
			"After a 502 the next step is `dg job setup <job> --refresh`",
		])
			expect([w, section.includes(w)]).toEqual([w, true]);
	});

	test("the dg block example passes parseJobDeclaration", () => {
		const blocks = jsonBlocks(heading(doc, "Add a job from a repository"));
		expect(blocks.length).toBe(1);
		const context = {
			source: "bot",
			sourceDir: "/srv/dg/jobs/bot",
			stateDir: (name: string) => `/srv/dg/state/jobs/${name}`,
		};
		const block = JSON.parse(blocks[0]) as Record<string, unknown>;
		const parsed = parseJobDeclaration({ dg: block }, context);
		expect(parsed).toMatchObject({ ok: true });
		if (parsed.ok) expect(parsed.jobs.map((job) => job.name)).toEqual(["bot", "bot-dev"]);
		expect(Object.keys(block.credentials as object).length).toBe(2);
	});

	test("the dg block check fails when the example gets an unknown key", () => {
		const block = JSON.parse(jsonBlocks(heading(doc, "Add a job from a repository"))[0]) as Record<string, unknown>;
		const context = { source: "bot", sourceDir: "/srv/dg/jobs/bot", stateDir: (name: string) => `/srv/dg/state/${name}` };
		expect(parseJobDeclaration({ dg: { ...block, extra: true } }, context)).toMatchObject({ ok: false });
	});

	test("the --setup example parses with the setup answers parser", () => {
		const blocks = jsonBlocks(heading(doc, "Answers with --setup"));
		expect(blocks.length).toBe(1);
		const job = { job: "bot", credentials: ["api-key", "tenant"] };
		expect(parseSetupAnswers(blocks[0], job)).toMatchObject({ ok: true });
		const bad = JSON.stringify({ ...JSON.parse(blocks[0]), extra: true });
		expect(parseSetupAnswers(bad, job)).toMatchObject({ ok: false });
	});
});

describe("each documented command passes its --help form", () => {
	const doc = read(JOBS);
	const sections = NEW_SECTIONS.map((title) => heading(doc, title)).join("\n");

	const helpWords = (words: string[]): string[] => {
		const out: string[] = [];
		for (const word of words) {
			if (!/^[a-z][a-z-]*$/.test(word) || out.length === 2) break;
			out.push(word);
		}
		return out;
	};

	test("the commands of the five sections use job verbs and their flags are in the help text", async () => {
		const forms = dgCommandForms(sections);
		expect(forms.length).toBeGreaterThan(8);
		const byCommand = new Map<string, Set<string>>();
		for (const form of forms) {
			expect(ROUTE_NAMES).toContain(form[0]);
			const key = helpWords(form).join(" ");
			const flags = form.filter((word) => /^--[a-z][a-z-]*$/.test(word));
			byCommand.set(key, new Set([...(byCommand.get(key) ?? []), ...flags]));
		}
		const runs = await Promise.all(
			[...byCommand].map(async ([key, flags]) => ({ key, flags, run: await runDgHelp(key.split(" ")) })),
		);
		for (const { key, flags, run } of runs) {
			expect([key, run.code]).toEqual([key, 0]);
			for (const flag of flags) expect([key, flag, run.stdout.includes(flag)]).toEqual([key, flag, true]);
		}
		expect([...byCommand.keys()].sort()).toEqual(
			expect.arrayContaining(["job add", "job enable", "job remove", "job restart", "job setup", "job update"]),
		);
	}, 120_000);

	test("the options that the text names are in the help of their verb", async () => {
		const expected: Record<string, string[]> = {
			"job add": ["--every", "--yes", "--credential", "--name"],
			"job enable": ["--setup"],
			"job setup": ["--refresh", "--rotate-token"],
			"job update": ["--yes", "--credential"],
		};
		for (const [verb, flags] of Object.entries(expected)) {
			const run = await runDgHelp(verb.split(" "));
			expect([verb, run.code]).toEqual([verb, 0]);
			for (const flag of flags) expect([verb, flag, run.stdout.includes(flag)]).toEqual([verb, flag, true]);
		}
	}, 120_000);

	test("each dg name in a code span or fence of the changed documents is a ROUTES name", () => {
		const bad = CHANGED.flatMap((file) =>
			dgCommandForms(read(file))
				.map((words) => words[0])
				.filter((name) => !ROUTE_NAMES.includes(name) && !["completion", "help", "--help", "--version"].includes(name))
				.map((name) => `${file}: dg ${name}`),
		);
		expect(bad).toEqual([]);
	});
});

describe("documented literals are in their source files", () => {
	const code = source();
	const doc = flat(read(JOBS));

	test("each message and question of the documents is in a source file", () => {
		const literals: Array<[string, string]> = [
			["consent needs a terminal", "consent needs a terminal"],
			["holds credentials", "holds credentials"],
			["is a reserved name", "is a reserved name"],
			["Update to this commit? [y/N]", "Update to this commit? [y/N]"],
			["Apply these changes? [y/N]", "Apply these changes? [y/N]"],
			["replaced <name>.<key>", "replaced ${name}.${key}"],
			["Add these jobs? [y/N]", "Add these jobs? [y/N]"],
			["This job can read these credentials. Continue? [y/N]", "This job can read these credentials. Continue? [y/N]"],
			["Enter <name> by hand? [y/N]", "by hand? [y/N]"],
			['discarded local changes in the clone of "<source>"', 'discarded local changes in the clone of "${source}"'],
			["credentials below <prefix>/", "credentials below ${"],
			["next: dg job setup <name>", "next: dg job setup ${"],
			["next: dg job restart <name>", "next: dg job restart ${"],
			["next: dg job enable <name>", "next: dg job enable ${"],
			["--setup takes a file path or -", "--setup takes a file path or -"],
			["credential <name> is missing — run dg job setup <job>", "is missing — run dg job setup ${"],
			["source changed", "source changed — run dg job update ${"],
			["source missing", "source missing: ${"],
			["source invalid", "source invalid: ${"],
			["kept state", "kept state:"],
			["stored real path", "stored real path"],
			["build was not run", "build was not run"],
		];
		for (const [documented, inSource] of literals) {
			expect([documented, code.includes(inSource)]).toEqual([documented, true]);
		}
		for (const documented of [
			"consent needs a terminal",
			"holds credentials",
			"is a reserved name",
			"Update to this commit? [y/N]",
			"Apply these changes? [y/N]",
			"replaced <name>.<key>",
		])
			expect([documented, doc.includes(documented)]).toEqual([documented, true]);
	});

	test("each command and option of the documents is declared in jobs.ts", () => {
		const jobs = readRepoFile("pkg", "dg-daemon", "src", "commands", "jobs.ts");
		for (const w of ['.command("setup")', '"--setup <file>"', '"--refresh"', '"--rotate-token"', '"--yes"', '"--name <name>"'])
			expect([w, jobs.includes(w)]).toEqual([w, true]);
		expect(jobs).toContain("--credential <name[=ENV_NAME]>");
		for (const flag of ["--setup", "--refresh", "--rotate-token", "--yes", "--credential"])
			expect([flag, doc.includes(flag)]).toEqual([flag, true]);
	});

	test("the paths, the extensions, the limits and the source type match the source", () => {
		const paths = readRepoFile("pkg", "common", "src", "node", "dg-paths.ts");
		expect(paths).toContain('"sources.json"');
		expect(paths).toContain('path.join(r.dataDir, "jobs")');
		expect(paths).toContain('path.join(r.stateDir, "jobs")');
		for (const w of ["<data>/jobs/sources.json", "<data>/jobs/<source>/", "<state>/jobs/<name>/"]) expect(doc).toContain(w);
		const extensions = /SCRIPT_EXTENSIONS = \[([^\]]+)\]/.exec(code)?.[1] ?? "";
		const names = [...extensions.matchAll(/"(\.\w+)"/g)].map((m) => m[1]);
		expect(names).toEqual([".ts", ".js", ".mjs", ".cjs"]);
		for (const name of names) expect(doc).toContain(`\`${name}\``);
		expect(code).toContain("REFRESH_WINDOW_MS = 60_000");
		expect(code).toContain("SETUP_LIMIT_BYTES = 128 * 1024");
		expect(code).toContain("MAX_ENV_NAME = 64");
		expect(doc).toContain("128 KiB");
		expect(doc).toContain("64 characters at most");
		expect(code).toContain('SOURCE_TYPE = "aws-secretsmanager"');
		expect(doc).toContain("aws-secretsmanager");
		expect(code).toContain('"get-secret-value"');
	});

	test("the keys of the dg block and the reserved names match the source", () => {
		const keys = (name: string) => [...(new RegExp(`${name} = \\[([^\\]]+)\\]`).exec(code)?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]);
		expect(keys("DG_KEYS")).toEqual(["jobs", "credentials", "requires", "build"]);
		expect(keys("FORBIDDEN_JOB_KEYS")).toEqual(["grant", "cwd", "enabled", "passEnv", "credentialEnv"]);
		expect(keys("DETAIL_KEYS")).toEqual(["prompt", "required", "meta", "source", "env"]);
		for (const key of [...keys("FORBIDDEN_JOB_KEYS"), ...keys("DETAIL_KEYS")]) expect([key, doc.includes(`\`${key}\``)]).toEqual([key, true]);
		for (const name of RESERVED_CREDENTIAL_PREFIXES) {
			expect([name, doc.includes(`\`${name}\``)]).toEqual([name, true]);
			expect([name, flat(read(RECORD)).includes(`\`${name}\``)]).toEqual([name, true]);
		}
	});

	test("the refresh and owner-token routes in the record match the source", () => {
		const record = flat(read(RECORD));
		expect(code).toContain("JOB_CREDENTIALS_PATH_PATTERN = /^\\/jobs\\/([^/]+)\\/credentials$/");
		expect(record).toContain("POST /jobs/<name>/credentials");
		for (const operation of ["status", "set", "delete", "ensure-grant", "rotate-grant"]) {
			expect([operation, code.includes(`"${operation}"`)]).toEqual([operation, true]);
			expect([operation, record.includes(`\`${operation}\``)]).toEqual([operation, true]);
		}
		expect(code).toContain('refresh: ["operation", "name", "job"]');
		expect(record).toContain("`refresh`");
	});
});

describe("the move to a job in docs/channel-review.md", () => {
	const doc = flat(read(CHANGED[2]));
	const exportSource = readRepoFile("pkg", "skills-cli", "src", "channel-review", "export.ts");

	test("gives the command, the path and the refusal rule from export.ts", () => {
		expect(doc).toContain("## Move to a job");
		expect(doc).toContain("`dg-skills channel-review export --env <env> --label <label>`");
		expect(doc).toContain("`<state>/jobs/<label>/import.json`");
		expect(doc).toContain("`channel-review export:`");
		expect(doc).toContain("when the old daemon of that env runs");
		expect(exportSource).toContain('const PREFIX = "channel-review export:"');
		expect(exportSource).toContain('"import.json"');
		expect(exportSource).toContain("daemon is running");
		const cli = readRepoFile("pkg", "skills-cli", "src", "channel-review", "cli.ts");
		expect(cli).toContain('"--label <label>"');
		expect(cli).toContain('.command("export")');
	});
});

describe("the job sources record", () => {
	const adr = read(RECORD);

	test("exists with the template headings, a Date header, Accepted and one mermaid block", () => {
		for (const h of ADR_SECTIONS) expect(adr).toMatch(new RegExp(`^## ${h}$`, "m"));
		expect(adr).toMatch(/^# Job sources and credentials$/m);
		expect(adr).toMatch(/^Status: Accepted$/m);
		expect(adr).toMatch(/^Date: \d{4}-\d{2}-\d{2}$/m);
		expect(adr).toMatch(/^Topic: Platform$/m);
		expect(count(adr, "```mermaid")).toBe(1);
		expect(heading(adr, "Diagram")).toContain("```mermaid");
	});

	test("the toc holds one link to it, after the jobs record, in 160 columns", () => {
		const toc = read(TOC);
		expect(count(toc, `(${RECORD_FILE})`)).toBe(1);
		const lines = heading(toc, "Platform").split("\n");
		const entries = lines.filter((l) => l.startsWith("- ["));
		const at = entries.findIndex((l) => l.includes(`(${RECORD_FILE})`));
		expect(at).toBe(entries.findIndex((l) => l.includes("(0049-jobs.md)")) + 1);
		expect(entries[at]).toMatch(/^- \[0052 — .+\]\(0052-job-sources-and-credentials\.md\)$/);
		for (const line of lines) expect([...line].length).toBeLessThanOrEqual(160);
		expect(existsSync(join(REPO_ROOT, RECORD))).toBe(true);
	});

	test("links the jobs record and ADR 0043 and adds refresh to service API v1", () => {
		const text = flat(adr);
		expect(text).toContain("](0049-jobs.md)");
		expect(text).toContain("](0043-outside-services.md)");
		expect(text).toContain("This record adds it to v1");
	});

	test("ADR 0043 gets the one dated line after the line of the noun job", () => {
		const lines = read(ADR_0043).split("\n");
		const at = lines.findIndex((l) => l.startsWith("Date: "));
		expect(lines[at + 4]).toBe(
			"Amended 2026-11-20: service API v1 has the operation refresh; see [ADR 0052](0052-job-sources-and-credentials.md).",
		);
		expect(lines[at + 5]).toBe("");
	});

	test("holds the same phrases as the jobs document", () => {
		const record = flat(adr);
		const doc = flat(read(JOBS));
		for (const phrase of SHARED_PHRASES) {
			expect([phrase, record.includes(phrase)]).toEqual([phrase, true]);
			expect([phrase, doc.includes(phrase)]).toEqual([phrase, true]);
		}
	});

	test("holds the daemon boundary and the adoption, route and wizard rules", () => {
		const text = flat(adr);
		for (const w of [
			"`aws-secretsmanager`",
			"the owner token already lists each session token",
			"`ensure-grant`",
			"`--setup` takes a file path or `-` for stdin and never JSON text",
			"`--refresh`",
			"reads `<data>/jobs/sources.json` only for that operation",
			"starts an `aws` process only for `refresh`",
			"A prefix that already holds credentials needs one adoption question at a terminal",
		])
			expect([w, text.includes(w)]).toEqual([w, true]);
	});
});

describe("SECURITY.md paragraph on job sources", () => {
	const para = read(SECURITY).split(/\n\s*\n/).find((p) => p.includes("--yes")) ?? "";
	const text = flat(para);

	test("holds the cost of --yes and each trust rule, with no passEnv", () => {
		expect(para).not.toBe("");
		expect(para).not.toContain("passEnv");
		for (const w of [
			"runs with the rights of the user",
			"pins a full commit id",
			"shows the request before it writes",
			"each `dg job update` to a new commit shows the change and asks again",
			"can run the code of that repository with no question",
			"The owner token can write the credentials of a job",
			"because a command line is visible to other processes",
			"A repository can name an AWS secret",
			"A local job needs no consent",
			"A grant is not a sandbox",
			"one job of a source can read the credentials of the other jobs of that source",
			"cannot change the argv of that fetch",
			"one fetch for one credential in 60 s",
		])
			expect([w, text.includes(w)]).toEqual([w, true]);
	});

	test("follows the paragraph on supervised services", () => {
		const paragraphs = read(SECURITY).split(/\n\s*\n/);
		const at = paragraphs.findIndex((p) => p.includes("--yes"));
		expect(paragraphs[at - 1]).toContain("A supervised service may set `envFile`");
	});
});

describe("docs/service-api.md grant setup", () => {
	const section = flat(heading(read(SERVICE_API), "Set up a grant"));

	test("uses dg job enable and keeps the word SERVICE in the key names", () => {
		expect(section).toContain("`dg job enable <name>`");
		expect(section).toContain("The key names keep the word `SERVICE`");
		expect(section).not.toContain("dg-agent start");
		expect(section).not.toContain("dg-skills credentials grant");
	});
});

describe("jobs SKILL.md", () => {
	const skill = read(SKILL);
	const section = heading(skill, "Job verbs");

	test("lists the new commands in the dg-daemon form", () => {
		for (const line of [
			"dg-daemon job add <url>",
			"dg-daemon job add <path>",
			"dg-daemon job setup <name>",
			"dg-daemon job setup <name> --refresh",
			"dg-daemon job enable <name> --setup <file|->",
		])
			expect([line, section.includes(line)]).toEqual([line, true]);
		expect(section).not.toMatch(/\bdg job\b/);
	});

	test("does not answer the consent question and adds no --yes on its own", () => {
		const text = flat(section);
		expect(text).toContain("does not answer the consent question and does not add `--yes` on its own");
		expect(text).toContain("the human runs it, or names the repository for which the agent can use `--yes`");
		expect(text).toContain("needs one `y` at a terminal, also for an agent");
	});
});

describe("changed documents", () => {
	test("each relative link opens an existing file", () => {
		for (const file of [...CHANGED, ADR_0043, TOC, SKILL]) {
			for (const m of read(file).matchAll(/\]\((?!https?:|#|mailto:)([^)\s#]+)(?:#[^)]*)?\)/g))
				expect([file, m[1], existsSync(resolve(REPO_ROOT, dirname(file), m[1]))]).toEqual([file, m[1], true]);
		}
	});
});
