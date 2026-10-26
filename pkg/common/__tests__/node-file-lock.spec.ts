import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { withFileLock } from "../src/node/file-lock";

function tempFile(): { dir: string; file: string } {
	const dir = mkdtempSync(join(tmpdir(), "dg-file-lock-"));
	return { dir, file: join(dir, "payload.txt") };
}

async function withTempFile<T>(run: (file: string) => Promise<T> | T): Promise<T> {
	const { dir, file } = tempFile();
	try {
		return await run(file);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("withFileLock", () => {
	test("runs fn once and leaves no lock file behind", async () => {
		await withTempFile(async (file) => {
			const result = await withFileLock(file, () => "done");
			expect(result).toBe("done");
			expect(existsSync(`${file}.lock`)).toBe(false);
		});
	});

	test("serializes same-process callers so none are lost", async () => {
		await withTempFile(async (file) => {
			const order: number[] = [];
			await Promise.all([1, 2, 3].map((n) => withFileLock(file, () => void order.push(n))));
			expect(order.sort()).toEqual([1, 2, 3]);
			expect(existsSync(`${file}.lock`)).toBe(false);
		});
	});

	test("a lock whose owner process is gone is taken over, including when the pid is wrapped in whitespace", async () => {
		await withTempFile(async (file) => {
			const lock = `${file}.lock`;
			writeFileSync(lock, "\n2147483646\n");
			const future = new Date(Date.now() + 60_000);
			utimesSync(lock, future, future);
			await withFileLock(file, () => undefined);
			expect(existsSync(lock)).toBe(false);
		});
	}, 20_000);

	test("a lock held by this process is not taken over, including when the pid is wrapped in whitespace", async () => {
		await withTempFile(async (file) => {
			const lock = `${file}.lock`;
			writeFileSync(lock, `\n${process.pid}\n`);
			await expect(withFileLock(file, () => undefined)).rejects.toThrow(/is held/);
			expect(existsSync(lock)).toBe(true);
		});
	}, 20_000);

	test("a lock naming a non-positive pid is not taken over", async () => {
		await withTempFile(async (file) => {
			const lock = `${file}.lock`;
			writeFileSync(lock, " -99\n");
			await expect(withFileLock(file, () => undefined)).rejects.toThrow(/is held/);
			expect(existsSync(lock)).toBe(true);
		});
	}, 20_000);

	test("whitespace or non-numeric lock content is reclaimed once the grace period has passed", async () => {
		for (const body of ["not-a-pid", "   ", "\n\t", "123abc"]) {
			await withTempFile(async (file) => {
				const lock = `${file}.lock`;
				writeFileSync(lock, body);
				const past = new Date(Date.now() - 10_000);
				utimesSync(lock, past, past);
				await withFileLock(file, () => undefined);
				expect(existsSync(lock)).toBe(false);
			});
		}
	}, 20_000);

	test("whitespace or non-numeric lock content is left in place during the grace period", async () => {
		await withTempFile(async (file) => {
			const lock = `${file}.lock`;
			writeFileSync(lock, "not-a-pid");
			const future = new Date(Date.now() + 60_000);
			utimesSync(lock, future, future);
			await expect(withFileLock(file, () => undefined)).rejects.toThrow(/is held/);
			expect(existsSync(lock)).toBe(true);
		});
	}, 20_000);

	test("an empty lock left by a crash between create and write becomes stale after a short grace period", async () => {
		await withTempFile(async (file) => {
			const lock = `${file}.lock`;
			writeFileSync(lock, "");
			await withFileLock(file, () => undefined);
			expect(existsSync(lock)).toBe(false);
		});
	}, 20_000);

	test("several callers queued on the same dead-pid lock all run, serially, and leave no lock file", async () => {
		await withTempFile(async (file) => {
			const lock = `${file}.lock`;
			writeFileSync(lock, "2147483646");
			const order: string[] = [];
			await Promise.all(["a", "b", "c", "d"].map((id) => withFileLock(file, () => void order.push(id))));
			expect(order.sort()).toEqual(["a", "b", "c", "d"]);
			expect(existsSync(lock)).toBe(false);
		});
	}, 20_000);

	test("a thrown fn releases the lock without leaving it behind", async () => {
		await withTempFile(async (file) => {
			const lock = `${file}.lock`;
			await expect(
				withFileLock(file, () => {
					throw new Error("boom");
				}),
			).rejects.toThrow("boom");
			expect(existsSync(lock)).toBe(false);
		});
	});
});

const CONTENDERS = 8;
const CONTENTION_ROUNDS = 20;

function contentionWorkerSource(): string {
	const fileLock = JSON.stringify(join(import.meta.dir, "../src/node/file-lock.ts"));
	return `
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withFileLock } from ${fileLock};

const gateRoot = process.env.GATE_ROOT;
const rounds = Number(process.env.ROUNDS);
const count = Number(process.env.WORKERS);
const id = process.env.WORKER_ID;
const dataFile = process.env.DATA_FILE;
if (!gateRoot || !id || !dataFile) throw new Error("missing worker env");

for (let round = 0; round < rounds; round++) {
	const gate = join(gateRoot, String(round));
	const deadline = Date.now() + 20000;
	while (!existsSync(gate)) {
		if (Date.now() > deadline) throw new Error("timed out waiting for round " + round);
	}
	writeFileSync(join(gate, id), "ready");
	while (readdirSync(gate).filter((name) => !name.endsWith(".done")).length < count) {
		if (Date.now() > deadline) throw new Error("timed out at the barrier for round " + round);
	}
	await withFileLock(dataFile, () => {
		const current = existsSync(dataFile) ? JSON.parse(readFileSync(dataFile, "utf8")) : [];
		current.push(id + "-" + round);
		writeFileSync(dataFile, JSON.stringify(current));
	});
	writeFileSync(join(gate, id + ".done"), "1");
}
`;
}

test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
	"several processes contending on one dead-pid lock each land their update and leave no lock file",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "dg-file-lock-contend-"));
		const dataFile = join(root, "data", "payload.json");
		const procs: ReturnType<typeof Bun.spawn>[] = [];
		const stderrs: Promise<string>[] = [];
		try {
			mkdirSync(dirname(dataFile), { recursive: true });
			const gateRoot = join(root, "gates");
			mkdirSync(gateRoot, { recursive: true });
			const source = contentionWorkerSource();
			for (let i = 0; i < CONTENDERS; i++) {
				const proc = Bun.spawn([process.execPath, "-e", source], {
					cwd: join(import.meta.dir, ".."),
					env: {
						...process.env,
						GATE_ROOT: gateRoot,
						ROUNDS: String(CONTENTION_ROUNDS),
						WORKERS: String(CONTENDERS),
						WORKER_ID: `w${i}`,
						DATA_FILE: dataFile,
					},
					stdin: "ignore",
					stdout: "ignore",
					stderr: "pipe",
				});
				procs.push(proc);
				stderrs.push(new Response(proc.stderr).text());
			}
			const losses: string[] = [];
			for (let round = 0; round < CONTENTION_ROUNDS; round++) {
				rmSync(dirname(dataFile), { recursive: true, force: true });
				mkdirSync(dirname(dataFile), { recursive: true });
				writeFileSync(`${dataFile}.lock`, "2147483646");
				mkdirSync(join(gateRoot, String(round)));
				const deadline = Date.now() + 20_000;
				while (readdirSync(join(gateRoot, String(round))).filter((name) => name.endsWith(".done")).length < CONTENDERS) {
					if (Date.now() > deadline || procs.some((proc) => proc.exitCode !== null && proc.exitCode !== 0)) {
						for (const proc of procs) proc.kill();
						const stderr = (await Promise.all(stderrs)).filter(Boolean).join("\n");
						throw new Error(`round ${round} did not finish\n${stderr}`);
					}
					await Bun.sleep(10);
				}
				const got = existsSync(dataFile) ? (JSON.parse(readFileSync(dataFile, "utf8")) as string[]).sort() : [];
				const want = Array.from({ length: CONTENDERS }, (_, i) => `w${i}-${round}`).sort();
				if (got.join("\n") !== want.join("\n")) losses.push(`round ${round} kept [${got.join(", ")}]`);
				const stray = readdirSync(dirname(dataFile)).filter((name) => name !== "payload.json");
				if (stray.length > 0) losses.push(`round ${round} left [${stray.join(", ")}]`);
			}
			expect(losses).toEqual([]);
			expect(await Promise.all(procs.map((proc) => proc.exited))).toEqual(Array.from({ length: CONTENDERS }, () => 0));
		} finally {
			for (const proc of procs) {
				if (proc.exitCode !== null) continue;
				try {
					proc.kill();
				} catch {}
			}
			await Promise.all(procs.map((proc) => proc.exited.catch(() => undefined)));
			rmSync(root, { recursive: true, force: true });
		}
	},
	90_000,
);
