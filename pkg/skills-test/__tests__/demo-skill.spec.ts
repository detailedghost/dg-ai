import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DEMO_SKILL = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	"plugins",
	"dg",
	"skills",
	"demo",
);
const ADR_DIR = join(import.meta.dir, "..", "..", "..", "docs", "adr");

function skillFile(path: string): string {
	const absolute = join(DEMO_SKILL, path);
	expect(existsSync(absolute)).toBe(true);
	return readFileSync(absolute, "utf8");
}

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

describe("demo skill", () => {
	const skill = skillFile("SKILL.md");
	const rows = flagsTable(skill);
	const byFlag = (flag: string) => rows.find((row) => row[0]?.includes(flag));

	test("leads the description with local playback and names --ext after it", () => {
		const description = /^description: (.+)$/m.exec(skill)?.[1] ?? "";
		expect(description).toStartWith(
			"Produce a guided demo that plays in a local browser (the default, no extension)",
		);
		expect(description.indexOf("local")).toBeGreaterThanOrEqual(0);
		expect(description.indexOf("local")).toBeLessThan(
			description.indexOf("--ext"),
		);
		expect(skill).not.toMatch(/^requires:/m);
	});

	test("documents every flag in four columns with its default", () => {
		expect(rows.every((row) => row.length === 4)).toBe(true);
		for (const flag of [
			"--ext",
			"--video",
			"--narration",
			"--out",
			"--browser",
			"--windows",
			"--wsl-headed",
			"--timeout",
			"--verify",
			"--print",
			"--edit",
		]) {
			expect(byFlag(flag)).toBeDefined();
		}
		expect(byFlag("`--ext`")?.[3]).toBe("off (local is the default)");
		expect(byFlag("--out")?.[3]).toBe(
			"`<cacheDir>/demos/<slug>/<slug>-<stamp>.mp4`",
		);
		expect(byFlag("--narration")?.[1]).toBe("`-n`");
		expect(byFlag("--narration")?.[2]).toMatch(/^Switch, no value/);
		expect(byFlag("--narration")?.[3]).toMatch(/^off/);
		expect(byFlag("--print")?.[2]).toMatch(/^`--ext` only/);
		expect(byFlag("--edit")?.[2]).toMatch(/^`--ext` only/);
	});

	test("tells agents never to pass --wsl-headed unless the human asks", () => {
		expect(byFlag("--wsl-headed")?.[2]).toContain(
			"Agents never pass `--wsl-headed` unless the human asks.",
		);
	});

	test("records in local mode with no start-screen instruction", () => {
		expect(skill).toContain("dg-skills demo /tmp/ai/demo/tour.md");
		expect(skill).toContain("dg-skills demo status <slug>");
		expect(skill).toContain("Add `-n` only when the human asks for voice");
		expect(skill).not.toMatch(/start screen open/);
		expect(skill).not.toMatch(/approval gate/);
		expect(skill).not.toMatch(/--narration <mode>/);
		expect(skill).toContain("no start\nscreen");
		const firstRun = skill.indexOf("dg-skills demo /tmp/ai/demo/tour.md");
		expect(skill.slice(0, firstRun)).not.toMatch(/demo --ext/);
	});

	test("documents credentials, intro and outro, the browser finder and ffmpeg", () => {
		expect(skill).toContain('@type="$NAME"');
		expect(skill).toContain("demo: set $NAME or move the login to ## Setup");
		expect(skill).toContain("Type it here, then continue.");
		expect(skill).toContain("`intro` and `outro`");
		expect(skill).toContain("`DG_BROWSER`");
		expect(skill).toContain("`ffmpeg`");
		expect(skill).toContain("`env-unset`");
		expect(skill).not.toContain("unrecorded-navigation");
	});

	test("describes the narration download, checksum, ffmpeg and CSP behavior", () => {
		const narration = skill.split("## Output and narration")[1]?.split("\n## ")[0] ?? "";
		expect(narration).toMatch(/first voiced run/);
		expect(narration).toMatch(/86 MB/);
		expect(narration).toMatch(/checksum/);
		expect(narration).toMatch(/Without it, the raw webm stays/);
		expect(narration).toMatch(/Content Security Policy/);
	});

	test("links ADR 0029 by its GitHub URL and keeps the plugin free of repo-relative docs paths", () => {
		expect(skill).toContain(
			"https://github.com/detailedghost/dg-ai/blob/master/docs/adr/0029-local-demo-player-wsl-debug-port.md",
		);
		expect(skill).not.toContain("docs/adr/../");
		expect(skill).not.toMatch(/\]\((?:\.\.\/){3,}docs\//);
	});

	test("points to the extension reference and every link resolves", () => {
		const links = [...skill.matchAll(/\]\((references\/[^)]+)\)/g)].map(
			(match) => match[1] as string,
		);
		expect([...new Set(links)].sort()).toEqual([
			"references/attach-pr.md",
			"references/authoring.md",
			"references/extension.md",
		]);
		expect(skillFile("references/attach-pr.md")).toContain(
			"dg-skills pw --ext upload",
		);
		for (const link of links) expect(skillFile(link)).not.toContain("TODO");
		expect(skillFile("references/extension.md")).toMatch(/Alt\+Shift\+D/);
		expect(skillFile("references/authoring.md")).toMatch(
			/Local play and\s+`--ext` play the same plan/,
		);
	});

	test("stays under 150 lines", () => {
		expect(skill.trimEnd().split("\n").length).toBeLessThan(150);
	});
});

describe("shared tour UI ADR", () => {
	const adrPath = join(ADR_DIR, "0030-shared-tour-ui-and-local-player.md");

	test("is Accepted, links ADR 0029 both ways, and is listed in the index", () => {
		const adr = readFileSync(adrPath, "utf8");
		const wsl = readFileSync(
			join(ADR_DIR, "0029-local-demo-player-wsl-debug-port.md"),
			"utf8",
		);
		const toc = readFileSync(join(ADR_DIR, "toc.md"), "utf8");
		expect(adr).toMatch(/^Status: Accepted$/m);
		expect(adr).toContain("0029-local-demo-player-wsl-debug-port.md");
		expect(wsl).toContain("0030-shared-tour-ui-and-local-player.md");
		expect(toc).toContain("(0030-shared-tour-ui-and-local-player.md)");
		expect(adr).toContain("sequenceDiagram");
	});
});

describe("local demo recorder ADR", () => {
	const adr = readFileSync(
		join(ADR_DIR, "0040-local-demo-recorder.md"),
		"utf8",
	);
	const toc = readFileSync(join(ADR_DIR, "toc.md"), "utf8");

	test("is Accepted, listed in the index, and marks 0029 and 0030 superseded in part", () => {
		expect(adr).toMatch(/^Status: Accepted$/m);
		expect(toc).toContain("(0040-local-demo-recorder.md)");
		for (const old of [
			"0029-local-demo-player-wsl-debug-port.md",
			"0030-shared-tour-ui-and-local-player.md",
		]) {
			expect(readFileSync(join(ADR_DIR, old), "utf8")).toContain(
				"Superseded in part by [ADR 0040](0040-local-demo-recorder.md)",
			);
		}
		expect(adr).toContain("sequenceDiagram");
	});
});
