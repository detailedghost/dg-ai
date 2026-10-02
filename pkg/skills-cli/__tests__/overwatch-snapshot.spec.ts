import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import {
	access,
	chmod,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OverwatchBoard, OverwatchLane } from "@dg/common";
import {
	renderOverwatchSnapshot,
	writeOverwatchSnapshot,
} from "../src/commands/overwatch-snapshot";

const temporaryDirectories: string[] = [];
const renderedAt = new Date("2026-10-02T15:00:00.000Z");
const skillsCliEntry = join(import.meta.dir, "..", "src", "index.ts");

type CliResult = {
	code: number | null;
	stdout: string;
	stderr: string;
};

async function runCli(args: string[]): Promise<CliResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [skillsCliEntry, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
		child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({
				code,
				stdout: Buffer.concat(stdout).toString("utf8"),
				stderr: Buffer.concat(stderr).toString("utf8"),
			});
		});
	});
}

function lane(
	chat: string,
	stage: OverwatchLane["stage"],
	overrides: Partial<OverwatchLane> = {},
): OverwatchLane {
	return {
		chat,
		task: `Ship ${chat}`,
		stage,
		kind: "chat",
		publisher: `${chat}-agent`,
		updatedAt: "2026-10-02T14:30:00.000Z",
		...overrides,
	};
}

function board(): OverwatchBoard {
	return {
		goLive: "2026-10-24T14:00:00.000Z",
		goNoGo: "2026-10-17T14:00:00.000Z",
		lanes: [
			lane("print", "e2e", {
				mr: "!298",
				eta: "1h",
				url: "https://claude.ai/code/print?mode=focus&owner=ada",
			}),
			lane("table_migration", "review", {
				mr: "!292",
				eta: "6 to 10h",
				url: "https://claude.ai/code/table-migration",
			}),
			lane("patient", "ci", {
				eta: "2h",
				next: "Pick intake layout",
			}),
			lane("infra", "done", {
				mr: "!301",
				next: "Choose DB grant",
				url: "https://claude.ai/code/infra",
			}),
			lane("arch agent", "review", {
				kind: "background",
				task: "Twilio carrier analysis",
				eta: "30m",
			}),
		],
		merges: [
			{
				mr: "!300",
				title: "Stage 2FA",
				at: "2026-10-02T14:00:00.000Z",
			},
		],
	};
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

describe("overwatch snapshot renderer", () => {
	it("renders four chat tiles with links, stage states, and the variant E summary", () => {
		const html = renderOverwatchSnapshot(board(), renderedAt);

		expect(html.match(/data-chat-tile/g)).toHaveLength(4);
		expect(html).toContain(
			'href="https://claude.ai/code/print?mode=focus&amp;owner=ada"',
		);
		expect(html).toContain("Open chat");
		expect(html).toContain("No link");
		expect(html).toContain("2 NEED YOU");
		expect(html).toContain("data-state=\"done\"");
		expect(html).toContain("data-state=\"now\"");
		expect(html).toContain("data-state=\"pending\"");
		expect(html).toContain("arch agent");
		expect(html).toContain("!300 Stage 2FA");
		expect(html).toContain("as of Oct 2, 2026, 3:00 PM UTC");
		expect(html).toContain("21D 23H TO GO LIVE");
	});

	it("escapes all board text and includes no external URLs beyond chat links", () => {
		const fixture = board();
		fixture.lanes[0] = lane('<script>alert("chat")</script>', "merge", {
			task: '<img src=x onerror="alert(1)"> & ready',
			mr: '"!9"',
			eta: "<5m",
			next: "Review Tom's <copy>",
			url: "https://claude.ai/code/session?name=%22Ada%22&mode=focus",
			publisher: "<publisher>",
		});
		fixture.merges[0].title = "Fix <unsafe> & ship — now – next ─ done";

		const html = renderOverwatchSnapshot(fixture, renderedAt);
		const withoutChatLinks = html.replaceAll(/https:\/\/claude\.ai\/[^\"]+/g, "");

		expect(html).not.toContain("<script>alert");
		expect(html).not.toContain("<img src=x");
		expect(html).toContain("&lt;script&gt;alert(&quot;chat&quot;)&lt;/script&gt;");
		expect(html).toContain("Tom&#39;s &lt;copy&gt;");
		expect(html).toContain("Fix &lt;unsafe&gt; &amp; ship   now   next   done");
		expect(withoutChatLinks).not.toMatch(/https?:\/\//);
		const visible = html
			.replaceAll(/<style>[\s\S]*?<\/style>/g, "")
			.replaceAll(/<[^>]+>/g, "");
		expect(visible).not.toMatch(/[-‐‑‒–—―−─]/);
		expect(html).not.toMatch(/border[^;{}]*(dashed|dotted)/);
	});

	it("constrains every narrow layout column and ellipsizes chat labels", () => {
		const html = renderOverwatchSnapshot(
			{
				...board(),
				lanes: [
					lane("x".repeat(40), "review", {
						mr: "x".repeat(80),
						eta: "x".repeat(80),
						next: "x".repeat(200),
					}),
					lane("y".repeat(40), "ci", { kind: "background" }),
				],
			},
			renderedAt,
		);

		expect(html).toContain("grid-template-columns:minmax(0,1fr)");
		expect(html).toContain("text-overflow:ellipsis;white-space:nowrap");
		expect(html).toContain(".stats{display:grid;width:100%");
		expect(html).toContain(`aria-label="${"x".repeat(40)}"`);
		expect(html).toContain(`aria-label="${"y".repeat(40)}"`);
	});
});

describe("overwatch snapshot throttle", () => {
	it("skips writing when the same throttle key rendered less than 120 seconds ago", async () => {
		const scratchRoot = await mkdtemp(join(tmpdir(), "dg-overwatch-test-"));
		temporaryDirectories.push(scratchRoot);
		const firstOutput = join(scratchRoot, "first.html");
		const skippedOutput = join(scratchRoot, "skipped.html");

		const first = await writeOverwatchSnapshot(board(), {
			now: renderedAt,
			outPath: firstOutput,
			scratchRoot,
			throttleKey: "board",
		});
		const skipped = await writeOverwatchSnapshot(board(), {
			now: new Date(renderedAt.getTime() + 30_000),
			outPath: skippedOutput,
			scratchRoot,
			throttleKey: "board",
		});

		expect(first).toEqual({ status: "written", path: firstOutput });
		expect(skipped).toEqual({ status: "throttled", seconds: 90 });
		expect(await readFile(firstOutput, "utf8")).toContain("<!doctype html>");
		expect(access(skippedOutput)).rejects.toThrow();
	});

	it("allows exactly one concurrent writer for a throttle key", async () => {
		const scratchRoot = await mkdtemp(join(tmpdir(), "dg-overwatch-race-"));
		temporaryDirectories.push(scratchRoot);
		const results = await Promise.all([
			writeOverwatchSnapshot(board(), {
				now: renderedAt,
				outPath: join(scratchRoot, "first.html"),
				scratchRoot,
				throttleKey: "board",
			}),
			writeOverwatchSnapshot(board(), {
				now: renderedAt,
				outPath: join(scratchRoot, "second.html"),
				scratchRoot,
				throttleKey: "board",
			}),
		]);

		expect(results.filter((result) => result.status === "written")).toHaveLength(
			1,
		);
		expect(
			results.filter((result) => result.status === "throttled"),
		).toHaveLength(1);
	});

	it("repairs private directory and file modes", async () => {
		const scratchRoot = await mkdtemp(join(tmpdir(), "dg-overwatch-mode-"));
		temporaryDirectories.push(scratchRoot);
		const output = join(scratchRoot, "snapshot.html");
		const state = join(scratchRoot, "board.json");
		await chmod(scratchRoot, 0o755);
		await writeFile(output, "old", { mode: 0o644 });
		await writeFile(
			state,
			JSON.stringify({ renderedAt: renderedAt.getTime() }),
			{ mode: 0o644 },
		);

		const result = await writeOverwatchSnapshot(board(), {
			now: renderedAt,
			outPath: output,
			scratchRoot,
			throttleKey: "board",
		});

		expect(result.status).toBe("throttled");
		expect((await stat(scratchRoot)).mode & 0o777).toBe(0o700);
		expect((await stat(output)).mode & 0o777).toBe(0o600);
		expect((await stat(state)).mode & 0o777).toBe(0o600);
	});
});

describe("overwatch snapshot command", () => {
	it("reads board JSON, writes HTML, and prints the output path", async () => {
		const directory = await mkdtemp(join(tmpdir(), "dg-overwatch-cli-"));
		temporaryDirectories.push(directory);
		const input = join(directory, "board.json");
		const output = join(directory, "board.html");
		await writeFile(input, JSON.stringify(board()));

		const result = await runCli([
			"overwatch-snapshot",
			"--input",
			input,
			"--out",
			output,
		]);

		expect(result).toEqual({ code: 0, stdout: `${output}\n`, stderr: "" });
		expect((await readFile(output, "utf8")).match(/data-chat-tile/g)).toHaveLength(
			4,
		);
	});
});

describe("overwatch skill workflow", () => {
	it("requires one authoritative publisher to republish after every mutation", async () => {
		const skill = await readFile(
			join(import.meta.dir, "../../../plugins/dg/skills/overwatch/SKILL.md"),
			"utf8",
		);

		expect(skill).toContain("authoritative publisher");
		expect(skill).toContain(
			"After every successful `set`, `merged`, `launch`, or `remove` mutation",
		);
		expect(skill).toContain("throttled update loop");
		expect(skill).toContain("must not run board mutation commands themselves");
	});
});
