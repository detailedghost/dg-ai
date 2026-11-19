import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { appendFileSync, truncateSync, writeFileSync } from "node:fs";
import { runJobLogs } from "../../src/commands/job-logs";
import { freshTempDir, ENTRY, subprocessEnv } from "../utils/daemon-harness";
import {
	homeTracker,
	lines,
	logFileOf,
	pathsOf,
	runCli,
	seedJobs,
	sleeperEntry,
	waitUntil,
	writeLog,
} from "./job-cli-helpers";

const homes = homeTracker();
const children: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
	for (const child of children.splice(0)) child.kill("SIGKILL");
	await homes.cleanup();
});

const numbered = (count: number) =>
	Array.from({ length: count }, (_, i) => `line ${i + 1}`);
const withNewlines = (rows: string[]) => `${rows.join("\n")}\n`;

function seededHome() {
	const dgHome = homes.fresh();
	seedJobs(dgHome, { x: sleeperEntry(freshTempDir("job-cwd")) });
	return dgHome;
}

function follow(dgHome: string, extra: string[] = []) {
	const proc = Bun.spawn(
		[process.execPath, ENTRY, "job", "logs", "x", "-f", ...extra],
		{ env: subprocessEnv(dgHome, 0), stdout: "pipe", stderr: "pipe" },
	);
	children.push(proc);
	const seen = { out: "", err: "" };
	const pump = async (stream: ReadableStream<Uint8Array>, key: "out" | "err") => {
		const decoder = new TextDecoder();
		for await (const chunk of stream) seen[key] += decoder.decode(chunk);
	};
	void pump(proc.stdout as ReadableStream<Uint8Array>, "out");
	void pump(proc.stderr as ReadableStream<Uint8Array>, "err");
	return { proc, seen };
}

describe("job logs", () => {
	it("prints the last 40 lines by default", async () => {
		const dgHome = seededHome();
		writeLog(dgHome, "x", withNewlines(numbered(100)));

		const result = await runCli(dgHome, ["job", "logs", "x"]);

		expect(result.code).toBe(0);
		expect(lines(result.stdout)).toEqual(numbered(100).slice(-40));
	});

	it("prints the last 5 lines for -n 5 and each line of a short file", async () => {
		const dgHome = seededHome();
		writeLog(dgHome, "x", withNewlines(numbered(100)));
		const five = await runCli(dgHome, ["job", "logs", "x", "-n", "5"]);
		const long = await runCli(dgHome, ["job", "logs", "x", "--lines", "5"]);
		writeLog(dgHome, "x", withNewlines(numbered(3)));
		const short = await runCli(dgHome, ["job", "logs", "x"]);

		expect(lines(five.stdout)).toEqual(numbered(100).slice(-5));
		expect(lines(long.stdout)).toEqual(numbered(100).slice(-5));
		expect(lines(short.stdout)).toEqual(numbered(3));
	});

	it("leaves a last line with no newline out of the tail", async () => {
		const dgHome = seededHome();
		writeLog(dgHome, "x", "one\ntwo\npart");

		const result = await runCli(dgHome, ["job", "logs", "x"]);

		expect(lines(result.stdout)).toEqual(["one", "two"]);
	});

	it("exits 1 with the path when no log exists yet", async () => {
		const dgHome = seededHome();

		const result = await runCli(dgHome, ["job", "logs", "x"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			`no log for job "x" yet: ${logFileOf(dgHome, "x")}`,
		);
	});

	it("reports an unknown name before it checks --lines", async () => {
		const dgHome = seededHome();

		const result = await runCli(dgHome, ["job", "logs", "ghost", "-n", "0"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('no job named "ghost"');
		expect(result.stderr).not.toContain("--lines must be");
	});

	it("refuses --lines that is 0 or not a number", async () => {
		const dgHome = seededHome();
		writeLog(dgHome, "x", "one\n");
		for (const bad of ["0", "x", "1e1", "0x10", " 5"]) {
			const result = await runCli(dgHome, ["job", "logs", "x", "-n", bad]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain(
				"--lines must be a whole number of 1 or more",
			);
		}
	});

	it("names an unknown job before it looks for a file", async () => {
		const dgHome = homes.fresh();
		seedJobs(dgHome, {});

		const result = await runCli(dgHome, ["job", "logs", "ghost"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain('no job named "ghost"');
	});

	it("needs no daemon", async () => {
		const dgHome = seededHome();
		writeLog(dgHome, "x", "one\n");

		const result = await runCli(dgHome, ["job", "logs", "x"]);

		expect(result.code).toBe(0);
		expect(result.stderr).not.toContain("no live dg-daemon");
	});
});

describe("job logs -f", () => {
	it("prints the last lines, then each new line, and exits 0 on SIGINT", async () => {
		const dgHome = seededHome();
		const file = writeLog(dgHome, "x", withNewlines(numbered(3)));
		const { proc, seen } = follow(dgHome);
		await waitUntil(() => seen.out.includes("line 3"));

		appendFileSync(file, "fresh\n");
		await waitUntil(() => seen.out.includes("fresh"));
		proc.kill("SIGINT");

		expect(await proc.exited).toBe(0);
		expect(lines(seen.out)).toEqual([...numbered(3), "fresh"]);
	});

	it("prints waiting for the path one time, then the first lines when the file appears", async () => {
		const dgHome = seededHome();
		const file = logFileOf(dgHome, "x");
		const { proc, seen } = follow(dgHome);
		await waitUntil(() => seen.err.includes(`waiting for ${file}`));
		await Bun.sleep(1200);

		writeLog(dgHome, "x", "first\nsecond\n");
		await waitUntil(() => seen.out.includes("second"));
		proc.kill("SIGINT");

		await proc.exited;
		expect(seen.err.split(`waiting for ${file}`).length - 1).toBe(1);
		expect(lines(seen.out)).toEqual(["first", "second"]);
	});

	it("continues after the file is truncated in place", async () => {
		const dgHome = seededHome();
		const file = writeLog(dgHome, "x", withNewlines(numbered(5)));
		const { proc, seen } = follow(dgHome);
		await waitUntil(() => seen.out.includes("line 5"));

		truncateSync(file, 0);
		appendFileSync(file, "after rotation\n");
		await waitUntil(() => seen.out.includes("after rotation"));
		proc.kill("SIGINT");

		expect(await proc.exited).toBe(0);
		expect(lines(seen.out)).toEqual([...numbered(5), "after rotation"]);
	});

	it("resolves in process when the signal aborts", async () => {
		const dgHome = seededHome();
		const file = writeLog(dgHome, "x", withNewlines(numbered(2)));
		const printed: string[] = [];
		const log = spyOn(console, "log").mockImplementation((line: string) => {
			printed.push(line);
		});
		const controller = new AbortController();
		try {
			const done = runJobLogs(
				pathsOf(dgHome),
				"x",
				{ follow: true },
				controller.signal,
			);
			await waitUntil(() => printed.includes("line 2"));
			appendFileSync(file, "fresh\n");
			await waitUntil(() => printed.includes("fresh"));
			controller.abort();

			await expect(done).resolves.toBeUndefined();
			expect(printed).toEqual([...numbered(2), "fresh"]);
		} finally {
			log.mockRestore();
		}
	});

	it("prints a last line with no newline one time, when its newline arrives", async () => {
		const dgHome = seededHome();
		const file = writeLog(dgHome, "x", "one\npart");
		const { proc, seen } = follow(dgHome);
		await waitUntil(() => seen.out.includes("one"));
		await Bun.sleep(1200);
		expect(seen.out).not.toContain("part");

		appendFileSync(file, "ial\n");
		await waitUntil(() => seen.out.includes("partial"));
		await Bun.sleep(1200);
		proc.kill("SIGINT");

		await proc.exited;
		expect(lines(seen.out)).toEqual(["one", "partial"]);
	});

	it("follows a file that another writer rewrites in place", async () => {
		const dgHome = seededHome();
		const file = writeLog(dgHome, "x", "a\n");
		const { proc, seen } = follow(dgHome, ["-n", "1"]);
		await waitUntil(() => seen.out.includes("a"));

		writeFileSync(file, "a\nb\n");
		await waitUntil(() => seen.out.includes("b"));
		proc.kill("SIGINT");

		await proc.exited;
		expect(lines(seen.out)).toEqual(["a", "b"]);
	});
});
