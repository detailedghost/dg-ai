import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const PROTO_SKILL = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	"plugins",
	"dg",
	"skills",
	"proto",
);

function skillFile(path: string): string {
	const absolute = join(PROTO_SKILL, path);
	expect(existsSync(absolute)).toBe(true);
	return readFileSync(absolute, "utf8");
}

/** Every file under the proto skill, as a path relative to PROTO_SKILL. */
function walkSkillFiles(dir: string = PROTO_SKILL): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const absolute = join(dir, entry);
		if (statSync(absolute).isDirectory()) out.push(...walkSkillFiles(absolute));
		else out.push(relative(PROTO_SKILL, absolute));
	}
	return out;
}

/**
 * Entirely `--ext` flows: every command in these files already requires
 * `--ext`, so their network/install content is the documented extension
 * behavior, not a default-mode leak.
 */
const EXT_ONLY_FILES = new Set([
	"references/extension.md",
	"references/commands.md",
]);

/** `src=`/`href=` attributes, `import(...)`, and `fetch(...)` pointed at a non-local http(s) host. */
const REMOTE_URL_IN_SINK =
	/\b(?:src|href)\s*=\s*["'](?:https?:)?\/\/(?!(?:localhost|127\.0\.0\.1|\[::1\]))[^"']*["']|\bimport\s*\(\s*["']https?:\/\/(?!(?:localhost|127\.0\.0\.1))|\bfetch\(\s*["']https?:\/\/(?!(?:localhost|127\.0\.0\.1))/i;

/** Commands that install software or fetch something other than this project's own localhost. */
const INSTALL_TOKENS: RegExp[] = [
	/(^|[^.\w])curl\s+(-\S|["']?https?:)/i,
	/(^|[^.\w])wget\s+(-\S|["']?https?:)/i,
	/(^|[^.\w])npm\s+(install|ci|exec|create)/i,
	/(^|[^.\w])npx\s/i,
	/(^|[^.\w])bunx\s/i,
	/(^|[^.\w])bun\s+(add|create)\b/i,
	/(^|[^.\w])git\s+clone\b/i,
	/(^|[^.\w])playwright\s+install\b/i,
	/(^|[^.\w])(astro\s+add|create-astro)\b/i,
];

/**
 * Lines allowed to contain an install token, each with the reason it is safe.
 * Keep this list short and specific — a new entry should name one line, not a pattern.
 */
const INSTALL_ALLOWLIST: { substring: string; reason: string }[] = [
	{
		substring: "raw.githubusercontent.com/detailedghost/dg-ai/skills-v1.21.1/pkg/skills-cli/bootstrap.sh",
		reason:
			"the shared dg-skills CLI bootstrap line every skill's SKILL.md carries; checksum-verified by the installer, not a prototype dependency fetch",
	},
];

function isAllowlistedInstallLine(line: string): boolean {
	return INSTALL_ALLOWLIST.some((entry) => line.includes(entry.substring));
}

function isLocalOnlyCurlOrWget(line: string): boolean {
	return (
		/(^|[^.\w])(curl|wget)\s+(-\S|["']?https?:)/i.test(line) &&
		/localhost|127\.0\.0\.1|\[::1\]/.test(line)
	);
}

describe("proto skill", () => {
	test("documents the ordered workflow and explicit same-slug reject loop", () => {
		const skill = skillFile("references/extension.md");
		const orderedPhases = [
			"Understand",
			"Scrape",
			"Generate",
			"Approval",
			"Plant",
			"Claim",
			"Export",
			"Cleanup",
		];
		let prior = -1;
		for (const phase of orderedPhases) {
			const index = skill.indexOf(phase);
			expect(index).toBeGreaterThan(prior);
			prior = index;
		}
		expect(skill).toMatch(
			/Reject[\s\S]*feedback[\s\S]*same slug[\s\S]*re-plant[\s\S]*claim/i,
		);
	});

	test("keeps generation, safety, scratch, and cwd contracts explicit", () => {
		const all = [
			skillFile("references/extension.md"),
			skillFile("references/commands.md"),
			skillFile("references/contracts.md"),
		].join("\n");

		expect(all).toMatch(/default[^.\n]*5/i);
		expect(all).toMatch(/(?:cap|maximum)[^.\n]*5/i);
		expect(all).toMatch(/tokens?[^.\n]*verbatim/i);
		expect(all).toMatch(
			/structurally different|layout.+hierarchy.+affordance/is,
		);
		expect(all).toContain("/tmp/ai/proto/<slug>/plan.json");
		expect(all).toMatch(/target project root/i);
		expect(all).toMatch(/authenticated|private page/i);
		expect(all).toMatch(/explicit\s+confirmation/i);
	});

	test("documents the optional mount selector and browser picker fallback", () => {
		const skill = skillFile("references/extension.md");
		const contracts = skillFile("references/contracts.md");

		expect(skill).toMatch(
			/`mountSelector`[\s\S]{0,300}optional[\s\S]{0,300}omit[\s\S]{0,300}in-browser region picker/i,
		);
		expect(contracts).toMatch(
			/`mountSelector`[\s\S]{0,300}optional[\s\S]{0,300}omit[\s\S]{0,300}in-browser region picker/i,
		);
	});

	test("documents bootstrap, precondition, timeout recovery, and all contracts", () => {
		const commands = skillFile("references/commands.md");
		const contracts = skillFile("references/contracts.md");

		expect(commands).toContain("~/.dg/bin/dg-skills");
		expect(commands).toContain("pkg/skills-cli");
		expect(commands).toContain("bootstrap.sh");
		expect(commands).toContain("browser-batch-installed");
		expect(commands).toMatch(/browser skill.+install/i);
		expect(commands).toMatch(/timed out|times out/i);
		for (const command of [
			"proto --ext scrape",
			"proto --ext plant",
			"proto --ext cleanup",
		]) {
			expect(commands).toContain(command);
		}
		for (const contract of ["StyleGuide", "ProtoPlan", "Verdict"]) {
			expect(contracts).toContain(contract);
		}
	});

	test("uses one-level references that all exist, and valid UI invocation metadata", () => {
		const skill = skillFile("SKILL.md");
		const metadata = skillFile("agents/openai.yaml");
		const links = [...skill.matchAll(/\]\((references\/[^)]+)\)/g)].map(
			(match) => match[1],
		);

		expect([...new Set(links)].sort()).toEqual([
			"references/extension.md",
			"references/local-build.md",
			"references/local-formats.md",
			"references/local-logic.md",
			"references/local-plan.md",
			"references/local-ui.md",
		]);
		for (const link of links) {
			expect(link.split("/")).toHaveLength(2);
			expect(skillFile(link)).not.toContain("TODO");
		}
		expect(metadata).toContain("$proto");
		expect(skill).not.toContain("TODO");
	});
});

describe("proto skill local mode", () => {
	const flagsTable = (skill: string): string[][] =>
		skill
			.split("## Flags")[1]
			?.split("\n## ")[0]
			?.split("\n")
			.filter((line) => line.startsWith("|"))
			.slice(2)
			.map((row) =>
				row
					.replace(/^\||\|$/g, "")
					.split("|")
					.map((cell) => cell.trim()),
			) ?? [];

	test("leads the description with the local mode and makes it the default", () => {
		const skill = skillFile("SKILL.md");
		const description = /^description: (.+)$/m.exec(skill)?.[1] ?? "";
		expect(description.indexOf("local mode")).toBeGreaterThanOrEqual(0);
		expect(description.indexOf("local mode")).toBeLessThan(
			description.indexOf("--ext"),
		);
		expect(skill).not.toMatch(/^requires:/m);
		const ext = flagsTable(skill).find((row) => row[0]?.includes("`--ext`"));
		expect(ext?.[3]).toMatch(/off \(local is the default\)/);
		expect(skill).toMatch(/Plain `\/dg:proto` runs the \*\*local mode\*\*/);
	});

	test("documents every skill flag with its short form and default", () => {
		const rows = flagsTable(skillFile("SKILL.md"));
		const byFlag = (flag: string) => rows.find((row) => row[0]?.includes(flag));
		expect(rows.every((row) => row.length === 4)).toBe(true);
		for (const [flag, short] of [
			["--ext", "none"],
			["--count", "`-n`"],
			["--options", "`-o`"],
			["--continue", "`-c`"],
			["--light", "none"],
			["--publish", "none"],
			["--self-contained", "none"],
			["--series", "none"],
		]) {
			expect(byFlag(flag as string)?.[1]).toBe(short as string);
		}
		expect(byFlag("--count")?.[3]).toMatch(/^5 local, 5 with `--ext`/);
	});

	test("records the behavior change for plain /dg:proto and the --ext command form", () => {
		const skill = skillFile("SKILL.md");
		expect(skill).toMatch(/Behavior change[\s\S]*now runs the local\s+mode/);
		expect(skill).toContain("dg-skills proto --ext plant <plan>");
	});

	test("has no viz dependency and no private or legacy helper paths", () => {
		const files = [
			"SKILL.md",
			"references/local-build.md",
			"references/local-formats.md",
			"references/local-logic.md",
			"references/local-plan.md",
			"references/local-ui.md",
			"assets/README.md",
		];
		for (const file of files) {
			const text = skillFile(file);
			expect(text).not.toMatch(/\/viz\b/);
			expect(text).not.toMatch(/prototype-cli|prototype-ui\b|prototype-serve\b/);
			expect(text).not.toMatch(/\$\(stash|~\/scripts|\.claude\/(skills|plans)/);
		}
	});

	test("the React switcher re-enables its buttons on every submit outcome", () => {
		const source = skillFile("assets/PrototypeSwitcher.tsx");
		expect(source).toContain(".finally(() => setSubmitting(false))");
		expect(source).not.toContain("sendBeacon");
	});

	test("the mounted switchers show a building message and shield their own focus from a host modal's trap", () => {
		const tsx = skillFile("assets/PrototypeSwitcher.tsx");
		const astro = skillFile("assets/PrototypeSwitcher.astro");

		expect(tsx).toContain("Building the next round from");
		expect(astro).toContain("Building the next round from");

		expect(tsx).toContain("onFocus={e => e.stopPropagation()}");
		expect(astro).toMatch(/addEventListener\("focusin",\s*function \(e\) \{ e\.stopPropagation\(\); \}\)/);
	});

	test("ships the copyable switcher and endpoint assets", () => {
		for (const file of [
			"assets/PrototypeSwitcher.tsx",
			"assets/PrototypeSwitcher.astro",
			"assets/prototype-decision-bar.html",
			"assets/prototype-endpoint.ts",
			"assets/prototype-endpoint.next.ts",
			"assets/prototype-endpoint.astro.ts",
			"assets/webmcp-tools.json",
			"assets/dg-icons.js",
			"assets/README.md",
		]) {
			expect(skillFile(file).length).toBeGreaterThan(0);
		}
		const bar = skillFile("assets/prototype-decision-bar.html");
		for (const icon of ["moon", "all", "note", "check", "rework"])
			expect(bar).toContain(`data-icon="${icon}"`);
		expect(bar).toContain('role="menuitemradio" data-w="tablet"');
		expect(bar).toContain("window.dgIcons");
		expect(bar).toContain("Add a note first. A rework needs direction.");
		expect(bar).not.toContain('data-icon="skip"');
		expect(skillFile("assets/dg-icons.js")).toContain("globalThis.dgIcons");
		expect(skillFile("references/local-build.md")).toContain(
			"prototype components",
		);
	});
});

describe("proto skill network egress", () => {
	const files = walkSkillFiles();

	test("default (non --ext) files never point src/href/import/fetch at a remote host", () => {
		const violations: string[] = [];
		for (const file of files) {
			if (EXT_ONLY_FILES.has(file)) continue;
			const text = skillFile(file);
			for (const [lineNumber, line] of text.split("\n").entries()) {
				if (REMOTE_URL_IN_SINK.test(line)) {
					violations.push(`${file}:${lineNumber + 1}: ${line.trim()}`);
				}
			}
		}
		expect(violations).toEqual([]);
	});

	test("default (non --ext) files carry no un-allowlisted install or fetch command", () => {
		const violations: string[] = [];
		for (const file of files) {
			if (EXT_ONLY_FILES.has(file)) continue;
			const text = skillFile(file);
			for (const [lineNumber, line] of text.split("\n").entries()) {
				const hit = INSTALL_TOKENS.some((pattern) => pattern.test(line));
				if (!hit) continue;
				if (isLocalOnlyCurlOrWget(line)) continue;
				if (isAllowlistedInstallLine(line)) continue;
				violations.push(`${file}:${lineNumber + 1}: ${line.trim()}`);
			}
		}
		expect(violations).toEqual([]);
	});

	test("the allowlist only matches lines that are actually present", () => {
		const all = files.map((file) => skillFile(file)).join("\n");
		for (const entry of INSTALL_ALLOWLIST) {
			expect(all).toContain(entry.substring);
		}
	});

	test("says --ext never writes a browser download, and never to install Playwright", () => {
		const skill = skillFile("SKILL.md");
		expect(skill).toMatch(/`--ext`\s+mode never writes a browser\s+download/);
		expect(skill).toMatch(/safe to\s+delete/i);
		expect(skill).toMatch(/never install Playwright or download a browser/i);
		expect(skillFile("references/local-build.md")).toMatch(
			/never install Playwright or download a browser/i,
		);
	});
});
