import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ROUTES } from "../../dg/src/main";
import { codeRegions, dgCommandForms, dgGroups, runDgHelp } from "./docs-help-kit";
import { count, REPO_ROOT, readRepoFile } from "./test-support";

const ADR_PATH = "docs/adr/0020-one-dg-command.md";
const TOC_PATH = "docs/adr/toc.md";
const JOBS = "docs/jobs-and-services.md";
const CHANGED_DOCS = [
	"README.md",
	"docs/install.md",
	"docs/AGENT-INSTALL.md",
	"docs/DEVELOPER.md",
	JOBS,
	"docs/service-api.md",
	"docs/adr/0043-outside-services.md",
	"docs/adr/0049-jobs.md",
	TOC_PATH,
];
const ROUTE_NAMES = Object.keys(ROUTES);
const ALLOWED_FIRST_WORDS = [...ROUTE_NAMES, "completion", "help", "--help", "--version"];
const RETIRED_IN_AMENDMENT = ["review", "service"];

const read = (path: string): string => {
	if (!existsSync(join(REPO_ROOT, path))) throw new Error(`missing file: ${path}`);
	return readRepoFile(path);
};
const source = (...parts: string[]): string => readRepoFile("pkg", ...parts);
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

function amendment(): string {
	const lines = read(ADR_PATH).split("\n");
	const start = lines.findIndex((l) => /^## Amendment \(\d{4}-\d{2}-\d{2}\)$/.test(l));
	if (start < 0) return "";
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((l) => /^## /.test(l));
	return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

function functionBody(text: string, name: string): string {
	const start = text.indexOf(`function ${name}(`);
	const open = start < 0 ? -1 : text.indexOf("{", text.indexOf(")", start));
	if (open < 0) return "";
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === "{") depth++;
		if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
	}
	return "";
}

function sentenceWith(text: string, needle: string): string {
	return flat(text).split(/(?<=[.!?])\s+/).find((s) => s.includes(needle)) ?? "";
}

const startAtLogin = (): string => heading(read(JOBS), "Start at login");

describe("changed files", () => {
	test("each changed file exists", () => {
		for (const f of [...CHANGED_DOCS, ADR_PATH, "docs/service-api.md"]) expect([f, existsSync(join(REPO_ROOT, f))]).toEqual([f, true]);
	});
});

describe("docs-help-kit dgCommandForms", () => {
	test("takes forms from code spans and fences only", () => {
		const text = ["Run dg job list in prose.", "Use `dg job add x` now.", "```bash", "dg autostart status", "```"].join("\n");
		expect(dgCommandForms(text)).toEqual([["autostart", "status"], ["job", "add", "x"]]);
	});

	test("takes a form after a shell operator and ignores dg inside a longer span", () => {
		expect(dgCommandForms("`dg skills list && dg job run x`")).toEqual([["skills", "list"], ["job", "run", "x"]]);
		expect(dgCommandForms("`the next dg start removes it` `<dg home>/x`")).toEqual([]);
	});

	test("ignores dg colon, dg-v, a path or a longer word before dg", () => {
		const text = "`dg: kept /x` `dg-v<x>` `~/.dg/bin/dg install` `mydg job` `.dg job` `dg-skills install`";
		expect(dgCommandForms(text)).toEqual([]);
	});

	test("groups are distinct first words", () => {
		expect(dgGroups("`dg job list` `dg job run` `dg --help`")).toEqual(["job", "--help"]);
	});
});

describe("ADR 0020 amendment", () => {
	const adr = read(ADR_PATH);
	const text = amendment();
	const flatText = flat(text);

	test("is a dated H2 near the end of the file and keeps Status: Accepted", () => {
		expect(text).not.toBe("");
		expect(adr).toMatch(/^Status: Accepted$/m);
		const lines = adr.split("\n");
		const at = lines.findIndex((l) => /^## Amendment \(\d{4}-\d{2}-\d{2}\)$/.test(l));
		const lastH2 = lines.map((l, i) => (/^## /.test(l) ? i : -1)).filter((i) => i >= 0).at(-1);
		const refs = lines.findIndex((l) => l === "## References");
		expect(refs).toBeGreaterThanOrEqual(0);
		expect(at).toBeGreaterThan(refs);
		expect(lastH2).toBe(at);
	});

	test("says channel review leaves dg in a later major release, with no date", () => {
		expect(flatText).toMatch(/channel review leaves dg in a later major release/i);
		expect(sentenceWith(text, "later major release")).not.toMatch(/\b20\d\d\b/);
		expect(flatText).toMatch(/no `dg review` group/);
	});

	test("says a job from the bot repository replaces the review-<env> step", () => {
		expect(flatText).toMatch(/job[^.]*own repository[^.]*replaces[^.]*review-<env>/i);
	});

	test("says dg is a fourth program name and the single binary and dg-v tag are not built", () => {
		expect(flatText).toMatch(/fourth program name/i);
		expect(flatText).toMatch(/single binary[^.]*not built/i);
		expect(flatText).toContain("dg-v<x>");
	});

	test("corrects each accepted statement that is no longer true", () => {
		for (const w of [
			"dg review start",
			"dg-daemon has no command tree of its own",
			"every command lives in pkg/skills-cli",
			"Mermaid",
			"review-<env>",
			"dg service",
			"dg daemon run",
			"a service or job is a stored `dg <command>`",
		])
			expect(flatText).toContain(w);
		expect(flatText).toMatch(/The count of packages is not five\. `dg` adds one package/);
	});

	test("states that dg autostart is the mount of dg-daemon autostart", () => {
		expect(flatText).toMatch(/`dg autostart`[^.]*mount of `dg-daemon autostart`/);
	});

	test("does not supersede, deprecate or link a record above 0049", () => {
		expect(text).not.toMatch(/supersede/i);
		expect(text).not.toMatch(/Deprecated/);
		for (const m of text.matchAll(/\((?:\.\/)?(\d{4})-[^)]*\.md\)/g)) expect(Number(m[1])).toBeLessThanOrEqual(49);
	});

	test("code spans show only dg names of ROUTES, apart from the retired names it corrects", () => {
		const bad = dgCommandForms(text.replace(/`[^`\n]*dg-daemon has no[^`\n]*`/g, "")).filter(
			([name]) => ![...ALLOWED_FIRST_WORDS, ...RETIRED_IN_AMENDMENT].includes(name),
		);
		expect(bad).toEqual([]);
	});
});

describe("docs/adr/toc.md", () => {
	const toc = read(TOC_PATH);
	const adr = read(ADR_PATH);

	test("lists 0020 one time, under Platform", () => {
		expect(count(toc, "(0020-one-dg-command.md)")).toBe(1);
		expect(heading(toc, "Platform")).toContain("(0020-one-dg-command.md)");
		expect(adr).toMatch(/^Topic: Platform$/m);
	});

	test("puts 0020 in Platform before 0043, titled with the H1 and numbered", () => {
		const entries = heading(toc, "Platform").split("\n").filter((l) => l.startsWith("- ["));
		const at = entries.findIndex((l) => l.includes("(0020-one-dg-command.md)"));
		const after = entries.findIndex((l) => l.includes("(0043-outside-services.md)"));
		expect(at).toBeGreaterThanOrEqual(0);
		expect(at).toBeLessThan(after);
		const h1 = /^# (.+)$/m.exec(adr)?.[1] ?? "";
		expect(entries[at]).toBe(`- [0020 — ${h1}](0020-one-dg-command.md)`);
		expect(adr).toMatch(/^Status: Accepted$/m);
	});

	test("each line of Platform has 160 columns at most", () => {
		for (const line of heading(toc, "Platform").split("\n")) expect([line, [...line].length <= 160]).toEqual([line, true]);
	});

	test("keeps the count sixteen historical records", () => {
		expect(toc).toContain("sixteen historical records");
	});
});

describe("ADR 0043 amendment line", () => {
	test("one Amended line follows the Topic line and does not start with Status", () => {
		const lines = read("docs/adr/0043-outside-services.md").split("\n");
		const at = lines.findIndex((l) => l.startsWith("Date: "));
		expect(lines[at + 1]).toMatch(/^Topic: /);
		expect(lines[at + 2]).toMatch(
			/^Amended \d{4}-\d{2}-\d{2}: the daemon also injects DG_SERVICE_STATE_DIR and, when it has one, DG_HOME; see docs\/service-api\.md\.$/,
		);
	});
});

describe("docs/jobs-and-services.md front door", () => {
	const doc = read(JOBS);

	test("uses dg job and dg autostart, and keeps dg-daemon for service and the daemon itself", () => {
		expect(doc).not.toMatch(/dg-daemon job (?!exec)/);
		expect(doc).toMatch(/dg job (add|list|run|enable|disable|rm)/);
		expect(doc).toMatch(/dg autostart (install|remove|status)/);
		for (const w of ["job exec", "service add", "service rm", "dg-daemon service start", "service status --json"])
			expect(doc).toContain(w);
		for (const w of ["dg-daemon start", "dg-daemon stop", "dg-daemon restart", "dg-daemon status"]) expect(doc).toContain(w);
	});

	test("Start at login follows Run, stop and restart, after the four run literals, and is linked from the top", () => {
		const section = doc.indexOf("Start at login");
		expect(section).toBeGreaterThanOrEqual(0);
		const run = doc.indexOf("### Run, stop and restart");
		const login = doc.search(/^#+ Start at login$/m);
		expect(run).toBeGreaterThanOrEqual(0);
		expect(login).toBeGreaterThan(run);
		const link = doc.indexOf("#start-at-login");
		expect(link).toBeGreaterThanOrEqual(0);
		expect(link).toBeLessThan(doc.indexOf("service add"));
		for (const lit of ["service add", "dg-daemon start", "dg-daemon service start", "service status --json"])
			expect(doc.indexOf(lit)).toBeLessThan(login);
	});

	test("Start at login names dg autostart verbs, the unit kind for each OS, WSL steps and the dg-phone unit", () => {
		const s = startAtLogin();
		const kinds = /AutostartKind = ((?:"\w+"(?: \| )?)+)/.exec(source("common", "src", "node", "autostart.ts"))?.[1] ?? "";
		const names = [...kinds.matchAll(/"(\w+)"/g)].map((m) => m[1]);
		expect(names.length).toBe(3);
		expect(s).toContain("dg autostart install");
		expect(s).toMatch(/dg autostart (remove|status)/);
		for (const kind of names) expect(s.toLowerCase()).toContain(kind === "task" ? "task scheduler" : kind);
		expect(s).toMatch(/WSL/);
		expect(s).toMatch(/dg-phone[^.]*different unit/i);
	});

	test("Start at login states the three login-unit rules", () => {
		const s = flat(startAtLogin());
		expect(s).toMatch(/`dg-daemon start` and `dg-daemon restart` start the daemon through the service manager/);
		expect(s).toMatch(/environment of the login unit/);
		expect(s).toMatch(/`dg-daemon stop` and `dg-daemon stop --force` leave the daemon stopped until the next login or the next `dg-daemon start`/);
	});

	test("Start at login states the PATH, envFile, passEnv, win32, XDG, 90 s, wslpath and exit 78 rules", () => {
		const s = flat(startAtLogin());
		expect(s).toMatch(/minimal `PATH`/);
		expect(s).toMatch(/`PATH` in its `envFile`/);
		expect(s).toMatch(/`envFile` values and grants, not `passEnv` values/);
		expect(s).toMatch(/fails on win32 with `DG_HOME` set/);
		expect(s).toMatch(/`XDG_\*_HOME`/);
		expect(s).toMatch(/a job still gets `DG_HOME` only/);
		expect(s).toMatch(/90 s/);
		expect(s).toContain("wslpath");
		expect(s).toContain("schtasks.exe");
		expect(s).toMatch(/launchd and the Windows task start the daemon again after exit 78/);
	});

	test("the three sentences on the login path are worded as planned", () => {
		expect(doc).toMatch(/Without a login unit, nothing starts the daemon at login/);
		expect(sentenceWith(doc, "The new daemon has the environment of the")).toContain("with no login unit");
		expect(doc).toMatch(/restart[^.]*(only|just)[^.]*autostart/i);
	});

	test("the key sentence names DG_HOME and DG_SERVICE_STATE_DIR and gives no count", () => {
		const s = sentenceWith(doc, "The daemon injects");
		expect(s).toContain("DG_HOME");
		expect(s).toContain("DG_SERVICE_STATE_DIR");
	});
});

describe("docs/service-api.md injected keys", () => {
	const doc = read("docs/service-api.md");
	const launcher = source("dg-daemon", "src", "jobs", "launcher.ts");
	const body = functionBody(launcher, "buildJobEnv");
	const keys = [...new Set([...body.matchAll(/\b(DG_[A-Z_]+)\b/g)].map((m) => m[1]))];

	test("finds the keys that buildJobEnv assigns", () => {
		expect(keys.length).toBeGreaterThanOrEqual(6);
		expect(keys).toContain("DG_CREDENTIAL_GRANT_FILE");
		expect(keys).toContain("DG_SERVICE_STATE_DIR");
		expect(keys).toContain("DG_HOME");
	});

	test("names each key and gives no count of keys", () => {
		for (const k of keys) expect([k, doc.includes(k)]).toEqual([k, true]);
		for (const file of [doc, read(JOBS)])
			expect(file).not.toMatch(/\b(\d+|two|three|four|five|six|seven|eight|nine|ten) (injected )?(DG_ )?keys\b/i);
	});

	test("describes the state folder and the conditional DG_HOME", () => {
		const row = doc.split("\n").find((l) => l.startsWith("| `DG_SERVICE_STATE_DIR`")) ?? "";
		expect(row).toContain("<state>/jobs/<label>/");
		expect(flat(doc)).toMatch(/0700/);
		expect(flat(doc)).toMatch(/`service rm` does not remove/);
		const home = doc.split("\n").find((l) => l.startsWith("| `DG_HOME`")) ?? "";
		expect(home).toMatch(/only when/i);
		expect(flat(doc)).toMatch(/same dg home/);
	});
});

describe("docs/install.md", () => {
	const doc = read("docs/install.md");
	const layoutSrc = source("common", "src", "node", "layout.ts");

	test("layout table gains job sources and job state, with the two folders below it", () => {
		const rows = doc.split("\n");
		expect(rows.find((l) => l.startsWith("| Data:")) ?? "").toContain("job sources");
		expect(rows.find((l) => l.startsWith("| State:")) ?? "").toContain("job state");
		expect(doc).toMatch(/`<data>\/jobs`[^.]*`<state>\/jobs`/);
	});

	test("gives the two-used message from its source, the remedy and exit 78", () => {
		expect(layoutSrc).toContain("two daemon folders hold data");
		expect(doc).toContain("two daemon folders hold data");
		const text = flat(doc);
		expect(text).toMatch(/move `<state>\/daemon` to a different name/i);
		expect(text).toMatch(/dg-daemon serve[^.]*exits? 78/);
		expect(text).toMatch(/systemd unit does not start it again/);
		expect(text).toMatch(/dg merges nothing/);
	});

	test("message table has the set-aside row from its source", () => {
		expect(source("common", "src", "node", "layout-work.ts")).toContain("dg copied no file from it");
		expect(doc).toContain("dg: set aside <dest> as <aside>; dg copied no file from it, and dg-skills clean keeps it");
	});

	test("documents the dg launcher result", () => {
		expect(source("skills-cli", "src", "install", "shims.ts")).toContain("it is not a dg launcher");
		expect(source("skills-cli", "src", "doctor", "shared.ts")).toContain('"dg-launcher"');
		expect(doc).toContain("dg: kept <path>; it is not a dg launcher.");
		expect(doc).toContain("dg-launcher");
		expect(flat(doc)).toMatch(/launcher[^.]*first `dg-skills install` or bootstrap of the new release/);
		expect(doc).not.toMatch(/clean[^.\n]*launcher folder/i);
	});

	test("lists dg completion", () => {
		expect(doc).toContain("dg completion <shell>");
	});

	test("says dg writes no dg file into the legacy folder and keeps three names there", () => {
		expect(flat(doc)).toMatch(/dg writes no `dg` file into the legacy `~\/\.dg\/bin` folder/);
		expect(flat(doc)).toMatch(/`~\/\.dg\/bin` keeps small launchers for `dg-skills`, `dg-agent` and `dg-daemon`/);
	});
});

describe("README.md dg table", () => {
	const readme = read("README.md");
	const lines = readme.split("\n");
	const rows = lines.filter((l) => /^\| `dg (\w+)` \|/.test(l));

	test("has one table of the nine names after the install paragraph and before the skills table", () => {
		expect(rows.length).toBe(ROUTE_NAMES.length);
		const at = lines.indexOf(rows[0]);
		expect(at).toBeGreaterThan(lines.findIndex((l) => l === "## Install"));
		expect(at).toBeLessThan(lines.findIndex((l) => l.startsWith("| Skill | Use | Guide |")));
		let top = at;
		while (lines[top - 1]?.startsWith("|")) top--;
		const above = lines.slice(0, top).reverse().find((l) => l.trim() !== "") ?? "";
		const install = heading(readme, "Install");
		expect(install).toContain(above);
		expect(above.startsWith("|")).toBe(false);
	});

	test("each target cell equals the ROUTES program and command", () => {
		const table = rows.map((l) => l.split("|").map((c) => c.trim()).filter(Boolean));
		for (const cells of table) expect(cells.length).toBe(2);
		const byName = Object.fromEntries(table.map(([n, t]) => [n.replace(/`/g, "").replace(/^dg /, ""), t.replace(/`/g, "")]));
		const expected = Object.fromEntries(
			Object.entries(ROUTES).map(([name, r]) => [name, [r.program, ...r.command].join(" ")]),
		);
		expect(byName).toEqual(expected);
	});

	test("stays clear of the jobs bullet pair and holds no review or viz code span", () => {
		const bullet = lines.indexOf("- [Service API v1 (provisional)](docs/service-api.md)");
		expect(lines.slice(bullet - 3, bullet + 3).join("\n")).not.toContain("| `dg job` |");
		for (const f of ["README.md", "docs/install.md"])
			expect(read(f)).not.toMatch(/`(review|viz)`/);
	});
});

describe("docs/DEVELOPER.md", () => {
	const doc = read("docs/DEVELOPER.md");

	test("lists pkg/dg in the layout and the skills-blt row, with a Per-Package entry", () => {
		expect(heading(doc, "Repository Layout")).toMatch(/^ {2}dg\/ /m);
		expect(doc.split("\n").find((l) => l.startsWith("| `skills-blt`")) ?? "").toContain("dg,");
		expect(doc).toMatch(/^### pkg\/dg\b/m);
		expect(flat(doc)).toMatch(/`dg` mounts the three command trees/);
	});

	test("states the stamp and the 1.0.0 version of pkg/dg next to the @dg/common sentence", () => {
		const text = doc.split("\n");
		const at = text.findIndex((l) => l.startsWith("`@dg/common` stays at 1.0.0"));
		expect(at).toBeGreaterThan(0);
		expect(text.slice(at, at + 4).join(" ")).toMatch(/`dg` reports the stamp of the launcher[^.]*pkg\/dg stays at `?1\.0\.0/);
	});

	test("one sentence on DG_PATH_FENCE sits below Meaningful tests", () => {
		expect(heading(doc, "Meaningful tests")).toContain("DG_PATH_FENCE");
	});
});

describe("launcher lists", () => {
	const files = Bun.spawnSync(["git", "ls-files", "README.md", "docs"], { cwd: REPO_ROOT })
		.stdout.toString()
		.split("\n")
		.filter((f) => f.endsWith(".md") && !f.startsWith("docs/adr/"));
	const name = "`?dg-(?:skills|agent|daemon)`?";
	const sep = "(?:, and |, | and )";
	const list = new RegExp(`${name}${sep}${name}${sep}${name}`, "g");
	const dgBefore = /(?<![\w.\/~-])`?dg`?(?:, | and )$/;
	const dgAfter = /^(?:, and |, | and )`?dg`?(?![\w:-])/;
	const OLD_COMPILED_SENTENCE = "replaces the compiled `dg-skills`, `dg-agent` and `dg-daemon` files with launchers";
	const PACKAGE_SET_SENTENCE = "A release ships four things as one matched set";

	test("no sentence lists dg-skills, dg-agent and dg-daemon as launchers without dg", () => {
		const offenders: string[] = [];
		for (const f of files)
			for (const para of readRepoFile(f).split(/\n\s*\n/)) {
				if (para.includes("~/.dg/bin")) continue;
				for (const s of flat(para).split(/(?<=[.!?])\s+(?=[A-Z`])/)) {
					if (s.includes(PACKAGE_SET_SENTENCE) || s.includes(OLD_COMPILED_SENTENCE)) continue;
					for (const m of s.matchAll(list)) {
						const names = new Set(m[0].match(/dg-(skills|agent|daemon)/g));
						const end = (m.index ?? 0) + m[0].length;
						const withDg = dgBefore.test(s.slice(0, m.index)) || dgAfter.test(s.slice(end));
						if (names.size === 3 && !withDg) offenders.push(`${f}: ${s}`);
					}
				}
			}
		expect(offenders).toEqual([]);
	});
});

describe("changed documents", () => {
	test("each relative link opens an existing file", () => {
		for (const f of [...CHANGED_DOCS, ADR_PATH]) {
			const text = f === ADR_PATH ? amendment() : read(f);
			expect(text).not.toBe("");
			for (const m of text.matchAll(/\]\((?!https?:|#|mailto:)([^)\s#]+)(?:#[^)]*)?\)/g))
				expect([f, m[1], existsSync(resolve(REPO_ROOT, dirname(f), m[1]))]).toEqual([f, m[1], true]);
		}
	});

	const shown = (): Array<[string, string[][]]> => [
		...CHANGED_DOCS.map((f): [string, string[][]] => [f, dgCommandForms(read(f))]),
		[`${ADR_PATH} amendment`, dgCommandForms(amendment())],
	];

	test("each dg name in a code span or fence is a ROUTES name", () => {
		const bad = shown().flatMap(([f, forms]) =>
			forms
				.map((w) => w[0])
				.filter((name) => !ALLOWED_FIRST_WORDS.includes(name) && !(f.includes("amendment") && RETIRED_IN_AMENDMENT.includes(name)))
				.map((name) => `${f}: dg ${name}`),
		);
		expect(bad).toEqual([]);
	});

	test("shows at least one dg group in the jobs document and the README", () => {
		expect(dgGroups(read(JOBS))).toEqual(expect.arrayContaining(["job", "autostart"]));
		expect(codeRegions(read("README.md")).join("\n")).toContain("dg job");
	});

	test("bun pkg/dg/src/index.ts <group> --help exits 0 for each group a document shows", async () => {
		const groups = [...new Set(CHANGED_DOCS.flatMap((f) => dgGroups(read(f))).filter((g) => ROUTE_NAMES.includes(g)))];
		expect(groups.length).toBeGreaterThan(0);
		const runs = await Promise.all(groups.map(async (g) => [g, (await runDgHelp([g])).code] as const));
		expect(runs.filter(([, code]) => code !== 0)).toEqual([]);
	}, 60_000);
});
