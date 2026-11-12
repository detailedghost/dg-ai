import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowRulesIn, groupReport, runnableFix } from "../src/doctor/groups";
import { addAllowRules, KEY, render, runTui, splitKeys, type TuiDeps } from "../src/doctor/tui";
import type { CheckReport, DoctorReport } from "../src/doctor/types";

const check = (id: string, status: CheckReport["status"], detail: string, fix: string | null = null): CheckReport => ({
	id,
	status,
	detail,
	fix,
});

const DAEMON = "dg-agent start";

function report(): DoctorReport {
	return {
		ok: false,
		items: [
			{
				item: "shared",
				checks: [check("scratch-root", "ok", "writable"), check("version-match", "warn", "plugin is older", "claude plugin update dg@detailedghost")],
			},
			{
				item: "inbox",
				checks: [
					check("daemon", "fail", "dg-daemon is not answering", DAEMON),
					check("allow-rule", "warn", "no allow rule for inbox", "Bash(dg-skills inbox:*)"),
					check("extension-paired", "info", "not paired"),
				],
			},
			{
				item: "db",
				checks: [
					check("daemon", "fail", "dg-daemon is not answering", DAEMON),
					check("allow-rule", "warn", "no allow rule for db", "Bash(dg-skills db:*)"),
					check("tool-git", "ok", "git 2.56"),
				],
			},
		],
	};
}

describe("groupReport", () => {
	test("puts failures first, merges a shared fix, folds allow rules, and collapses info and ok", () => {
		const groups = groupReport(report());
		expect(groups.map((g) => [g.status, g.title])).toEqual([
			["fail", "daemon (2)"],
			["warn", "shared: plugin is older"],
			["warn", "allow rules (2)"],
			["info", "1 info"],
			["ok", "2 passed"],
		]);
		expect(groups[0]?.action).toEqual({ kind: "run", argv: ["dg-agent", "start"] });
		expect(groups[1]?.action).toBeNull();
		expect(groups[2]?.action).toEqual({
			kind: "allow-rule",
			rules: ["Bash(dg-skills inbox:*)", "Bash(dg-skills db:*)"],
		});
	});
});

describe("group titles", () => {
	const two = (a: CheckReport, b: CheckReport): DoctorReport => ({
		ok: false,
		items: [
			{ item: "one", checks: [a] },
			{ item: "two", checks: [b] },
		],
	});

	test("checks with different ids and one detail are named by the detail", () => {
		const [group] = groupReport(
			two(check("credential-a", "warn", "daemon is down", DAEMON), check("credential-b", "warn", "daemon is down", DAEMON)),
		);
		expect(group?.title).toBe("daemon is down (2)");
	});

	test("checks with different ids and details are counted", () => {
		const [group] = groupReport(two(check("a", "warn", "x", DAEMON), check("b", "warn", "y", DAEMON)));
		expect(group?.title).toBe("2 checks share one fix");
	});
});

describe("runnableFix", () => {
	test.each([
		["dg-agent start", ["dg-agent", "start"]],
		["dg-skills channel-review setup", ["dg-skills", "channel-review", "setup"]],
		["dg-skills doctor jot --json", ["dg-skills", "doctor", "jot", "--json"]],
	])("runs %s", (fix, argv) => {
		expect(runnableFix(fix)).toEqual(argv);
	});

	test.each([
		"claude plugin update dg@detailedghost",
		"sudo apt-get install -y git",
		"dg-skills install; rm -rf ~",
		"dg-skills credentials set 'x y'",
		"jq . ~/.claude/settings.json",
	])("does not run %s", (fix) => {
		expect(runnableFix(fix)).toBeNull();
	});
});

type Fake = TuiDeps & { screens: string[]; ran: string[][]; added: string[][]; reruns: number };

function fake(keys: string[], next: DoctorReport = report()): Fake {
	const value: Fake = {
		screens: [],
		ran: [],
		added: [],
		reruns: 0,
		keys: (async function* () {
			yield* keys;
		})(),
		write: (text) => value.screens.push(text),
		rerun: async () => {
			value.reruns++;
			return next;
		},
		runCommand: async (argv) => {
			value.ran.push(argv);
			return 0;
		},
		addAllowRules: async (rules) => {
			value.added.push(rules);
		},
		size: () => ({ rows: 40, columns: 200 }),
	};
	return value;
}

describe("runTui", () => {
	test("q quits at once and changes nothing", async () => {
		const d = fake(["q"]);
		await runTui(report(), d);
		expect(d.ran).toEqual([]);
		expect(d.screens[0]).toContain("> ❌ daemon (2)    enter: dg-agent start");
		expect(d.screens[0]).toContain("↑↓ move");
	});

	test("right expands a group and shows each item and the fix; left collapses it", async () => {
		const d = fake([KEY.right, KEY.left, "q"]);
		await runTui(report(), d);
		expect(d.screens[1]).toContain("inbox · daemon: dg-daemon is not answering");
		expect(d.screens[1]).toContain("Fix: dg-agent start");
		expect(d.screens[2]).not.toContain("inbox · daemon");
	});

	test("enter then y runs the fix and checks again", async () => {
		const d = fake([KEY.enter, "y", "x", "q"]);
		await runTui(report(), d);
		expect(d.screens[1]).toContain("Run dg-agent start? [y/N]");
		expect(d.ran).toEqual([["dg-agent", "start"]]);
		expect(d.reruns).toBe(1);
		expect(d.screens.at(-1)).toContain("dg-agent start exited 0.");
	});

	test("after a fix runs, its output stays until a key press", async () => {
		const d = fake([KEY.enter, "y", "x", "q"]);
		await runTui(report(), d);
		expect(d.screens.some((screen) => screen.includes("dg-agent start exited 0. Press any key to go back to the list."))).toBe(true);
		expect(d.reruns).toBe(1);
	});

	test("enter on the allow-rules row opens it so the rules show before the question", async () => {
		const d = fake([KEY.down, KEY.down, KEY.enter, "n", "q"]);
		await runTui(report(), d);
		const question = d.screens.find((screen) => screen.includes("allow rules listed above")) ?? "";
		expect(question).toContain("Bash(dg-skills inbox:*)");
	});

	test("enter then any other key skips the fix", async () => {
		const d = fake([KEY.enter, "n", "q"]);
		await runTui(report(), d);
		expect(d.ran).toEqual([]);
		expect(d.reruns).toBe(0);
		expect(d.screens.at(-1)).toContain("Skipped.");
	});

	test("a text-only fix asks nothing and tells the user to run it", async () => {
		const d = fake([KEY.down, KEY.enter, "q"]);
		await runTui(report(), d);
		expect(d.ran).toEqual([]);
		expect(d.screens.at(-1)).toContain("Run this yourself: claude plugin update dg@detailedghost");
	});

	test("the allow-rules row adds every rule after one yes", async () => {
		const d = fake([KEY.down, KEY.down, KEY.enter, "y", "q"]);
		await runTui(report(), d);
		expect(d.added).toEqual([["Bash(dg-skills inbox:*)", "Bash(dg-skills db:*)"]]);
		expect(d.screens.at(-1)).toContain("Added 2 allow rules.");
	});

	test("returns the report from the last check, for the exit code", async () => {
		const fixed: DoctorReport = { ok: true, items: [{ item: "shared", checks: [check("x", "ok", "fine")] }] };
		const d = fake([KEY.enter, "y", "x", "q"], fixed);
		expect(await runTui(report(), d)).toBe(fixed);
	});

	test("the cursor stays inside the rows", async () => {
		const d = fake([KEY.up, ...Array(9).fill(KEY.down), "q"]);
		await runTui(report(), d);
		expect(d.screens.at(-1)).toContain("> ✅ 2 passed");
	});

	test("input that ends acts like q", async () => {
		const d = fake([]);
		await runTui(report(), d);
		expect(d.screens).toHaveLength(1);
	});
});

describe("render", () => {
	test("marks only the row under the cursor", () => {
		const screen = render({ groups: groupReport(report()), cursor: 2, open: new Set(), status: "" }, { rows: 40, columns: 200 });
		expect(screen.match(/^> /gm)).toHaveLength(1);
		expect(screen).toContain("> ⚠️ allow rules (2)    enter: add all to ~/.claude/settings.json");
	});
});

describe("render in a small terminal", () => {
	const many: DoctorReport = {
		ok: false,
		items: Array.from({ length: 30 }, (_, index) => ({
			item: `item-${index}`,
			checks: [check("allow-rule", "warn", `no allow rule for item-${index}`, `Bash(dg-skills item-${index}:*)`)],
		})),
	};

	test("caps an expanded row and names how many are hidden", () => {
		const groups = groupReport(many);
		const screen = render({ groups, cursor: 0, open: new Set([groups[0]?.key ?? ""]), status: "" }, { rows: 12, columns: 200 });
		const lines = screen.replace("\u001b[2J\u001b[H", "").trimEnd().split("\n");
		expect(lines.length).toBeLessThanOrEqual(12);
		expect(screen).toContain("… 23 more; dg-skills doctor --plain lists all");
	});

	test("counts wrapped rule rows and always shows the hidden notice in a narrow terminal", () => {
		const groups = groupReport(many);
		const screen = render({ groups, cursor: 0, open: new Set([groups[0]?.key ?? ""]), status: "" }, { rows: 12, columns: 20 });
		const lines = screen.replace("\u001b[2J\u001b[H", "").split("\n");
		expect(lines.length).toBeLessThanOrEqual(12);
		expect(lines.some((line) => line.includes("more;"))).toBe(true);
	});

	test("clips long lines to the terminal width", () => {
		const screen = render({ groups: groupReport(report()), cursor: 0, open: new Set(), status: "" }, { rows: 40, columns: 20 });
		for (const line of screen.replace("\u001b[2J\u001b[H", "").split("\n")) expect([...line].length).toBeLessThanOrEqual(20);
	});

	test("scrolls so the cursor row shows", () => {
		const rows: DoctorReport = {
			ok: false,
			items: Array.from({ length: 20 }, (_, index) => ({
				item: `item-${index}`,
				checks: [check(`check-${index}`, "fail", `broken ${index}`, `do thing ${index}`)],
			})),
		};
		const screen = render({ groups: groupReport(rows), cursor: 19, open: new Set(), status: "" }, { rows: 8, columns: 200 });
		expect(screen).toContain("> ❌ item-19: broken 19");
		expect(screen).not.toContain("item-0:");
	});
});

describe("render fits the terminal", () => {
	const plain = (screen: string) => screen.replace("\u001b[2J\u001b[H", "");

	test("ends without a newline, so a full screen does not scroll", () => {
		const screen = render({ groups: groupReport(report()), cursor: 0, open: new Set(), status: "" }, { rows: 8, columns: 80 });
		expect(screen.endsWith("\n")).toBe(false);
		expect(plain(screen).split("\n").length).toBeLessThanOrEqual(8);
	});

	test("measures wide icons in terminal cells", () => {
		const screen = render({ groups: groupReport(report()), cursor: 0, open: new Set(), status: "" }, { rows: 40, columns: 20 });
		for (const line of plain(screen).split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(20);
	});

	test("wraps a long Fix line instead of cutting it", () => {
		const fix = "curl -fsSL https://github.com/detailedghost/dg-ai/releases/latest/download/bootstrap.sh | sh -s -- --cli-only";
		const groups = groupReport({ ok: false, items: [{ item: "shared", checks: [check("cli", "fail", "missing", fix)] }] });
		const screen = plain(render({ groups, cursor: 0, open: new Set([groups[0]?.key ?? ""]), status: "" }, { rows: 40, columns: 40 }));
		expect(screen.replace(/\s/g, "")).toContain(fix.replace(/\s/g, ""));
	});

	test("shows a multi-line detail as one row per line", () => {
		const detail = "~/.dg/inbox has not moved\n~/.dg/grants has not moved";
		const two = check("layout", "warn", detail, "dg-skills install");
		const groups = groupReport({ ok: false, items: [{ item: "install", checks: [two, check("x", "warn", "y", "dg-skills install")] }] });
		const screen = plain(render({ groups, cursor: 0, open: new Set([groups[0]?.key ?? ""]), status: "" }, { rows: 40, columns: 30 }));
		const lines = screen.split("\n");
		expect(lines.some((line) => line.startsWith("        ~/.dg/grants"))).toBe(true);
		for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(30);
	});

	test("puts only the first line of a one-check detail in the header", () => {
		const groups = groupReport({ ok: false, items: [{ item: "install", checks: [check("layout", "warn", "first\nsecond")] }] });
		const screen = plain(render({ groups, cursor: 0, open: new Set(), status: "" }, { rows: 40, columns: 80 }));
		expect(screen).toContain("install: first");
		expect(screen).not.toContain("second");
	});

	test("an open allow-rules row lists the exact rules", () => {
		const groups = groupReport(report());
		const allow = groups.find((g) => g.action?.kind === "allow-rule");
		const screen = render({ groups, cursor: 2, open: new Set([allow?.key ?? ""]), status: "" }, { rows: 40, columns: 200 });
		expect(screen).toContain("      Bash(dg-skills inbox:*)");
		expect(screen).toContain("      Bash(dg-skills db:*)");
	});
});

describe("splitKeys", () => {
	test("splits several keys in one chunk", () => {
		expect(splitKeys(`${KEY.down}${KEY.down}\ry`)).toEqual({ keys: [KEY.down, KEY.down, "\r", "y"], rest: "" });
	});

	test("keeps an unfinished escape sequence for the next chunk", () => {
		const first = splitKeys("\u001b[");
		expect(first).toEqual({ keys: [], rest: "\u001b[" });
		expect(splitKeys(`${first.rest}B`)).toEqual({ keys: [KEY.down], rest: "" });
	});
});

describe("allowRulesIn", () => {
	test("splits several rules in one fix", () => {
		expect(allowRulesIn("Bash(dg-skills hooks status:*) Bash(dg-skills hooks list:*)")).toEqual([
			"Bash(dg-skills hooks status:*)",
			"Bash(dg-skills hooks list:*)",
		]);
	});

	test("refuses a fix that also holds an instruction", () => {
		expect(allowRulesIn("replace it with Bash(dg-skills hooks status:*)")).toBeNull();
		expect(allowRulesIn("jq . ~/.claude/settings.json")).toBeNull();
	});

	test("an instruction fix on an allow-rule check stays a manual row", () => {
		const groups = groupReport({
			ok: true,
			items: [{ item: "hooks", checks: [check("allow-rule", "warn", "too broad", "replace it with Bash(dg-skills hooks status:*)")] }],
		});
		expect(groups[0]?.action).toBeNull();
	});
});

describe("addAllowRules", () => {
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "dg-doctor-tui-"));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	test("adds only new rules and keeps every other key and rule", async () => {
		mkdirSync(join(home, ".claude"));
		const settings = join(home, ".claude", "settings.json");
		writeFileSync(
			settings,
			JSON.stringify({ model: "opus", permissions: { allow: ["Bash(git *)", "Bash(dg-skills db:*)"], deny: ["x"] } }),
		);
		await addAllowRules(["Bash(dg-skills db:*)", "Bash(dg-skills inbox:*)"], home);
		expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({
			model: "opus",
			permissions: { allow: ["Bash(git *)", "Bash(dg-skills db:*)", "Bash(dg-skills inbox:*)"], deny: ["x"] },
		});
	});

	test("creates the file when it is missing", async () => {
		await addAllowRules(["Bash(dg-skills db:*)"], home);
		expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"))).toEqual({
			permissions: { allow: ["Bash(dg-skills db:*)"] },
		});
	});
});
