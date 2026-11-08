import { slugify } from "@dg/common";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerDemo } from "../src/commands/demo";
import { type DemoResult, readResult, writeResult } from "../src/demo/result";
import { type DemoWorld, demoWorld } from "./demo-local-fixtures";

let world: DemoWorld;

beforeEach(() => {
	world = demoWorld();
});
const children: Array<{ kill(): void }> = [];
afterEach(() => {
	for (const child of children.splice(0)) child.kill();
	world.cleanup();
});

const playerArgv = [
	"-e",
	"setInterval(() => {}, 1000)",
	"--",
	"__player",
	JSON.stringify({ slug: "local-player-tour" }),
];

const liveChild = (argv: string[]) => {
	const child = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
	children.push(child);
	return child;
};

const playerChild = (forSlug = slug) =>
	liveChild([process.execPath, "-e", "setInterval(() => {}, 1000)", "__player", JSON.stringify({ slug: forSlug })]);

const slug = "local-player-tour";

const fixture = (): DemoResult => ({
	slug,
	outcome: "done",
	mode: "video",
	steps: 2,
	video: join(world.demosDir, slug, `${slug}-20260101-1200.mp4`),
	encoded: true,
	audio: "none",
	plan: join(world.demosDir, slug, `${slug}.demo.md`),
	startedAt: "2026-01-01T12:00:00.000Z",
	endedAt: "2026-01-01T12:01:00.000Z",
});

const status = () => world.drive(registerDemo, ["demo", "status", slug]);

describe("generated slugs", () => {
	test.each(["#115: Local Tour", "--x--", "!!!", "Plain Title", "emoji \u{1F680} launch", "_a_", "a.b/c"])(
		"%s reads back through readResult",
		(title) => {
			const generated = slugify(title);
			expect(generated).not.toMatch(/^-|-$/);
			writeResult({ ...fixture(), slug: generated });
			expect(readResult(generated)?.slug).toBe(generated);
		},
	);

	test("trims edge hyphens from a title that starts with punctuation", () => {
		expect(slugify("#115: Local Tour")).toBe("115-local-tour");
	});
});

describe("player pid matching", () => {
	const jobFor = (jobSlug: string) =>
		JSON.stringify({ slug: jobSlug, dir: join(world.demosDir, jobSlug), planPath: "p" });

	const livePlayerFor = (jobSlug: string, extra: string[] = []) => {
		const child = liveChild([
			process.execPath,
			"-e",
			"setInterval(() => {}, 1000)",
			"demo",
			"__player",
			jobFor(jobSlug),
			...extra,
		]);
		const dir = join(world.demosDir, slug);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "player.pid"), String(child.pid));
		return child;
	};

	test("accepts a player whose job slug matches exactly", async () => {
		const child = livePlayerFor(slug);
		expect((await status()).out).toBe(`running (pid ${child.pid})`);
	});

	test("rejects a player for a longer slug that contains this one", async () => {
		livePlayerFor(`${slug}-extra`);
		expect((await status()).out).toBe(`no run for ${slug}`);
	});

	test("rejects a player that only mentions the slug in another argument", async () => {
		livePlayerFor("other", [slug]);
		expect((await status()).out).toBe(`no run for ${slug}`);
	});
});

describe("demo status <slug>", () => {
	test("prints the result as one JSON line after a completed run", async () => {
		const result = fixture();
		writeResult(result);
		expect(readResult(slug)).toEqual(result);
		const run = await status();
		expect(run.code).toBe(0);
		expect(run.out.split("\n")).toHaveLength(1);
		expect(JSON.parse(run.out)).toEqual(result);
	});

	test("prints running (pid n) while the player is live and no result exists", async () => {
		const dir = join(world.demosDir, slug);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "player.log"), "");
		const player = liveChild([process.execPath, ...playerArgv]);
		writeFileSync(join(dir, "player.pid"), String(player.pid));
		const run = await status();
		expect(run.out).toBe(`running (pid ${player.pid})`);
	});

	test("ignores a live bun process whose command line is not this player", async () => {
		const other = liveChild([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
		const dir = join(world.demosDir, slug);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "player.pid"), String(other.pid));
		const run = await status();
		expect(run.out).toBe(`no run for ${slug}`);
	});

	test("prints no run for <slug> when nothing was recorded", async () => {
		const run = await status();
		expect(run.out).toBe(`no run for ${slug}`);
	});

	test("a result wins over a live player marker", async () => {
		const dir = join(world.demosDir, slug);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "player.pid"), String(playerChild().pid));
		writeResult(fixture());
		const run = await status();
		expect(JSON.parse(run.out).outcome).toBe("done");
	});

	test("falls back to a legacy ~/.dg/demos result", async () => {
		const legacy = join(world.home, ".dg", "demos", slug);
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, `${slug}.result.json`), JSON.stringify(fixture()));
		const run = await status();
		expect(JSON.parse(run.out).slug).toBe(slug);
	});

	test("readResult returns undefined for an unknown slug", () => {
		expect(readResult("nope")).toBeUndefined();
	});

	test("rejects a slug that tries to leave the demos dir", async () => {
		writeResult(fixture());
		expect(readResult("../local-player-tour")).toBeUndefined();
		const run = await world.drive(registerDemo, ["demo", "status", "../x"]);
		expect(run.out).toBe("no run for ../x");
	});

	test("ignores a player.pid that holds a dead pid", async () => {
		const dir = join(world.demosDir, slug);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "player.pid"), "2147483646");
		const run = await status();
		expect(run.out).toBe(`no run for ${slug}`);
	});

	test("ignores a player.pid that is not a number", async () => {
		const dir = join(world.demosDir, slug);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "player.pid"), "garbage");
		const run = await status();
		expect(run.out).toBe(`no run for ${slug}`);
	});

	test("ignores a recycled pid that runs another program", async () => {
		const other = liveChild(["sleep", "30"]);
		const dir = join(world.demosDir, slug);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "player.pid"), String(other.pid));
		const run = await status();
		expect(run.out).toBe(`no run for ${slug}`);
	});

	test("reports a live player process by its pid", async () => {
		const player = liveChild([process.execPath, ...playerArgv]);
		const dir = join(world.demosDir, slug);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "player.pid"), String(player.pid));
		const run = await status();
		expect(run.out).toBe(`running (pid ${player.pid})`);
	});

	test("falls back to a live pid in the legacy dir", async () => {
		const player = liveChild([process.execPath, ...playerArgv]);
		const legacy = join(world.home, ".dg", "demos", slug);
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "player.pid"), String(player.pid));
		const run = await status();
		expect(run.out).toBe(`running (pid ${player.pid})`);
	});

	test("treats a corrupt result file as no result", () => {
		const dir = join(world.demosDir, slug);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${slug}.result.json`), "{not json");
		expect(readResult(slug)).toBeUndefined();
	});
});
