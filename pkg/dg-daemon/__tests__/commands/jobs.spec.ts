import { describe, expect, it } from "bun:test";
import { resolveDgPaths } from "@dg/common/node";
import { parseEvery } from "../../src/commands/jobs";
import {
	ChatStore,
	cleanupDgHome,
	ENTRY,
	FILE_ONLY_SEAMS,
	freshDgHome,
	subprocessEnv,
} from "../utils/daemon-harness";

type RunResult = { code: number; stdout: string; stderr: string };

async function dg(dgHome: string, ...args: string[]): Promise<RunResult> {
	const proc = Bun.spawn([process.execPath, ENTRY, ...args], {
		env: subprocessEnv(dgHome, 0),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

async function withHome(run: (dgHome: string) => Promise<void>): Promise<void> {
	const dgHome = freshDgHome();
	try {
		await run(dgHome);
	} finally {
		cleanupDgHome(dgHome);
	}
}

async function openStore(dgHome: string): Promise<ChatStore> {
	return ChatStore.open(
		resolveDgPaths({ env: { DG_HOME: dgHome } }),
		FILE_ONLY_SEAMS,
	);
}

describe("parseEvery", () => {
	it("reads seconds, minutes and hours", () => {
		expect(parseEvery("30s")).toBe(30_000);
		expect(parseEvery("15m")).toBe(15 * 60_000);
		expect(parseEvery("2h")).toBe(2 * 60 * 60_000);
	});

	it("refuses a value with no unit, a bad unit, or a non-positive count", () => {
		for (const bad of ["30", "15x", "0m", "-5m", "m", "", "1.5m"]) {
			expect(() => parseEvery(bad)).toThrow();
		}
	});
});

describe("dg-daemon job add", () => {
	it("stores the job and reports its next run", async () => {
		await withHome(async (dgHome) => {
			const result = await dg(
				dgHome,
				"job",
				"add",
				"--label",
				"jira-sprint",
				"--every",
				"15m",
				"--cwd",
				process.cwd(),
				"--",
				"printf",
				'{"id":"a","title":"A"}\n',
			);
			expect(result.code).toBe(0);

			const store = await openStore(dgHome);
			try {
				const job = store.getJobByLabel("jira-sprint");
				expect(job).toBeDefined();
				expect(job?.intervalMs).toBe(15 * 60_000);
				expect(job?.argv[0]).toBe("printf");
				expect(job?.enabled).toBe(true);
				expect(store.dueJobs(new Date()).map((due) => due.label)).toEqual([
					"jira-sprint",
				]);
			} finally {
				store.close();
			}
		});
	});

	it("keeps the notify identity when one is given", async () => {
		await withHome(async (dgHome) => {
			await dg(
				dgHome,
				"job",
				"add",
				"--label",
				"noisy",
				"--every",
				"5m",
				"--cwd",
				process.cwd(),
				"--notify",
				"reviewer",
				"--",
				"printf",
				"",
			);

			const store = await openStore(dgHome);
			try {
				expect(store.getJobByLabel("noisy")?.notifyIdentity).toBe("reviewer");
			} finally {
				store.close();
			}
		});
	});

	it("refuses a duplicate label and changes nothing", async () => {
		await withHome(async (dgHome) => {
			const args = [
				"job",
				"add",
				"--label",
				"once",
				"--every",
				"5m",
				"--cwd",
				process.cwd(),
				"--",
				"printf",
				"",
			];
			expect((await dg(dgHome, ...args)).code).toBe(0);
			const second = await dg(dgHome, ...args);
			expect(second.code).not.toBe(0);

			const store = await openStore(dgHome);
			try {
				expect(store.listJobs()).toHaveLength(1);
			} finally {
				store.close();
			}
		});
	});

	it("refuses a command that does not resolve on PATH", async () => {
		await withHome(async (dgHome) => {
			const result = await dg(
				dgHome,
				"job",
				"add",
				"--label",
				"ghost",
				"--every",
				"5m",
				"--cwd",
				process.cwd(),
				"--",
				"definitely-not-a-real-binary-xyz",
			);
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("PATH");

			const store = await openStore(dgHome);
			try {
				expect(store.listJobs()).toHaveLength(0);
			} finally {
				store.close();
			}
		});
	});

	it("refuses a bad --every, naming the value", async () => {
		await withHome(async (dgHome) => {
			const result = await dg(
				dgHome,
				"job",
				"add",
				"--label",
				"bad",
				"--every",
				"soon",
				"--cwd",
				process.cwd(),
				"--",
				"printf",
				"",
			);
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("soon");
		});
	});

	it("refuses a working directory that does not exist", async () => {
		await withHome(async (dgHome) => {
			const result = await dg(
				dgHome,
				"job",
				"add",
				"--label",
				"nowhere",
				"--every",
				"5m",
				"--cwd",
				"/definitely/not/here",
				"--",
				"printf",
				"",
			);
			expect(result.code).not.toBe(0);
		});
	});

	it("refuses an empty command", async () => {
		await withHome(async (dgHome) => {
			const result = await dg(
				dgHome,
				"job",
				"add",
				"--label",
				"empty",
				"--every",
				"5m",
				"--cwd",
				process.cwd(),
			);
			expect(result.code).not.toBe(0);
		});
	});
});

describe("dg-daemon job list", () => {
	it("says so plainly when nothing is scheduled", async () => {
		await withHome(async (dgHome) => {
			const result = await dg(dgHome, "job", "list");
			expect(result.code).toBe(0);
			expect(result.stdout.trim().length).toBeGreaterThan(0);
		});
	});

	it("shows the label, interval and state of each job", async () => {
		await withHome(async (dgHome) => {
			await dg(
				dgHome,
				"job",
				"add",
				"--label",
				"jira-sprint",
				"--every",
				"15m",
				"--cwd",
				process.cwd(),
				"--",
				"printf",
				"",
			);

			const result = await dg(dgHome, "job", "list");
			expect(result.stdout).toContain("jira-sprint");
			expect(result.stdout).toContain("15m");
		});
	});
});

describe("dg-daemon job enable, disable, rm and run", () => {
	async function addOne(dgHome: string, label = "j"): Promise<void> {
		await dg(
			dgHome,
			"job",
			"add",
			"--label",
			label,
			"--every",
			"5m",
			"--cwd",
			process.cwd(),
			"--",
			"printf",
			'{"id":"a","title":"From the CLI"}\n',
		);
	}

	it("flips only the enabled flag", async () => {
		await withHome(async (dgHome) => {
			await addOne(dgHome);
			expect((await dg(dgHome, "job", "disable", "j")).code).toBe(0);

			let store = await openStore(dgHome);
			try {
				expect(store.getJobByLabel("j")?.enabled).toBe(false);
			} finally {
				store.close();
			}

			expect((await dg(dgHome, "job", "enable", "j")).code).toBe(0);
			store = await openStore(dgHome);
			try {
				expect(store.getJobByLabel("j")?.enabled).toBe(true);
			} finally {
				store.close();
			}
		});
	});

	it("removes a job and its feed items", async () => {
		await withHome(async (dgHome) => {
			await addOne(dgHome);
			await dg(dgHome, "job", "run", "j");

			expect((await dg(dgHome, "job", "rm", "j")).code).toBe(0);

			const store = await openStore(dgHome);
			try {
				expect(store.listJobs()).toHaveLength(0);
				expect(store.listFeedItems()).toHaveLength(0);
			} finally {
				store.close();
			}
		});
	});

	it("runs a job now and reports what it added", async () => {
		await withHome(async (dgHome) => {
			await addOne(dgHome);

			const result = await dg(dgHome, "job", "run", "j");
			expect(result.code).toBe(0);

			const store = await openStore(dgHome);
			try {
				const items = store.listFeedItems();
				expect(items).toHaveLength(1);
				expect(items[0].title).toBe("From the CLI");
			} finally {
				store.close();
			}
		});
	});

	it("exits non-zero for an unknown label on every verb", async () => {
		await withHome(async (dgHome) => {
			for (const verb of ["rm", "enable", "disable", "run"]) {
				expect((await dg(dgHome, "job", verb, "absent")).code).not.toBe(0);
			}
		});
	});
});
