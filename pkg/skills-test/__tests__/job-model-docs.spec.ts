import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveRoute } from "../../dg/src/flat";
import { codeRegions, dgCommandForms, runDgHelp } from "./docs-help-kit";
import { ADR_SECTIONS, adrTitle, count, REPO_ROOT, readRepoFile, UNNUMBERED_TITLE } from "./test-support";

const JOBS = "docs/jobs-and-services.md";
const SKILL = "plugins/dg/skills/jobs/SKILL.md";
const TOC = "docs/adr/toc.md";
const ADR_0043 = "docs/adr/0043-outside-services.md";
const ADR_0020 = "docs/adr/0020-one-dg-command.md";
const RECORD_FILE = "0049-jobs.md";
const RECORD = `docs/adr/${RECORD_FILE}`;

const read = (path: string): string => (existsSync(join(REPO_ROOT, path)) ? readRepoFile(path) : "");
const flat = (text: string): string => text.replace(/\s+/g, " ");
const sha256 = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");

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

function tableRows(section: string): string[][] {
	return section
		.split("\n")
		.filter((l) => l.startsWith("|") && !/^\|\s*-/.test(l))
		.slice(1)
		.map((l) =>
			l
				.slice(1, -1)
				.split("|")
				.map((c) => c.trim()),
		);
}

function commandWords(span: string): string[] {
	const words: string[] = [];
	for (const word of span.split(/\s+/)) {
		if (word.startsWith("-") || word.startsWith("<") || word.startsWith('"')) break;
		words.push(word);
	}
	return words;
}

const spans = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);

const SHARED_RULES = [
	"a continuous job that exits with 0 stops",
	"a backoff of 1 s to 60 s",
	"a scheduled job gets no second try after a failure",
	"a run that overlaps the next scheduled time is skipped",
	"one catch-up run follows downtime",
	"config.json.pre-jobs",
	'scheduled job "<old>" is now "<new>"',
	'was "<old>"',
	"the argv of a scheduled job is now plain text in a config file with mode 0600",
	"copy `config.json.pre-jobs` back",
	"the release before refuses the database after the row move",
	"a run that stays alive after a SIGKILL of the daemon can overlap the next run",
	"`dg job start` of a scheduled job, and the alias `run`, need a live daemon",
	"waits 10 s at most",
	"dg never restarts that daemon itself",
	"an explicit `--timeout` is not clamped",
	"the 30 s limit and the 256 KB output limit",
	"a run with no `--feed` has no default limit",
	"asks one time to install the login unit",
	"`enable` with no terminal only prints the hint",
];

describe("docs/jobs-and-services.md job model", () => {
	const doc = read(JOBS);

	test("holds the fixed headings", () => {
		expect(doc).toMatch(/^## Job verbs$/m);
		expect(doc).toMatch(/^## Old and new commands$/m);
	});

	test("names no old program", () => {
		expect(doc).not.toMatch(/\bdg-(skills|agent|daemon)\b/);
	});

	test("the old and new table has one row for each old form", () => {
		const old = tableRows(heading(doc, "Old and new commands")).map((r) => r[0]);
		for (const form of [
			"`dg service add <label> --cwd <path> -- <command>`",
			"`dg service rm <label>`",
			"`dg service status`",
			"`dg service start <label>`",
			"`dg service stop <label>`",
			"`dg service add --autostart`",
			"`dg service add --env-file <path>`",
			"`dg service add --grant <prefix>`",
			"`dg job add --label <name>`",
			'`dg job add --cron "<cron>"`',
			"`dg job add --pass-env <NAME>`",
			"`dg job rm <name>`",
			"`dg job run <name>` and `dg job exec <name>`",
		])
			expect([form, old.includes(form)]).toEqual([form, true]);
		const rows = Object.fromEntries(tableRows(heading(doc, "Old and new commands")).map((r) => [r[0], r[1]]));
		expect(rows["`dg service add --autostart`"]).toContain("`dg job enable <name>`");
		expect(rows["`dg service add --autostart`"]).toContain("`enabled`");
		expect(rows["`dg service add --grant <prefix>`"]).toContain("`grant`");
		expect(rows["`dg service add <label> --cwd <path> -- <command>`"]).toContain("--name <name>");
	});

	test("the verb table gives what each verb changes and whether it needs a live daemon", () => {
		const section = heading(doc, "Job verbs");
		const header = section.split("\n").find((l) => l.startsWith("|")) ?? "";
		expect(header.toLowerCase()).toContain("needs a live daemon");
		const rows = Object.fromEntries(tableRows(section).map((r) => [spans(r[0])[0] ?? "", r.slice(1).join(" | ")]));
		const verbs = [
			"add",
			"update",
			"remove",
			"enable",
			"disable",
			"start",
			"run",
			"stop",
			"restart",
			"list",
			"status",
			"logs",
		];
		const names = Object.keys(rows).map((k) => commandWords(k)[2]);
		expect(names).toEqual(verbs);
		const byVerb = Object.fromEntries(Object.entries(rows).map(([k, v]) => [commandWords(k)[2], v]));
		expect(byVerb.enable).toMatch(/starts the daemon when none runs/);
		expect(byVerb.disable).toMatch(/starts none/);
		for (const v of ["disable", "remove"]) expect(byVerb[v]).toMatch(/a daemon that runs must answer/);
		for (const v of ["restart", "start", "run", "stop"]) expect(byVerb[v]).toMatch(/^[^|]*\| yes/);
		expect(byVerb.logs).toMatch(/\| no$/);
		for (const v of ["list", "status"]) expect(byVerb[v]).toContain("`daemon not running`");
		for (const v of ["enable", "disable"]) expect(byVerb[v]).toMatch(/stored `enabled` state/);
		for (const v of ["start", "stop", "restart"]) expect(byVerb[v]).toMatch(/acts now only/);
		for (const v of ["add", "update", "remove"]) expect(byVerb[v]).toMatch(/definition/);
	});

	test("states the daemon and job restart difference and the stderr home line", () => {
		const text = flat(doc);
		expect(text).toMatch(/`dg daemon restart` restarts the daemon[^.]*`dg job restart <name>` restarts one job/);
		expect(text).toMatch(/each `dg job` verb prints the dg home and the daemon on stderr/i);
	});

	test("states the migration and the rename rule", () => {
		const text = flat(doc);
		expect(text).toMatch(/lower case/);
		expect(text).toMatch(/64 characters at most/);
		expect(text).toMatch(/`-2`/);
		expect(text).toMatch(/`job` when (nothing|no character) is left/);
	});

	test("states the feed rules", () => {
		const text = flat(doc);
		expect(text).toMatch(/`feed` is explicit for a new job and is valid only for a scheduled job/);
		expect(text).toMatch(/alias `--label` or `--cron` get `feed: true`/);
	});

	test("holds each shared rule phrase", () => {
		const text = flat(doc);
		for (const rule of SHARED_RULES) expect([rule, text.includes(rule)]).toEqual([rule, true]);
	});

	test("names the private consumer only as the review bot repository", () => {
		const text = flat(doc);
		expect(text).toContain("the review bot repository");
	});

	test("each dg command in a code block passes its --help form", async () => {
		const forms = [...new Set(dgCommandForms(doc).map((w) => commandWords(w.join(" ")).join(" ")))];
		expect(forms.length).toBeGreaterThan(5);
		for (const form of forms) expect([form, resolveRoute(form.split(" ")[0] ?? "") !== undefined]).toEqual([form, true]);
		const runs = await Promise.all(forms.map(async (f) => [f, (await runDgHelp(f.split(" "))).code] as const));
		expect(runs.filter(([, code]) => code !== 0)).toEqual([]);
	}, 120_000);

	test("each old form of the table passes its --help form", async () => {
		const forms = new Set<string>();
		for (const [old] of tableRows(heading(doc, "Old and new commands")))
			for (const span of spans(old)) {
				const words = commandWords(span);
				if (words[0] === "dg") forms.add(words.slice(1).join(" "));
			}
		expect(forms.size).toBeGreaterThan(5);
		const runs = await Promise.all([...forms].map(async (f) => [f, (await runDgHelp(f.split(" "))).code] as const));
		expect(runs.filter(([, code]) => code !== 0)).toEqual([]);
	}, 120_000);
});

describe("the jobs record", () => {
	const adr = read(RECORD);

	test("exists with the template headings, a Date header and the Accepted status", () => {
		expect(adr).not.toBe("");
		expect(adrTitle(adr)).toMatch(UNNUMBERED_TITLE);
		expect(adr).toMatch(/^Status: Accepted$/m);
		expect(adr).toMatch(/^Date: \d{4}-\d{2}-\d{2}$/m);
		expect(adr).toMatch(/^Topic: Platform$/m);
		for (const h of ADR_SECTIONS)
			expect(adr).toMatch(new RegExp(`^## ${h}$`, "m"));
	});

	test("holds exactly one mermaid block, below the Diagram heading", () => {
		expect(count(adr, "```mermaid")).toBe(1);
		expect(heading(adr, "Diagram")).toContain("```mermaid");
	});

	test("holds each shared rule phrase", () => {
		const text = flat(adr);
		for (const rule of SHARED_RULES) expect([rule, text.includes(rule)]).toEqual([rule, true]);
	});

	test("names the model parts", () => {
		const text = flat(adr);
		for (const w of [
			"`continuous`",
			"`schedule`",
			"`every`",
			"`jobs` table",
			"launcher",
			"`--label`",
			"`--cron`",
			"`--pass-env`",
			"major release",
			"<log>/service-<name>.log",
			"<state>/daemon/services/<name>.pid",
			"DG_SERVICE_",
			"dg-daemon autostart",
			"the review bot repository",
		])
			expect([w, text.includes(w)]).toEqual([w, true]);
	});
});

describe("record links", () => {
	test("the toc lists the record one time, after the 0043 row of Platform, in 160 columns", () => {
		const toc = read(TOC);
		expect(count(toc, `(${RECORD_FILE})`)).toBe(1);
		const entries = heading(toc, "Platform")
			.split("\n")
			.filter((l) => l.startsWith("- ["));
		const at = entries.findIndex((l) => l.includes(`(${RECORD_FILE})`));
		const after = entries.findIndex((l) => l.includes("(0043-outside-services.md)"));
		expect(at).toBe(after + 1);
		expect(entries[at]).toMatch(/^- \[0049 — .+\]\(0049-jobs\.md\)$/);
		expect(read(RECORD)).toMatch(/^Status: Accepted$/m);
		for (const line of heading(toc, "Platform").split("\n")) expect([...line].length).toBeLessThanOrEqual(160);
	});

	test("ADR 0043 keeps its Status line and gets one dated line after the line of slice 7", () => {
		const lines = read(ADR_0043).split("\n");
		expect(lines).toContain("Status: Accepted");
		const at = lines.findIndex((l) => l.startsWith("Date: "));
		expect(lines[at + 1]).toMatch(/^Topic: /);
		expect(lines[at + 2]).toStartWith("Amended 2026-11-18: ");
		expect(lines[at + 3]).toMatch(
			/^Amended \d{4}-\d{2}-\d{2}: the noun is now job; see \[ADR 0049\]\(0049-jobs\.md\)\.$/,
		);
	});

	test("the ADR 0020 amendment points at the record and keeps Status: Accepted", () => {
		const adr = read(ADR_0020);
		expect(adr).toMatch(/^Status: Accepted$/m);
		const amendment = adr.slice(adr.search(/^## Amendment \(/m));
		expect(flat(amendment)).toMatch(/The job model is in \[ADR 0049\]\(0049-jobs\.md\)\./);
	});

	test("each relative link of the changed documents opens a file", () => {
		for (const f of [JOBS, SKILL, RECORD, TOC, ADR_0043, ADR_0020, "README.md", "docs/install.md"])
			for (const m of read(f).matchAll(/\]\((?!https?:|#|mailto:)([^)\s#]+)(?:#[^)]*)?\)/g))
				expect([f, m[1], existsSync(resolve(REPO_ROOT, dirname(f), m[1]))]).toEqual([f, m[1], true]);
	});
});

describe("README.md and docs/install.md", () => {
	test("hold no command of the dg-daemon service group", () => {
		for (const f of ["README.md", "docs/install.md"])
			for (const code of codeRegions(read(f)))
				expect([f, /dg service (add|rm|status|start|stop)\b/.test(code)]).toEqual([f, false]);
		expect(read("docs/install.md")).toContain(
			"`dg: kept <from>; stop the dg daemon, then run dg install again`",
		);
	});

	test("the README jobs link uses the noun job and keeps its path", () => {
		const line = read("README.md")
			.split("\n")
			.find((l) => l.endsWith("](docs/jobs-and-services.md)"));
		expect(line).toBe("- [Jobs](docs/jobs-and-services.md)");
	});
});

describe("jobs SKILL.md", () => {
	const skill = read(SKILL);

	test("keeps the bootstrap fence, the SessionStart fence, the channel-review lines and the frontmatter", () => {
		const fence = (key: string) =>
			skill
				.split("```")
				.filter((_, i) => i % 2 === 1)
				.find((b) => b.includes(key)) ?? "";
		expect(sha256(fence("bootstrap.sh"))).toBe("4269b440256c7284daa4e048ca62f8dca62e9b9c96c2f99af88bc3756859e516");
		expect(sha256(fence('"SessionStart"'))).toBe("d23b524c97aaee81f9bdb4301d441071bf0a6ab7175e1c69503e38deaca78732");
		expect(
			sha256(
				skill
					.split("\n")
					.filter((l) => l.includes("channel-review"))
					.join("\n"),
			),
		).toBe("28ad660b675d8abf866dc2ca24893a038d4884847c7ce8f86c27b0c95b7e2370");
		expect(sha256(/^---\n([\s\S]*?)\n---/.exec(skill)?.[1] ?? "")).toBe(
			"366529cf4700cacdc46254fdfba5e19f94d2dbbd11e937342e41ccab4d433e7a",
		);
	});

	test("has a Job verbs section with the new verbs in the flat dg form", () => {
		const section = heading(skill, "Job verbs");
		expect(skill).toMatch(/^## Job verbs$/m);
		for (const verb of [
			"add",
			"list",
			"status",
			"enable",
			"disable",
			"start",
			"stop",
			"restart",
			"update",
			"remove",
			"logs",
		])
			expect([verb, section.includes(`dg job ${verb}`)]).toEqual([verb, true]);
		for (const flag of ["--name", "--continuous", "--schedule", "--every", "--timeout", "--feed", "--env"])
			expect([flag, section.includes(flag)]).toEqual([flag, true]);
		expect(section).not.toMatch(/\bdg-daemon\b/);
	});

	test("points at Job verbs from one line above the action table", () => {
		const lines = skill.split("\n");
		const table = lines.findIndex((l) => l.startsWith("| Action |"));
		const above = lines.slice(0, table).reverse().find((l) => l.trim() !== "") ?? "";
		expect(above).toContain("[Job verbs](#job-verbs)");
	});

	test("states the gating and the login unit rules", () => {
		const text = flat(skill);
		expect(text).toMatch(
			/`remove`, `disable` and `autostart install\|remove` need a request from the human that names the job or the login unit/,
		);
		expect(text).toMatch(/does not answer the login unit question of `job enable`/);
		expect(text).toContain("`enable` with no terminal only prints the hint");
		expect(text).toMatch(/There is no autostart for the dg daemon itself[^.]*`dg autostart install`/);
		expect(text).toContain("(for example `bot`)");
	});
});
