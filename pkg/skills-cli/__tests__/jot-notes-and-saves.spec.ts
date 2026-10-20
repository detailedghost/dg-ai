import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { CAP, jotWorld, section, tree } from "./jot-fixtures";

setDefaultTimeout(60_000);

const world = jotWorld();
afterEach(() => world.cleanup());

function baseName(path: string): string {
	return basename(path.trim()).replace(/\.md$/, "");
}

describe("dg-skills jot dispatch", () => {
	test("help lists every subcommand and exits 0", async () => {
		const { main } = world.repo();
		const run = await world.jot(["--help"], main);
		expect(run.exitCode).toBe(0);
		for (const verb of [
			"add",
			"ls",
			"read",
			"kind",
			"done",
			"kick",
			"kick-list",
			"kick-take",
		])
			expect(run.stdout).toMatch(new RegExp(`^  ${verb}(?: |$)`, "m"));
	});

	test("a bare call prints usage on stdout and exits 2", async () => {
		const { main } = world.repo();
		const run = await world.jot([], main);
		expect(run.exitCode).toBe(2);
		expect(run.stdout).toContain("Subcommands:");
	});

	test("an unknown subcommand exits 2 naming it on stderr", async () => {
		const { main } = world.repo();
		const run = await world.jot(["frobnicate"], main);
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain("frobnicate");
	});

	test("help does not create scratch or state entries", async () => {
		const { main } = world.repo();
		await world.jot(["--help"], main);
		expect(tree(world.scratch)).toEqual([]);
		expect(tree(world.state)).toEqual([]);
	});
});

describe("jot add cap and split", () => {
	test("a body under the cap is one markdown file under the scratch root", async () => {
		const { main } = world.repo();
		const run = await world.jot(["add"], main, "# gh scopes\n\nrepo, workflow\n");
		expect(run.exitCode).toBe(0);
		const file = run.stdout.trim();
		expect(file.startsWith(join(world.scratch, "jot"))).toBe(true);
		expect(file).toMatch(/\/jot-[a-z]+-[a-z]+\.md$/);
		expect(readFileSync(file, "utf8")).toBe("# gh scopes\n\nrepo, workflow\n");
	});

	test("a missing trailing newline is added once", async () => {
		const { main } = world.repo();
		const file = (await world.jot(["add"], main, "# t\n\nno newline")).stdout.trim();
		expect(readFileSync(file, "utf8")).toBe("# t\n\nno newline\n");
	});

	test("a body of exactly the cap stays one file and one byte more does not", async () => {
		const { main } = world.repo();
		const filler = (total: number) => `# T\n\n${"x".repeat(total - 6)}\n`;
		expect(Buffer.byteLength(filler(CAP))).toBe(CAP);
		const exact = (await world.jot(["add"], main, filler(CAP))).stdout.trim();
		expect(exact.endsWith(".md")).toBe(true);
		const over = await world.jot(["add"], main, filler(CAP + 1));
		expect(over.exitCode).toBe(1);
		expect(over.stderr).toContain("shorten it");
	});

	test("the cap counts bytes, not characters", async () => {
		const { main } = world.repo();
		const body = `# T\n\n## S\n${"é".repeat(CAP / 2)}\n`;
		expect(body.length).toBeLessThan(CAP);
		const run = await world.jot(["add"], main, body);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("B > 2048 B");
	});

	test("an empty body fails with the fix", async () => {
		const { main } = world.repo();
		const run = await world.jot(["add"], main, "  \n");
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("empty body");
		expect(tree(world.scratch)).toEqual([]);
	});

	test("an oversize body with no sections fails and writes nothing", async () => {
		const { main } = world.repo();
		const run = await world.jot(["add"], main, "x".repeat(CAP + 1));
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain('no "## " sections');
		expect(tree(world.scratch)).toEqual([]);
	});

	test("an oversize body splits at each section into numbered parts plus an index", async () => {
		const { main } = world.repo();
		const body = `# Handoff\n\n${section("Context", 1500)}${section("Open threads", 1000)}`;
		const folder = (await world.jot(["add"], main, body)).stdout.trim();
		expect(readdirSync(folder).sort()).toEqual([
			"00-index.md",
			"01-context.md",
			"02-open-threads.md",
		]);
		expect(readFileSync(join(folder, "01-context.md"), "utf8").startsWith("## Context\n")).toBe(true);
		const index = readFileSync(join(folder, "00-index.md"), "utf8");
		expect(index).toContain("# Handoff");
		expect(index).toContain("- 01  Context  ");
		expect(index).toContain("- 02  Open threads  ");
		for (const file of readdirSync(folder))
			expect(statSizeOf(join(folder, file))).toBeLessThanOrEqual(CAP);
	});

	test("a section that alone passes the cap fails naming the section", async () => {
		const { main } = world.repo();
		const run = await world.jot(["add"], main, `# T\n\n${section("Context", CAP + 10)}`);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain('section "Context"');
		expect(tree(world.scratch)).toEqual([]);
	});

	test("an index that passes the cap fails naming the index", async () => {
		const { main } = world.repo();
		const head = "intro line\n".repeat(200);
		const body = `${head}\n${section("A", 1000)}${section("B", 1000)}`;
		const run = await world.jot(["add"], main, body);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("index is");
	});
});

function statSizeOf(path: string): number {
	return Buffer.byteLength(readFileSync(path, "utf8"));
}

describe("jot add --save placement and linked worktrees", () => {
	test("a main checkout with .agents saves under .agents/jot with a self-ignore", async () => {
		const { main } = world.repo({ agents: true });
		const run = await world.jot(["add", "-s"], main, "# Resume\n");
		expect(run.exitCode).toBe(0);
		expect(run.stdout.trim().startsWith(join(main, ".agents", "jot"))).toBe(true);
		expect(readFileSync(join(main, ".agents", "jot", ".gitignore"), "utf8")).toBe("*\n");
	});

	test("the long flag --save behaves like -s", async () => {
		const { main } = world.repo({ agents: true });
		const run = await world.jot(["add", "--save"], main, "# Resume\n");
		expect(run.stdout.trim().startsWith(join(main, ".agents", "jot"))).toBe(true);
	});

	test("an existing .gitignore in .agents/jot is left as written", async () => {
		const { main } = world.repo({ agents: true });
		mkdirSync(join(main, ".agents", "jot"));
		writeFileSync(join(main, ".agents", "jot", ".gitignore"), "custom\n");
		await world.jot(["add", "-s"], main, "# Resume\n");
		expect(readFileSync(join(main, ".agents", "jot", ".gitignore"), "utf8")).toBe("custom\n");
	});

	test("a checkout without .agents saves under the state root", async () => {
		const { main } = world.repo();
		const run = await world.jot(["add", "--save"], main, "# Resume\n");
		expect(run.stdout.trim().startsWith(join(world.state, "jot"))).toBe(true);
		expect(existsSync(join(main, ".agents"))).toBe(false);
	});

	test("a linked worktree saves under the state root and never touches the main checkout", async () => {
		const { main, linked } = world.repo({ agents: true });
		const before = tree(join(main, ".agents"));
		const run = await world.jot(["add", "-s"], linked, "# Resume\n");
		expect(run.exitCode).toBe(0);
		expect(run.stdout.trim().startsWith(join(world.state, "jot"))).toBe(true);
		expect(existsSync(join(main, ".agents", "jot"))).toBe(false);
		expect(tree(join(main, ".agents"))).toEqual(before);
		expect(existsSync(join(linked, ".agents", "jot"))).toBe(false);
	});

	test("a split save from a linked worktree also stays out of the main checkout", async () => {
		const { main, linked } = world.repo({ agents: true });
		const body = `# Handoff\n\n${section("Context", 1500)}${section("References", 1500)}`;
		const folder = (await world.jot(["add", "-s"], linked, body)).stdout.trim();
		expect(folder.startsWith(join(world.state, "jot"))).toBe(true);
		expect(readdirSync(folder)).toContain("00-index.md");
		expect(existsSync(join(main, ".agents", "jot"))).toBe(false);
	});

	test("linked and main checkouts without .agents share one state directory", async () => {
		const { main, linked } = world.repo();
		const fromMain = (await world.jot(["add", "-s"], main, "# one\n")).stdout.trim();
		const fromLinked = (await world.jot(["add", "-s"], linked, "# two\n")).stdout.trim();
		expect(dirname(fromLinked)).toBe(dirname(fromMain));
	});

	test("AI_STATE_DIR wins over XDG_STATE_HOME for a state save", async () => {
		const { main } = world.repo();
		const xdg = world.tmp("jot-xdg-");
		const saved = (
			await world.jot(["add", "-s"], main, "# s\n", { XDG_STATE_HOME: xdg })
		).stdout.trim();
		expect(saved.startsWith(world.state)).toBe(true);
		expect(readdirSync(xdg)).toEqual([]);
	});

	test("without AI_STATE_DIR a state save follows XDG_STATE_HOME", async () => {
		const { main } = world.repo();
		const xdg = world.tmp("jot-xdg-");
		const saved = (
			await world.jot(["add", "-s"], main, "# s\n", {
				AI_STATE_DIR: undefined,
				XDG_STATE_HOME: xdg,
			})
		).stdout.trim();
		expect(saved.startsWith(join(xdg, "ai"))).toBe(true);
		expect(readdirSync(world.state)).toEqual([]);
	});

	test("a linked worktree lists saves from both the main checkout and the state root", async () => {
		const { main, linked } = world.repo({ agents: true });
		await world.jot(["add", "-s"], main, "# from main\n");
		await world.jot(["add", "-s"], linked, "# from linked\n");
		const rows = (await world.jot(["ls", "-s"], linked)).stdout.trim().split("\n");
		expect(rows.map((row) => row.split("\t")[3]).sort()).toEqual(["from linked", "from main"]);
	});

	test("a note is private to the directory that wrote it", async () => {
		const first = world.repo();
		const second = world.repo();
		await world.jot(["add"], first.main, "# only here\n");
		expect((await world.jot(["ls", "-n"], second.main)).stdout).toBe("");
		expect((await world.jot(["ls", "-n"], first.main)).stdout).toContain("only here");
	});
});

describe("jot ls", () => {
	test("prints kind, age, name and title newest first", async () => {
		const { main } = world.repo();
		const note = (await world.jot(["add"], main, "# older note\n")).stdout.trim();
		const past = new Date(Date.now() - 3 * 86_400_000);
		utimesSync(note, past, past);
		await world.jot(["add", "-s"], main, "# newer save\n");
		const rows = (await world.jot(["ls"], main)).stdout
			.trim()
			.split("\n")
			.map((line) => line.split("\t"));
		expect(rows.map((row) => [row[0], row[3]])).toEqual([
			["save", "newer save"],
			["note", "older note"],
		]);
		expect(rows[1]?.[1]).toBe("3d");
		expect(rows[1]?.[2]).toMatch(/^jot-[a-z]+-[a-z]+$/);
	});

	test("filters by kind with short and long flags", async () => {
		const { main } = world.repo();
		await world.jot(["add"], main, "# a note\n");
		await world.jot(["add", "-s"], main, "# a save\n");
		const saves = (await world.jot(["ls", "--save"], main)).stdout;
		expect(saves).toContain("a save");
		expect(saves).not.toContain("a note");
		const notes = (await world.jot(["ls", "--note"], main)).stdout;
		expect(notes).toContain("a note");
		expect(notes).not.toContain("a save");
	});

	test("limits rows to ten unless --all", async () => {
		const { main } = world.repo();
		for (let i = 0; i < 12; i++) await world.jot(["add"], main, `# note ${i}\n`);
		const limited = await world.jot(["ls"], main);
		expect(limited.stdout.trim().split("\n")).toHaveLength(10);
		expect(limited.stderr).toContain("2 more; use --all");
		const all = await world.jot(["ls", "--all"], main);
		expect(all.stdout.trim().split("\n")).toHaveLength(12);
		expect(all.stderr).toBe("");
	});

	test("prints nothing when there are no jots", async () => {
		const { main } = world.repo();
		const run = await world.jot(["ls"], main);
		expect(run.stdout).toBe("");
		expect(run.exitCode).toBe(0);
	});

	test("shows a split jot as one row titled from its index", async () => {
		const { main } = world.repo();
		const body = `# Big handoff\n\n${section("Context", 1500)}${section("References", 1500)}`;
		await world.jot(["add", "-s"], main, body);
		const rows = (await world.jot(["ls"], main)).stdout.trim().split("\n");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.split("\t")[3]).toBe("Big handoff");
	});

	test("truncates a long title to 80 characters with an ellipsis", async () => {
		const { main } = world.repo();
		await world.jot(["add"], main, `# ${"t".repeat(120)}\n`);
		const title = (await world.jot(["ls"], main)).stdout.trim().split("\t")[3] ?? "";
		expect(title).toBe(`${"t".repeat(77)}...`);
	});

	test("ignores a folder without an index", async () => {
		const { main } = world.repo();
		await world.jot(["add"], main, "# n\n");
		const bucket = join(world.scratch, "jot", readdirSync(join(world.scratch, "jot"))[0] ?? "");
		const stray = join(bucket, "jot-stray-dir");
		mkdirSync(stray);
		writeFileSync(join(stray, "01-x.md"), "x");
		expect((await world.jot(["ls"], main)).stdout).not.toContain("jot-stray-dir");
	});
});

describe("jot read, kind and done", () => {
	async function splitSave(cwd: string): Promise<string> {
		const body = `# Handoff\n\n${section("Context", 1500)}${section("References", 1500)}`;
		return baseName((await world.jot(["add", "-s"], cwd, body)).stdout);
	}

	test("read prints a single jot unchanged", async () => {
		const { main } = world.repo();
		const name = baseName((await world.jot(["add"], main, "# n\n\nbody\n")).stdout);
		expect((await world.jot(["read", name], main)).stdout).toBe("# n\n\nbody\n");
	});

	test("read accepts the full path and the .md name", async () => {
		const { main } = world.repo();
		const file = (await world.jot(["add"], main, "# n\n")).stdout.trim();
		expect((await world.jot(["read", file], main)).stdout).toBe("# n\n");
		expect((await world.jot(["read", basename(file)], main)).stdout).toBe("# n\n");
	});

	test("read prints the index of a split jot and one part by number", async () => {
		const { main } = world.repo();
		const name = await splitSave(main);
		expect((await world.jot(["read", name], main)).stdout).toContain("- 02  References");
		expect((await world.jot(["read", `${name}/2`], main)).stdout.startsWith("## References\n")).toBe(true);
		expect((await world.jot(["read", `${name}/02`], main)).stdout.startsWith("## References\n")).toBe(true);
	});

	test("read of a missing part or an unsplit jot with a part fails", async () => {
		const { main } = world.repo();
		const name = await splitSave(main);
		const missing = await world.jot(["read", `${name}/09`], main);
		expect(missing.exitCode).toBe(1);
		expect(missing.stderr).toContain("no part 09");
		const plain = baseName((await world.jot(["add"], main, "# n\n")).stdout);
		const unsplit = await world.jot(["read", `${plain}/1`], main);
		expect(unsplit.exitCode).toBe(1);
		expect(unsplit.stderr).toContain("is not split");
	});

	test("read without a name or with an unknown name fails with the fix", async () => {
		const { main } = world.repo();
		const none = await world.jot(["read"], main);
		expect(none.exitCode).toBe(1);
		expect(none.stderr).toContain("missing name");
		const unknown = await world.jot(["read", "jot-missing-name"], main);
		expect(unknown.exitCode).toBe(1);
		expect(unknown.stderr).toContain("no jot named jot-missing-name");
	});

	test("read does not remove a save", async () => {
		const { main } = world.repo();
		const name = await splitSave(main);
		await world.jot(["read", name], main);
		expect((await world.jot(["ls", "-s"], main)).stdout).toContain(name);
	});

	test("kind answers for a name and for a path", async () => {
		const { main } = world.repo();
		const notePath = (await world.jot(["add"], main, "# n\n")).stdout.trim();
		expect((await world.jot(["kind", notePath], main)).stdout).toBe("note\n");
		expect((await world.jot(["kind", await splitSave(main)], main)).stdout).toBe("save\n");
		const missing = await world.jot(["kind", "jot-missing-name"], main);
		expect(missing.exitCode).toBe(1);
		expect(missing.stdout).toBe("");
	});

	test("kind and done without an argument fail with the fix", async () => {
		const { main } = world.repo();
		expect((await world.jot(["kind"], main)).stderr).toContain("missing path or name");
		expect((await world.jot(["done"], main)).stderr).toContain("missing name");
	});

	test("done removes a file and a split folder and reports the path", async () => {
		const { main } = world.repo();
		const notePath = (await world.jot(["add"], main, "# n\n")).stdout.trim();
		const name = await splitSave(main);
		const removedNote = await world.jot(["done", notePath], main);
		expect(removedNote.exitCode).toBe(0);
		expect(removedNote.stdout).toBe(`removed ${notePath}\n`);
		expect((await world.jot(["done", name], main)).exitCode).toBe(0);
		expect(existsSync(notePath)).toBe(false);
		expect((await world.jot(["ls"], main)).stdout).toBe("");
	});

	test("an absolute path outside the jot directories is not resolved", async () => {
		const { main } = world.repo();
		const outside = join(world.tmp("jot-outside-"), "jot-fake.md");
		writeFileSync(outside, "# fake\n");
		const run = await world.jot(["read", outside], main);
		expect(run.exitCode).toBe(1);
		expect(existsSync(outside)).toBe(true);
	});
});
