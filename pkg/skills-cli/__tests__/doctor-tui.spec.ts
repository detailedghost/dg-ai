import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupReport, runnableFix } from "../src/doctor/groups";
import { addAllowRules, KEY, render, runTui, type TuiDeps } from "../src/doctor/tui";
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
		const d = fake([KEY.enter, "y", "q"]);
		await runTui(report(), d);
		expect(d.screens[1]).toContain("Run dg-agent start? [y/N]");
		expect(d.ran).toEqual([["dg-agent", "start"]]);
		expect(d.reruns).toBe(1);
		expect(d.screens.at(-1)).toContain("dg-agent start exited 0.");
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
		const d = fake([KEY.enter, "y", "q"], fixed);
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
		const screen = render({ groups: groupReport(report()), cursor: 2, open: new Set(), status: "" });
		expect(screen.match(/^> /gm)).toHaveLength(1);
		expect(screen).toContain("> ⚠️ allow rules (2)    enter: add all to ~/.claude/settings.json");
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
