import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { addItem } from "../src/stat/checklist";
import { type ChecklistModel, emptyModel } from "../src/stat/model";
import { checklistPath, readChecklist, updateChecklist, writeChecklist } from "../src/stat/store";

async function withIsolatedState<T>(run: () => T | Promise<T>): Promise<T> {
	const root = mkdtempSync(join(tmpdir(), "dg-stat-store-"));
	const prevState = process.env.AI_STATE_DIR;
	const prevHome = process.env.HOME;
	process.env.AI_STATE_DIR = join(root, "state");
	process.env.HOME = join(root, "home");
	try {
		return await run();
	} finally {
		process.env.AI_STATE_DIR = prevState;
		process.env.HOME = prevHome;
		rmSync(root, { recursive: true, force: true });
	}
}

function mustAdd(model: ChecklistModel, text: string) {
	const added = addItem(model, text);
	if (!added.ok) throw new Error("expected add to succeed");
	return added;
}

describe("checklist store", () => {
	test("reading a missing checklist returns an empty model and creates no file", async () => {
		await withIsolatedState(() => {
			const path = checklistPath();
			expect(readChecklist(path)).toEqual(emptyModel());
			expect(readdirSync(dirname(path))).toEqual([]);
		});
	});

	test("writing then reading round-trips the model", async () => {
		await withIsolatedState(() => {
			const path = checklistPath();
			const added = addItem(emptyModel(), "Phone feature to PR", { status: "running" });
			if (!added.ok) throw new Error("expected success");
			writeChecklist(path, added.model);
			expect(readChecklist(path)).toEqual(added.model);
		});
	});

	test("writing leaves no stray temp file behind", async () => {
		await withIsolatedState(() => {
			const path = checklistPath();
			const added = addItem(emptyModel(), "x");
			if (!added.ok) throw new Error("expected success");
			writeChecklist(path, added.model);
			const entries = readdirSync(dirname(path));
			expect(entries).toEqual(["checklist.md"]);
		});
	});

	test("checklistPath resolves under AI_STATE_DIR, not the dg daemon home", async () => {
		await withIsolatedState(() => {
			const path = checklistPath();
			expect(path.startsWith(join(process.env.AI_STATE_DIR as string, "stat"))).toBe(true);
		});
	});

	test("updateChecklist applies concurrent mutations without dropping one", async () => {
		await withIsolatedState(async () => {
			const path = checklistPath();
			await Promise.all(
				["a", "b", "c"].map((text) => updateChecklist(path, (model) => mustAdd(model, text))),
			);
			expect(readChecklist(path).open.map((item) => item.text).sort()).toEqual(["a", "b", "c"]);
			expect(readdirSync(dirname(path)).sort()).toEqual(["checklist.md"]);
		});
	});

	test("a lock whose owner process is gone is taken over, including when the pid is wrapped in whitespace", async () => {
		await withIsolatedState(async () => {
			const path = checklistPath();
			const lock = `${path}.lock`;
			writeFileSync(lock, "\n2147483646\n");
			const future = new Date(Date.now() + 60_000);
			utimesSync(lock, future, future);
			await updateChecklist(path, (model) => mustAdd(model, "next"));
			expect(readChecklist(path).open.map((item) => item.text)).toEqual(["next"]);
			expect(existsSync(lock)).toBe(false);
		});
	});

	test("a lock held by this process is not taken over, including when the pid is wrapped in whitespace", async () => {
		await withIsolatedState(async () => {
			const path = checklistPath();
			writeChecklist(path, mustAdd(emptyModel(), "keep").model);
			writeFileSync(`${path}.lock`, `\n${process.pid}\n`);
			await expect(updateChecklist(path, (model) => mustAdd(model, "next"))).rejects.toThrow(/is held/);
			expect(readChecklist(path).open.map((item) => item.text)).toEqual(["keep"]);
			expect(existsSync(`${path}.lock`)).toBe(true);
		});
	}, 20_000);

	test("a lock naming a non-positive pid is not taken over", async () => {
		await withIsolatedState(async () => {
			const path = checklistPath();
			writeChecklist(path, mustAdd(emptyModel(), "keep").model);
			writeFileSync(`${path}.lock`, " -99\n");
			await expect(updateChecklist(path, (model) => mustAdd(model, "next"))).rejects.toThrow(/is held/);
			expect(readChecklist(path).open.map((item) => item.text)).toEqual(["keep"]);
			expect(existsSync(`${path}.lock`)).toBe(true);
		});
	}, 20_000);

	test("whitespace or non-numeric lock content is reclaimed once the grace period has passed", async () => {
		for (const body of ["not-a-pid", "   ", "\n\t", "123abc"]) {
			await withIsolatedState(async () => {
				const path = checklistPath();
				const lock = `${path}.lock`;
				writeFileSync(lock, body);
				const past = new Date(Date.now() - 10_000);
				utimesSync(lock, past, past);
				await updateChecklist(path, (model) => mustAdd(model, "next"));
				expect(readChecklist(path).open.map((item) => item.text)).toEqual(["next"]);
				expect(existsSync(lock)).toBe(false);
			});
		}
	}, 20_000);

	test("whitespace or non-numeric lock content is left in place during the grace period", async () => {
		await withIsolatedState(async () => {
			const path = checklistPath();
			const lock = `${path}.lock`;
			writeChecklist(path, mustAdd(emptyModel(), "keep").model);
			writeFileSync(lock, "not-a-pid");
			const future = new Date(Date.now() + 60_000);
			utimesSync(lock, future, future);
			await expect(updateChecklist(path, (model) => mustAdd(model, "next"))).rejects.toThrow(/is held/);
			expect(readChecklist(path).open.map((item) => item.text)).toEqual(["keep"]);
			expect(existsSync(lock)).toBe(true);
		});
	}, 20_000);

	test("an empty lock left by a crash between create and write becomes stale after a short grace period", async () => {
		await withIsolatedState(async () => {
			const path = checklistPath();
			writeFileSync(`${path}.lock`, "");
			await updateChecklist(path, (model) => mustAdd(model, "next"));
			expect(readChecklist(path).open.map((item) => item.text)).toEqual(["next"]);
			expect(existsSync(`${path}.lock`)).toBe(false);
		});
	}, 20_000);

	test("several callers queued on the same dead-pid lock all land their update serially, none lost", async () => {
		await withIsolatedState(async () => {
			const path = checklistPath();
			writeFileSync(`${path}.lock`, "2147483646");
			await Promise.all(
				["a", "b", "c", "d"].map((text) => updateChecklist(path, (model) => mustAdd(model, text))),
			);
			expect(readChecklist(path).open.map((item) => item.text).sort()).toEqual(["a", "b", "c", "d"]);
			expect(existsSync(`${path}.lock`)).toBe(false);
		});
	}, 20_000);

	test("a thrown mutation releases the lock and does not write", async () => {
		await withIsolatedState(async () => {
			const path = checklistPath();
			await updateChecklist(path, (model) => mustAdd(model, "keep"));
			await expect(
				updateChecklist(path, () => {
					throw new Error("boom");
				}),
			).rejects.toThrow("boom");
			expect(readChecklist(path).open.map((item) => item.text)).toEqual(["keep"]);
			expect(existsSync(`${path}.lock`)).toBe(false);
		});
	});
});

const CONTENDERS = 8;
const CONTENTION_ROUNDS = 20;

function contentionWorkerSource(): string {
	const store = JSON.stringify(join(import.meta.dir, "../src/stat/store.ts"));
	const checklist = JSON.stringify(join(import.meta.dir, "../src/stat/checklist.ts"));
	return `
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { updateChecklist } from ${store};
import { addItem } from ${checklist};

const gateRoot = process.env.GATE_ROOT;
const rounds = Number(process.env.ROUNDS);
const count = Number(process.env.WORKERS);
const id = process.env.WORKER_ID;
const checklistFile = process.env.CHECKLIST_FILE;
if (!gateRoot || !id || !checklistFile) throw new Error("missing worker env");

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
	await updateChecklist(checklistFile, (model) => {
		const added = addItem(model, id + "-" + round);
		if (!added.ok) throw new Error("add failed for " + id);
		return added;
	});
	writeFileSync(join(gate, id + ".done"), "1");
}
`;
}

// Each round plants one dead-pid lock and lets every process enter together. Callers queued in
// one process take the lock synchronously, so they never overlap one staleness read with another
// process's rename. Linux and Darwin hold an exclusive flock across that decision; this runs there.
test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
	"several processes contending on one dead-pid lock each land their update and leave no lock file",
	async () => {
		const root = mkdtempSync(join(tmpdir(), "dg-stat-contend-"));
		const prevState = process.env.AI_STATE_DIR;
		const prevHome = process.env.HOME;
		process.env.AI_STATE_DIR = join(root, "state");
		process.env.HOME = join(root, "home");
		const procs: ReturnType<typeof Bun.spawn>[] = [];
		const stderrs: Promise<string>[] = [];
		try {
			const path = checklistPath();
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
						CHECKLIST_FILE: path,
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
				rmSync(dirname(path), { recursive: true, force: true });
				mkdirSync(dirname(path), { recursive: true });
				writeFileSync(`${path}.lock`, "2147483646");
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
				const got = readChecklist(path).open.map((item) => item.text).sort();
				const want = Array.from({ length: CONTENDERS }, (_, i) => `w${i}-${round}`).sort();
				if (got.join("\n") !== want.join("\n")) losses.push(`round ${round} kept [${got.join(", ")}]`);
				const stray = readdirSync(dirname(path)).filter((name) => name !== "checklist.md");
				if (stray.length > 0) losses.push(`round ${round} left [${stray.join(", ")}]`);
			}
			expect(losses).toEqual([]);
			expect(await Promise.all(procs.map((proc) => proc.exited))).toEqual(Array.from({ length: CONTENDERS }, () => 0));
		} finally {
			for (const proc of procs) {
				if (proc.exitCode !== null) continue;
				try {
					proc.kill();
				} catch {
					// The process exited between the check and the signal.
				}
			}
			await Promise.all(procs.map((proc) => proc.exited.catch(() => undefined)));
			process.env.AI_STATE_DIR = prevState;
			process.env.HOME = prevHome;
			rmSync(root, { recursive: true, force: true });
		}
	},
	90_000,
);
