import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { ForwardOnlyVersionError } from "../../common/src/node/sqlite";
import { PW_EXT_MIN_EXTENSION_VERSION } from "../../common/src/pw-ext-format";
import { REPO_ROOT, cells, readRepoFile, section } from "./test-support";

const ADR_DIR = join(REPO_ROOT, "docs", "adr");
const ADR_0038 = "0038-extension-pairing-only.md";
const ADR_0039 = "0039-zero-touch-pairing.md";
const UPGRADE_HEADING = "Upgrading from a release without the pairing popup";
const ADR_HEADINGS = [
	"Context",
	"Decision",
	"Consequences",
	"Alternatives considered",
	"Diagrams",
	"References",
];

function readAdr(name: string): string {
	const path = join(ADR_DIR, name);
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function adrFileFor(prefix: string): string {
	return readdirSync(ADR_DIR).find((name) => name.startsWith(`${prefix}-`)) ?? "";
}

function headingsOf(text: string, level: number): string[] {
	const marker = "#".repeat(level);
	return [...text.matchAll(new RegExp(`^${marker} (.+)$`, "gm"))].map((m) =>
		m[1].trim(),
	);
}

function sectionBody(text: string, heading: string): string {
	const lines = text.split("\n");
	const start = lines.findIndex((line) =>
		/^#{1,6} /.test(line) && line.replace(/^#+ /, "").trim() === heading,
	);
	if (start < 0) return "";
	const level = /^#+/.exec(lines[start])?.[0].length ?? 1;
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => {
		const hashes = /^(#{1,6}) /.exec(line)?.[1].length;
		return hashes !== undefined && hashes <= level;
	});
	return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

const AMENDMENT_HEADING = /^## Amended 2026-11-07\b/;

function splitAmendment(text: string): { original: string; amended: string[] } {
	const lines = text.split("\n");
	const first = lines.findIndex((line) => AMENDMENT_HEADING.test(line));
	if (first < 0) return { original: text, amended: [] };
	const amended: string[] = [];
	let current: string[] | undefined;
	for (const line of lines.slice(first)) {
		if (AMENDMENT_HEADING.test(line)) {
			current = [];
			amended.push("");
		} else if (/^## /.test(line)) {
			current = undefined;
		}
		if (current) {
			current.push(line);
			amended[amended.length - 1] = current.join("\n");
		}
	}
	return { original: lines.slice(0, first).join("\n"), amended };
}

function withoutSections(text: string, headings: RegExp): string {
	const out: string[] = [];
	let skipLevel = 0;
	let fenced = false;
	for (const line of text.split("\n")) {
		if (/^```/.test(line)) fenced = !fenced;
		const hashes = fenced ? undefined : /^(#{1,6}) (.*)$/.exec(line);
		if (hashes && skipLevel > 0 && hashes[1].length <= skipLevel) skipLevel = 0;
		if (hashes && skipLevel === 0 && headings.test(hashes[2])) {
			skipLevel = hashes[1].length;
		}
		if (skipLevel === 0) out.push(line);
	}
	return out.join("\n");
}

function markdownFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((name) => {
		if (name === "node_modules" || name === "fixtures") return [];
		const full = join(dir, name);
		if (statSync(full).isDirectory()) return markdownFiles(full);
		return name.endsWith(".md") ? [full] : [];
	});
}

function sourceFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((name) => {
		if (["node_modules", "__tests__", "dist", ".output", ".wxt"].includes(name))
			return [];
		const full = join(dir, name);
		if (statSync(full).isDirectory()) return sourceFiles(full);
		return /\.(ts|tsx|js|mjs|json)$/.test(name) && !/\.spec\.|\.test\./.test(name)
			? [full]
			: [];
	});
}

async function runHelp(
	args: string[],
): Promise<{ code: number; text: string }> {
	const proc = Bun.spawn(["bun", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: { ...process.env },
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, text: out + err };
}

const AGENT_ENTRY = join(REPO_ROOT, "pkg", "dg-agent", "src", "index.ts");
const SKILLS_ENTRY = join(REPO_ROOT, "pkg", "skills-cli", "src", "index.ts");

describe("ADR 0038 extension-pairing-only", () => {
	const adr = readAdr(ADR_0038);

	test("follows the template headings in order and stays Proposed", () => {
		expect(adr).toMatch(/^# 0038 — .+/m);
		expect(adr).toMatch(/^Status: Proposed$/m);
		expect(adr).toMatch(/^Date: \d{4}-\d{2}-\d{2}$/m);
		const template = readAdr("template.md");
		expect(headingsOf(template, 2)).toEqual(ADR_HEADINGS);
		expect(headingsOf(adr, 2)).toEqual(ADR_HEADINGS);
	});

	test("names the pairing popup and never a bare popup", () => {
		expect(adr).toMatch(/pairing popup/);
		const bare = adr
			.replace(/pairing popup/gi, "")
			.replace(/per-agent popup menu/gi, "")
			.match(/\bpopup\b/gi);
		expect(bare).toBeNull();
	});

	test("holds the decision facts the plan fixes", () => {
		expect(adr).toMatch(/dg-agent pair <code>/);
		expect(adr).toMatch(/storage\.local/);
		expect(adr).toMatch(/Add this tab/);
		expect(adr).toMatch(/\/attach/);
		expect(adr).toMatch(/sequenceDiagram/);
		expect(adr.match(/```mermaid/g)?.length).toBe(1);
		for (const participant of [
			"pkg/extension",
			"pkg/dg-daemon",
			"pkg/dg-agent",
		]) {
			expect(sectionBody(adr, "Diagrams")).toContain(participant);
		}
		expect(sectionBody(adr, "Consequences")).toMatch(/Not done/);
		expect(sectionBody(adr, "Alternatives considered").length).toBeGreaterThan(
			200,
		);
	});

	test("trust-model text matches the lockout and offer limits in the daemon", () => {
		expect(adr).toMatch(/8 outstanding/);
		expect(adr).toMatch(/same-user adversary/);
		expect(adr).toMatch(/<all_urls>/);
		expect(adr).toMatch(/bearer/);
		expect(adr).toMatch(/non-`cli`/);
	});
});

describe("ADR 0039 zero-touch-pairing", () => {
	const adr = readAdr(ADR_0039);

	test("follows the template headings in order and carries a status", () => {
		expect(adr).toMatch(/^# 0039 — .+/m);
		expect(adr).toMatch(/^Status: (Proposed|Accepted)$/m);
		expect(adr).toMatch(/^Date: \d{4}-\d{2}-\d{2}$/m);
		expect(headingsOf(adr, 2)).toEqual(ADR_HEADINGS);
	});

	test("links 0004 and 0038", () => {
		expect(adr).toContain("](0004-loopback-pairing.md)");
		expect(adr).toContain(`](${ADR_0038})`);
	});

	test("states the decision, the trust trade-off and the removed surface", () => {
		expect(adr).toMatch(/session-adopt/);
		expect(adr).toMatch(/daemon:id/);
		expect(adr).toMatch(/Trust this daemon/);
		expect(adr).toMatch(/dismissed:<sessionId>/);
		expect(adr).toMatch(/_chatcode/);
		expect(adr).toMatch(/dg-agent spawn/);
		expect(sectionBody(adr, "Consequences")).toMatch(/trust trade-off/);
		expect(sectionBody(adr, "Consequences")).toMatch(/same user/);
		expect(sectionBody(adr, "Consequences")).toMatch(/proxy that copies the live daemon/);
		expect(sectionBody(adr, "Decision")).toMatch(/POST \/pair\/offer/);
		expect(sectionBody(adr, "Alternatives considered").length).toBeGreaterThan(200);
	});

	test("the diagram is one sequence diagram with the three participants", () => {
		expect(adr.match(/```mermaid/g)?.length).toBe(1);
		const diagram = sectionBody(adr, "Diagrams");
		expect(diagram).toContain("sequenceDiagram");
		for (const participant of ["pkg/dg-agent", "pkg/dg-daemon", "pkg/extension"]) {
			expect(diagram).toContain(participant);
		}
	});

	test("every path the References section names exists in the tree", () => {
		const names = [...sectionBody(adr, "References").matchAll(/`([^`]+)`/g)].map(
			(m) => m[1],
		);
		expect(names.length).toBeGreaterThan(0);
		for (const name of names) {
			expect(existsSync(join(REPO_ROOT, name))).toBe(true);
		}
	});
});

describe("ADR index and amendments", () => {
	const toc = readAdr("toc.md");

	test("toc.md lists 0038 once, after 0037", () => {
		const lines = toc.split("\n");
		const hits = lines.filter((line) => line.includes(ADR_0038));
		expect(hits).toHaveLength(1);
		const at = lines.findIndex((line) => line.includes(ADR_0038));
		const previous = lines.findIndex((line) => line.includes("0037-"));
		expect(previous).toBeGreaterThanOrEqual(0);
		expect(at).toBeGreaterThan(previous);
	});

	test("toc.md lists 0039 once, after 0038", () => {
		const lines = toc.split("\n");
		const hits = lines.filter((line) => line.includes(ADR_0039));
		expect(hits).toHaveLength(1);
		const at = lines.findIndex((line) => line.includes(ADR_0039));
		const previous = lines.findIndex((line) => line.includes(ADR_0038));
		expect(previous).toBeGreaterThanOrEqual(0);
		expect(at).toBeGreaterThan(previous);
	});

	test("0004 and 0038 each carry a Superseded in part link to 0039", () => {
		for (const name of [adrFileFor("0004"), ADR_0038]) {
			expect(readAdr(name)).toMatch(
				/^Superseded in part by \[0039\]\(0039-zero-touch-pairing\.md\)\.$/m,
			);
		}
	});

	test("0004 stays Accepted in the file and in toc.md", () => {
		expect(readAdr(adrFileFor("0004"))).toMatch(/^Status: Accepted$/m);
		const row = toc.split("\n").find((l) => l.includes("0004-")) ?? "";
		expect(row).not.toMatch(/Superseded/i);
	});

	const amended: Array<[string, RegExp[]]> = [
		["0004", [/POST \/pair/, /The extension must acquire a session/]],
		["0031", [/the token sits in the fragment/i, /extension side panel replaces the page/]],
		["0035", [/acts on the active tab/, /Approval in the side panel or a notification/]],
	];

	for (const [prefix, originalAnchors] of amended) {
		test(`${prefix} carries a dated Amended section that names 0038 and keeps its original text`, () => {
			const text = readAdr(adrFileFor(prefix));
			const { original, amended: sections } = splitAmendment(text);
			expect(sections).toHaveLength(1);
			for (const anchor of originalAnchors) expect(original).toMatch(anchor);
			expect(sections[0]).toMatch(/0038/);
		});
	}

	test("0035 says its approval popup and the pairing popup are unrelated", () => {
		const [amendment = ""] = splitAmendment(readAdr(adrFileFor("0035"))).amended;
		expect(amendment).toMatch(/approval popup/);
		expect(amendment).toMatch(/pairing popup/);
		expect(amendment).toMatch(/unrelated/);
	});

	test("0021 and 0037 each reference 0038", () => {
		expect(readAdr(adrFileFor("0021"))).toContain("0038");
		expect(readAdr(adrFileFor("0037"))).toContain("0038");
	});
});

describe("AGENT-INSTALL upgrade section", () => {
	const doc = readRepoFile("docs", "AGENT-INSTALL.md");
	const upgrade = sectionBody(doc, UPGRADE_HEADING);

	test("the section exists with a numbered action list in the required order", () => {
		expect(upgrade.length).toBeGreaterThan(0);
		const steps = [...upgrade.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]);
		expect(steps.length).toBeGreaterThanOrEqual(5);
		const joined = steps.join("\n");
		const order = [
			"dg-skills install",
			"chrome://extensions",
			"popup",
			"dg-agent start",
			"dg-skills pw --ext open",
		].map((needle) => joined.indexOf(needle));
		for (const index of order) expect(index).toBeGreaterThanOrEqual(0);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(upgrade).toMatch(/daemon before the extension/);
		expect(upgrade).toMatch(/restart the daemon/i);
		expect(upgrade).toMatch(/Add this tab/);
	});

	test("the section names no release number outside the refusal text", () => {
		const prose = upgrade
			.split("\n")
			.filter((line) => !/pw --ext/.test(line) || !/update/i.test(line))
			.join("\n");
		expect(prose).not.toMatch(/\bv?\d+\.\d+\.\d+\b/);
	});

	test("the migration table has Removed and Replacement columns and the plan's rows", () => {
		const rows = upgrade.split("\n").filter((l) => l.startsWith("|"));
		expect(cells(rows[0])).toEqual(["Removed", "Replacement"]);
		const removed = rows.slice(2).map((row) => cells(row)[0]);
		for (const needle of [
			"side panel",
			"dashboard page",
			"overwatch page",
			"dg-agent attach",
			"--fresh",
			"GET /start",
			"POST /sessions",
			"GET /sessions",
			"/attach { intent: \"create\" }",
			"POST /pair",
			"DG_SESSION_TOKEN",
			"DG_UNCLAIMED_TTL_MS",
			"waiting",
		]) {
			expect(removed.some((cell) => cell.includes(needle))).toBe(true);
		}
		for (const row of rows.slice(2)) expect(cells(row)).toHaveLength(2);
	});

	test("every Removed row maps to a signature that is gone from the shipped source", () => {
		const rows = upgrade.split("\n").filter((l) => l.startsWith("|")).slice(2);
		const files = ["pkg", "plugins", "scripts"].flatMap((dir) =>
			sourceFiles(join(REPO_ROOT, dir)),
		);
		const corpus = files.map((file) => ({
			file: relative(REPO_ROOT, file),
			text: readFileSync(file, "utf8"),
		}));
		const allPaths = (dir: string): string[] =>
			existsSync(dir)
				? readdirSync(dir).flatMap((name) => {
						const full = join(dir, name);
						return statSync(full).isDirectory()
							? [full, ...allPaths(full)]
							: [full];
					})
				: [];
		const extensionPaths = allPaths(
			join(REPO_ROOT, "pkg", "extension", "entrypoints"),
		).map((file) => relative(REPO_ROOT, file));
		const startBlock = (() => {
			const text = readFileSync(
				join(REPO_ROOT, "pkg", "dg-agent", "src", "main.ts"),
				"utf8",
			);
			const from = text.indexOf('.command("start")');
			const next = text.indexOf(".command(", from + 1);
			return from >= 0 ? text.slice(from, next > from ? next : undefined) : "";
		})();
		type Signature = { scope?: RegExp; pattern: RegExp };
		const signatures: Array<[string, Signature[]]> = [
			["side panel", [{ scope: /^pkg\/extension\//, pattern: /side_panel|sidePanel|sidepanel/i }]],
			["dashboard page", [{ scope: /^pkg\/extension\//, pattern: /dashboard\.html|entrypoints\/dashboard/i }]],
			["overwatch page", [{ scope: /^pkg\/extension\//, pattern: /overwatch\.html|entrypoints\/overwatch/i }]],
			["`dg-agent attach`", [{ pattern: /\.command\("attach"/ }]],
			["--fresh", []],
			["`GET /start`", [{ pattern: /CHAT_START_PATH[^\n]*method === "GET"|method === "GET"[^\n]*CHAT_START_PATH/ }]],
			["`POST /sessions`", [{ pattern: /CHAT_SESSIONS_PATH\b|handleSessionCatalog|pathname === "\/sessions"/ }]],
			["`/attach { intent: \"create\" }`", [{ pattern: /AttachIntent\s*=[^;]*"create"|intent === "create"/ }]],
			["`POST /pair`", [{ pattern: /handlePair\b|pathname === "\/pair"|PAIR_PATH\b/ }]],
			["`DG_SESSION_TOKEN`", [{ scope: /^(?!pkg\/common\/src\/redact)/, pattern: /DG_SESSION_TOKEN/ }]],
			["`DG_UNCLAIMED_TTL_MS`", [{ pattern: /DG_UNCLAIMED_TTL_MS/ }]],
			["waiting presence", [{ pattern: /SessionPresence\s*=[^;]*"waiting"|presence[^\n]*=\s*"waiting"/ }]],
		];
		const removed = rows.map((row) => cells(row)[0]);
		for (const [needle] of signatures) {
			expect(removed.some((cell) => cell.includes(needle))).toBe(
				true,
			);
		}
		const survivors = signatures.flatMap(([name, list]) =>
			list.flatMap(({ scope, pattern }) =>
				corpus
					.filter(({ file }) => !scope || scope.test(file))
					.filter(({ text }) => pattern.test(text))
					.map(({ file }) => `${name} in ${file}`),
			),
		);
		const pageSurvivors = extensionPaths
			.filter((file) => /side-?panel|dashboard|overwatch/i.test(file))
			.map((file) => `removed page entry ${file}`);
		const startSurvivors = /--fresh|\.option\("-s,/.test(startBlock)
			? ["dg-agent start still declares --fresh or -s"]
			: [];
		expect([...survivors, ...pageSurvivors, ...startSurvivors]).toEqual([]);
	});

	test("rollback text quotes the real ForwardOnlyVersionError message and the snapshot name", () => {
		const message = new ForwardOnlyVersionError(0, 0).message
			.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
			.replace(/\b0\b/g, "\\d+");
		expect(upgrade).toMatch(new RegExp(message));
		expect(upgrade).toMatch(/pre-migration-v13-/);
		expect(upgrade).toMatch(/daemon\.db/);
		expect(upgrade).toMatch(/awaiting_agent = 1/);
	});

	test("compatibility paragraphs cover old and new pairings of binaries", () => {
		for (const needle of [
			"GET /sessions?waiting=1",
			"Clear disconnected",
			"dg-daemon sessions clear",
			"Alt+Shift+D",
			"Unpair",
			"/board",
			"/chat",
			"CHANGELOG.md",
		]) {
			expect(upgrade).toContain(needle);
		}
	});

	test("the persistence note replaces the session-storage claim", () => {
		expect(doc).not.toContain("Tokens remain in browser session storage");
		expect(doc).toContain(
			"Pairings are kept in the extension's local storage until you click Unpair or the daemon expires the session",
		);
		expect(doc).not.toMatch(/http:\/\/127\.0\.0\.1:<port>\/start#_chat=/);
	});

	test("the checking section is rewritten for the popup", () => {
		const headings = headingsOf(doc, 3);
		expect(headings).not.toContain("Checking and disconnecting paired sessions");
		const heading = headings.find((h) => /paired sessions/i.test(h)) ?? "";
		const body = sectionBody(doc, heading);
		for (const needle of [
			"Connected",
			"Working",
			"Idle",
			"Unpair",
			"Add this tab",
			"Open chat",
		]) {
			expect(body).toContain(needle);
		}
	});

	test("the extension stays required for the --ext only gate rows", () => {
		expect(doc).toMatch(/--ext only: dg-skills require-extension/);
		const rows = doc
			.split("\n")
			.filter((l) => /^\|.*(chat|overwatch) --ext/.test(l));
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) {
			expect(row).toMatch(/loaded the extension/);
			expect(row).not.toMatch(/optional/i);
		}
	});

	test("commands readers type use dg-skills pw --ext", () => {
		const bare = doc
			.split("\n")
			.filter((line) => /(^|[^-\w])pw --ext/.test(line))
			.filter((line) => !/dg-skills pw --ext/.test(line));
		expect(bare.filter((line) => !/refus|error|asks|text/i.test(line))).toEqual(
			[],
		);
	});

	test("fenced blocks are tagged and carry no hash comments", () => {
		const fences = [...doc.matchAll(/^```(\S*)\n([\s\S]*?)^```/gm)];
		for (const [, tag, body] of fences) {
			expect(tag).not.toBe("");
			expect(body).not.toMatch(/^\s*#(?!!)/m);
		}
	});
});

describe("CLI surface named by the docs", () => {
	test("dg-agent spawn --help shows the command argument and the docs name the -- form", async () => {
		const { code, text } = await runHelp([AGENT_ENTRY, "spawn", "--help"]);
		expect(code).toBe(0);
		expect(text).toMatch(/\[command\.\.\.\]/);
		expect(text).toContain("DG_SESSION_ID");
		const doc = readRepoFile("docs", "AGENT-INSTALL.md");
		expect(doc).toContain("dg-agent spawn -- <command");
		expect(doc).toContain("DG_SESSION_ID");
	});

	test("dg-agent has no pair command", async () => {
		const { text } = await runHelp([AGENT_ENTRY, "--help"]);
		expect(text).not.toMatch(/^\s+pair\b/m);
	});

	test("dg-agent start and overwatch open expose --ext", async () => {
		const start = await runHelp([AGENT_ENTRY, "start", "--help"]);
		expect(start.text).toContain("--ext");
		expect(start.text).not.toMatch(/--fresh|-s, --session/);
		const open = await runHelp([AGENT_ENTRY, "overwatch", "open", "--help"]);
		expect(open.text).toContain("--ext");
	});

	test("dg-skills pw --ext lists every verb and flag the docs name", async () => {
		const { code, text } = await runHelp([SKILLS_ENTRY, "pw", "--ext", "--help"]);
		expect(code).toBe(0);
		const doc = readRepoFile("docs", "AGENT-INSTALL.md");
		for (const verb of ["tabs", "new", "select", "close"]) {
			expect(text).toMatch(new RegExp(`^\\s+${verb}\\b`, "m"));
			expect(doc).toMatch(new RegExp(`dg-skills pw --ext ${verb}\\b|\`${verb}\``));
		}
		expect(text).toContain("--tab");
		expect(doc).toContain("--tab");
	});

	test("every dg-agent subcommand AGENT-INSTALL.md types is registered", async () => {
		const doc = withoutSections(
			readRepoFile("docs", "AGENT-INSTALL.md"),
			new RegExp(UPGRADE_HEADING),
		);
		const subs = new Set(
			[...doc.matchAll(/dg-agent ([a-z][a-z-]*)/g)].map((m) => m[1]),
		);
		expect(subs.has("attach")).toBe(false);
		for (const sub of subs) {
			const { code } = await runHelp([AGENT_ENTRY, sub, "--help"]);
			expect({ sub, code }).toEqual({ sub, code: 0 });
		}
	});
});

describe("stale terms across docs, extension README and skills", () => {
	const STALE =
		/side panel|dashboard page|chat\.html|overwatch\.html|\/start#_chat=|dg-agent attach|Pairing panel|Attach CLI|toolbar icon|1\.11\.2/;
	const roots = [
		join(REPO_ROOT, "docs"),
		join(REPO_ROOT, "pkg", "extension", "README.md"),
		join(REPO_ROOT, "plugins", "dg", "skills"),
	];
	const files = roots.flatMap((root) =>
		root.endsWith(".md") ? [root] : markdownFiles(root),
	);

	function staleLines(label: string, text: string, quoted = false): string[] {
		return text.split("\n").flatMap((line, index) => {
			const prose = quoted ? line.replace(/`[^`\n]*`/g, "") : line;
			return STALE.test(prose) ? [`${label}:${index + 1}: ${line.trim()}`] : [];
		});
	}

	test("no non-ADR doc names a stale term outside the upgrade section", () => {
		const hits = files
			.filter((file) => !file.startsWith(`${ADR_DIR}/`))
			.flatMap((file) => {
				const text = withoutSections(
					readFileSync(file, "utf8"),
					/^Upgrading from a release without the pairing popup$/,
				);
				return staleLines(relative(REPO_ROOT, file), text);
			});
		expect(hits).toEqual([]);
	});

	test("ADR 0038 and every 2026-11-07 amendment name no stale term", () => {
		const adrs = readdirSync(ADR_DIR).filter((name) => name.endsWith(".md"));
		const hits = adrs.flatMap((name) => {
			const text = readAdr(name);
			const scoped =
				name === ADR_0038 ? [text] : splitAmendment(text).amended;
			return scoped.flatMap((body) =>
				staleLines(`docs/adr/${name}`, body, true),
			);
		});
		expect(hits).toEqual([]);
	});

	test("the quoted minimum extension version matches the shipped floor", () => {
		const floor = PW_EXT_MIN_EXTENSION_VERSION.join(".");
		expect(readRepoFile("docs", "AGENT-INSTALL.md")).toContain(
			`${floor} or newer`,
		);
	});

	test("the extension README feature list and test line are current", () => {
		const readme = readRepoFile("pkg", "extension", "README.md");
		expect(readme).toContain(
			"pairing popup, per-agent tab groups, relay to inbox, proto and pw --ext",
		);
		expect(readme).not.toMatch(/unit tests \(\d+ specs\)/);
		expect(readme).toMatch(/bun test\s+# unit tests\s*$/m);
		expect(readme).toContain(UPGRADE_HEADING);
	});

	test("chat.md points to the upgrade section", () => {
		expect(readRepoFile("docs", "chat.md")).toContain("AGENT-INSTALL.md");
	});

	test("browser.md keeps the Options color note and states the agent group title and color rule", () => {
		const text = readRepoFile("docs", "browser.md");
		expect(text).toContain("Group color is set in the extension's Options");
		expect(text).toMatch(/agent identity/);
		expect(text).toMatch(/first unused group color/);
	});

	test("jobs-and-services.md has no dashboard page and names real commands", () => {
		const text = readRepoFile("docs", "jobs-and-services.md");
		expect(text).not.toMatch(/a page for that is the next step/);
		expect(text).toMatch(/dg-daemon job\b/);
		expect(text).not.toMatch(/\/jobs|\/feed/);
	});

	test("the stat skill points at the daemon /board page", () => {
		const text = readRepoFile("plugins", "dg", "skills", "stat", "SKILL.md");
		expect(text).not.toContain("overwatch board in the dg extension");
		expect(text).toMatch(/\/board/);
	});
});

describe("markdown links resolve", () => {
	const roots = [
		join(REPO_ROOT, "docs"),
		join(REPO_ROOT, "pkg", "extension", "README.md"),
		join(REPO_ROOT, "plugins", "dg", "skills"),
	];
	const files = roots.flatMap((root) =>
		root.endsWith(".md") ? [root] : markdownFiles(root),
	);

	test("every relative link points at a file that exists", () => {
		const broken = files.flatMap((file) => {
			const text = readFileSync(file, "utf8")
				.replace(/^\s*```[\s\S]*?^\s*```/gm, "")
				.replace(/`[^`\n]*`/g, "");
			return [...text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)]
				.map((m) => m[1])
				.filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target) && target !== "...")
				.filter((target) => !existsSync(resolve(dirname(file), target)))
				.map((target) => `${relative(REPO_ROOT, file)} -> ${target}`);
		});
		expect(broken).toEqual([]);
	});
});
