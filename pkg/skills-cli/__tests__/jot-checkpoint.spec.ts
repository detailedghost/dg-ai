import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { checkpointBody, ID_A, ID_B, jotWorld } from "./jot-fixtures";

setDefaultTimeout(60_000);

const world = jotWorld();
afterEach(() => world.reset());
afterAll(() => world.cleanup());

function fixture() {
	const { main } = world.repo();
	const dir = world.tmp("jot-cp-");
	return { cwd: main, file: join(dir, "nested", "checkpoint.md") };
}

function seed(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
}

function leftovers(file: string): string[] {
	return readdirSync(dirname(file)).filter(
		(name) => name.endsWith(".tmp") || name.endsWith(".lock"),
	);
}

describe("jot kick", () => {
	test("creates the file and directory then appends without touching other sections", async () => {
		const { cwd, file } = fixture();
		const first = await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_A));
		expect(first.exitCode).toBe(0);
		expect(first.stdout).toBe(`${ID_A}\n`);
		const written = readFileSync(file, "utf8");
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_B));
		const second = readFileSync(file, "utf8");
		expect(written.startsWith("# Checkpoints\n")).toBe(true);
		expect(second).toContain(written.trimEnd());
		expect(second).toContain(`## ${ID_B}`);
		expect(leftovers(file)).toEqual([]);
	});

	test("accepts --file before or after --replace", async () => {
		const { cwd, file } = fixture();
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_A));
		await world.jot(["kick", "--replace", "--file", file], cwd, checkpointBody(ID_A, "again"));
		await world.jot(["kick", "--file", file, "--replace"], cwd, checkpointBody(ID_A, "third"));
		expect(readFileSync(file, "utf8")).toContain("summary: third");
	});

	test("without --file it writes HOME/doc/checkpoint.md", async () => {
		const { cwd } = fixture();
		const run = await world.jot(["kick"], cwd, checkpointBody(ID_A));
		expect(run.exitCode).toBe(0);
		const target = join(world.home, "doc", "checkpoint.md");
		expect(readFileSync(target, "utf8")).toContain(`## ${ID_A}`);
	});

	test("--file with no path fails", async () => {
		const { cwd } = fixture();
		const run = await world.jot(["kick", "--file"], cwd, checkpointBody(ID_A));
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("--file needs a path");
	});

	test("keeps an existing file's preamble and sections", async () => {
		const { cwd, file } = fixture();
		seed(file, "# My notes\n\nintro\n\n## old section\nkeep me\n");
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_A));
		const text = readFileSync(file, "utf8");
		expect(text.startsWith("# My notes\n\nintro\n\n## old section\nkeep me\n")).toBe(true);
		expect(text).toContain(`## ${ID_A}`);
	});

	test("rejects a duplicate id unless --replace and then replaces only that section", async () => {
		const { cwd, file } = fixture();
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_A));
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_B));
		const before = readFileSync(file, "utf8");
		const duplicate = await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_A, "new"));
		expect(duplicate.exitCode).toBe(1);
		expect(duplicate.stderr).toContain("--replace");
		expect(readFileSync(file, "utf8")).toBe(before);
		const replaced = await world.jot(["kick", "--file", file, "--replace"], cwd, checkpointBody(ID_A, "new"));
		expect(replaced.exitCode).toBe(0);
		const text = readFileSync(file, "utf8");
		expect(text).toContain("summary: new");
		expect(text).toContain("summary: state of play");
		expect(text.match(/^## /gm)).toHaveLength(2);
		expect(text.indexOf(ID_A)).toBeLessThan(text.indexOf(ID_B));
	});

	test("--replace with an unknown id fails and writes nothing", async () => {
		const { cwd, file } = fixture();
		const run = await world.jot(["kick", "--file", file, "--replace"], cwd, checkpointBody(ID_A));
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("to replace");
		expect(existsSync(file)).toBe(false);
	});

	test("rejects a bad id, a missing sub-section, a second heading and a missing meta line", async () => {
		const { cwd, file } = fixture();
		const badId = await world.jot(["kick", "--file", file], cwd, checkpointBody("not an id"));
		expect(badId.exitCode).toBe(1);
		expect(badId.stderr).toContain("must match");
		const noNext = checkpointBody(ID_A).replace("### Next steps\n- c\n", "");
		expect((await world.jot(["kick", "--file", file], cwd, noNext)).stderr).toContain("Next steps");
		const twoHeadings = `${checkpointBody(ID_A)}## second\n`;
		expect((await world.jot(["kick", "--file", file], cwd, twoHeadings)).stderr).toContain("one section per call");
		const noSummary = checkpointBody(ID_A).replace("summary: state of play\n", "");
		expect((await world.jot(["kick", "--file", file], cwd, noSummary)).stderr).toContain("summary");
		const noRepo = checkpointBody(ID_A).replace("repo: /tmp/example-repo\n", "");
		expect((await world.jot(["kick", "--file", file], cwd, noRepo)).stderr).toContain("repo");
		const noHeading = await world.jot(["kick", "--file", file], cwd, "plain text\n");
		expect(noHeading.stderr).toContain("first line must be");
		expect(existsSync(file)).toBe(false);
		expect(existsSync(dirname(file))).toBe(false);
	});

	test("a section has no size cap", async () => {
		const { cwd, file } = fixture();
		const big = checkpointBody(ID_A).replace("- a", `- ${"x".repeat(5000)}`);
		expect((await world.jot(["kick", "--file", file], cwd, big)).exitCode).toBe(0);
		expect(statSync(file).size).toBeGreaterThan(5000);
	});
});

describe("jot kick-list", () => {
	test("prints id and summary rows in file order", async () => {
		const { cwd, file } = fixture();
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_A, "alpha work"));
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_B, "beta work"));
		const run = await world.jot(["kick-list", "--file", file], cwd);
		expect(run.stdout.trim().split("\n")).toEqual([`${ID_A}\talpha work`, `${ID_B}\tbeta work`]);
	});

	test("lists nothing and creates nothing for a missing file", async () => {
		const { cwd, file } = fixture();
		const run = await world.jot(["kick-list", "--file", file], cwd);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toBe("");
		expect(existsSync(dirname(file))).toBe(false);
	});

	test("reads HOME/doc/checkpoint.md by default", async () => {
		const { cwd } = fixture();
		seed(join(world.home, "doc", "checkpoint.md"), `# Checkpoints\n\n${checkpointBody(ID_A, "home work")}`);
		expect((await world.jot(["kick-list"], cwd)).stdout).toBe(`${ID_A}\thome work\n`);
	});
});

describe("jot kick-take", () => {
	test("prints one section and removes only it, keeping the rest byte for byte", async () => {
		const { cwd, file } = fixture();
		seed(file, "# My notes\n\nintro\n");
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_A, "alpha work"));
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_B, "beta work"));
		const reference = join(world.tmp("jot-cp-only-"), "b.md");
		seed(reference, "# My notes\n\nintro\n");
		await world.jot(["kick", "--file", reference], cwd, checkpointBody(ID_B, "beta work"));

		const taken = await world.jot(["kick-take", ID_A, "--file", file], cwd);
		expect(taken.exitCode).toBe(0);
		expect(taken.stdout).toBe(checkpointBody(ID_A, "alpha work"));
		expect(readFileSync(file, "utf8")).toBe(readFileSync(reference, "utf8"));
		expect(leftovers(file)).toEqual([]);
	});

	test("a partial query matches section text case-insensitively", async () => {
		const { cwd, file } = fixture();
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_A, "alpha work"));
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_B, "beta work"));
		const run = await world.jot(["kick-take", "JOT MODES", "--file", file], cwd);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain(`## ${ID_B}`);
		expect(readFileSync(file, "utf8")).not.toContain(ID_B);
	});

	test("an exact id wins over other sections whose text mentions it", async () => {
		const { cwd, file } = fixture();
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_A, "alpha work"));
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_B, `follows ${ID_A}`));
		const run = await world.jot(["kick-take", ID_A, "--file", file], cwd);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toBe(checkpointBody(ID_A, "alpha work"));
		expect(readFileSync(file, "utf8")).toContain(`## ${ID_B}`);
	});

	test("the last section deletes a file that holds only the CLI header", async () => {
		const { cwd, file } = fixture();
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_A));
		const taken = await world.jot(["kick-take", ID_A, "--file", file], cwd);
		expect(taken.exitCode).toBe(0);
		expect(taken.stdout).toBe(checkpointBody(ID_A));
		expect(existsSync(file)).toBe(false);
		expect(leftovers(file)).toEqual([]);
	});

	test("the last section keeps a file that holds other text and says so on stderr", async () => {
		const { cwd, file } = fixture();
		seed(file, "# My notes\n\nintro\n");
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_A));
		const kept = await world.jot(["kick-take", ID_A, "--file", file], cwd);
		expect(kept.exitCode).toBe(0);
		expect(kept.stderr).toContain(`kept ${file}: it has text besides the CLI header`);
		expect(readFileSync(file, "utf8")).toBe("# My notes\n\nintro\n");
	});

	test("an ambiguous query removes nothing, lists the matches and exits 1", async () => {
		const { cwd, file } = fixture();
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_A, "alpha work"));
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_B, "beta work"));
		const before = readFileSync(file, "utf8");
		const many = await world.jot(["kick-take", "work", "--file", file], cwd);
		expect(many.exitCode).toBe(1);
		expect(many.stdout.trim().split("\n")).toEqual([`${ID_A}\talpha work`, `${ID_B}\tbeta work`]);
		expect(many.stderr).toContain('2 sections match "work"; rerun with the full id');
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	test("an unmatched query exits 1 and removes nothing", async () => {
		const { cwd, file } = fixture();
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_A));
		const before = readFileSync(file, "utf8");
		const none = await world.jot(["kick-take", "zzz", "--file", file], cwd);
		expect(none.exitCode).toBe(1);
		expect(none.stdout).toBe("");
		expect(none.stderr).toContain('no checkpoint matches "zzz"');
		expect(readFileSync(file, "utf8")).toBe(before);
	});

	test("a query equal to a subcommand word is a query", async () => {
		const { cwd, file } = fixture();
		await world.jot(["kick", "--file", file], cwd, checkpointBody("2026-10-13 1600 — x — kick-take plan"));
		const run = await world.jot(["kick-take", "kick-take", "--file", file], cwd);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("kick-take plan");
	});

	test("a missing query fails with the fix", async () => {
		const { cwd, file } = fixture();
		const run = await world.jot(["kick-take", "--file", file], cwd);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("missing id or text");
	});

	test("a missing file fails without creating a file or directory", async () => {
		const { cwd, file } = fixture();
		const run = await world.jot(["kick-take", "x", "--file", file], cwd);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain('no checkpoint matches "x"');
		expect(existsSync(file)).toBe(false);
		expect(existsSync(dirname(file))).toBe(false);
	});

	test("a take through the default file reads HOME/doc/checkpoint.md", async () => {
		const { cwd } = fixture();
		await world.jot(["kick"], cwd, checkpointBody(ID_A));
		const taken = await world.jot(["kick-take", ID_A], cwd);
		expect(taken.stdout).toBe(checkpointBody(ID_A));
		expect(existsSync(join(world.home, "doc", "checkpoint.md"))).toBe(false);
	});
});

describe("checkpoint lock and atomic write", () => {
	test("a held lock stops a writer with a message and leaves the file and lock alone", async () => {
		const { cwd, file } = fixture();
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_A));
		const before = readFileSync(file, "utf8");
		writeFileSync(`${file}.lock`, String(process.pid));
		const run = await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_B));
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain(`${file}.lock is held`);
		expect(readFileSync(file, "utf8")).toBe(before);
		expect(existsSync(`${file}.lock`)).toBe(true);
	});

	test.skipIf(process.getuid?.() === 0)("an unwritable checkpoint directory reports the real error without waiting", async () => {
		const { cwd, file } = fixture();
		seed(file, checkpointBody(ID_A));
		chmodSync(dirname(file), 0o500);
		let run: Awaited<ReturnType<typeof world.jot>>;
		try {
			run = await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_B));
		} finally {
			chmodSync(dirname(file), 0o700);
		}
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("EACCES");
		expect(run.stderr).not.toContain("is held");
	});

	test("a rewrite keeps the file mode", async () => {
		const { cwd, file } = fixture();
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_A));
		chmodSync(file, 0o600);
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_B));
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	test("a lock whose owner process is gone is taken over", async () => {
		const { cwd, file } = fixture();
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_A));
		writeFileSync(`${file}.lock`, "2147483646");
		const run = await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_B));
		expect(run.exitCode).toBe(0);
		expect(readFileSync(file, "utf8")).toContain(`## ${ID_B}`);
		expect(existsSync(`${file}.lock`)).toBe(false);
	});

	test("an empty lock left by a crash between create and write becomes stale and is taken over", async () => {
		const { cwd, file } = fixture();
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_A));
		writeFileSync(`${file}.lock`, "");
		const run = await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_B));
		expect(run.exitCode).toBe(0);
		expect(readFileSync(file, "utf8")).toContain(`## ${ID_B}`);
		expect(existsSync(`${file}.lock`)).toBe(false);
	});

	test.skipIf(!existsSync("/dev/full"))("kick-take keeps the section when stdout cannot be written", async () => {
		const { cwd, file } = fixture();
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_A));
		const entry = join(import.meta.dir, "../src/index.ts");
		const proc = Bun.spawn(
			["sh", "-c", `"$0" run "$1" jot kick-take "$2" --file "$3" >/dev/full`, process.execPath, entry, ID_A, file],
			{ cwd, env: world.env(), stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;
		expect(readFileSync(file, "utf8")).toContain(`## ${ID_A}`);
	});

	test("a held lock also stops kick-take without removing the section", async () => {
		const { cwd, file } = fixture();
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_A));
		writeFileSync(`${file}.lock`, String(process.pid));
		const run = await world.jot(["kick-take", ID_A, "--file", file], cwd);
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("is held");
		expect(readFileSync(file, "utf8")).toContain(`## ${ID_A}`);
	});

	test("the lock is released after a success and after a rejected write", async () => {
		const { cwd, file } = fixture();
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_A));
		expect(existsSync(`${file}.lock`)).toBe(false);
		const duplicate = await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_A));
		expect(duplicate.exitCode).toBe(1);
		expect(existsSync(`${file}.lock`)).toBe(false);
		const ambiguous = await world.jot(["kick-take", "zzz", "--file", file], cwd);
		expect(ambiguous.exitCode).toBe(1);
		expect(existsSync(`${file}.lock`)).toBe(false);
	});

	test("a write replaces the file by rename so a reader never sees a partial file", async () => {
		const { cwd, file } = fixture();
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_A));
		const inode = statSync(file).ino;
		await world.jot(["kick", "--file", file], cwd, checkpointBody(ID_B));
		expect(statSync(file).ino).not.toBe(inode);
		expect(leftovers(file)).toEqual([]);
	});

	test("parallel writers each land their section and leave no temp or lock file", async () => {
		const { cwd, file } = fixture();
		const ids = [1, 2, 3, 4].map((n) => `2026-10-13 160${n} — par — writer ${n}`);
		const runs = await Promise.all(ids.map((id) => world.jot(["kick", "--file", file], cwd, checkpointBody(id))));
		expect(runs.map((run) => run.exitCode)).toEqual([0, 0, 0, 0]);
		const listed = (await world.jot(["kick-list", "--file", file], cwd)).stdout
			.trim()
			.split("\n")
			.map((row) => row.split("\t")[0])
			.sort();
		expect(listed).toEqual([...ids].sort());
		expect(leftovers(file)).toEqual([]);
	});
});
