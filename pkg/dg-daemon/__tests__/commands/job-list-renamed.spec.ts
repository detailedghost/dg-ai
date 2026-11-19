import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from "bun:test";
import { Command } from "commander";
import { freshDgHome, cleanupDgHome } from "../utils/daemon-harness";
import { seedJobs } from "./job-cli-helpers";

const SCHEDULE_MODULE = "../../src/commands/job-schedule";
const renamedRow = {
	name: "fresh",
	mode: "every",
	enabled: true,
	schedule: "15m",
	lastRunAt: null,
	nextRunAt: null,
	renamedFrom: "old",
};

let real: Record<string, unknown>;
let dgHome: string;
let savedHome: string | undefined;

beforeAll(async () => {
	real = { ...(await import(SCHEDULE_MODULE)) };
	mock.module(SCHEDULE_MODULE, () => ({
		...real,
		listScheduled: async () => [renamedRow],
	}));
	dgHome = freshDgHome();
	seedJobs(dgHome, {});
	savedHome = process.env.DG_HOME;
	process.env.DG_HOME = dgHome;
});

afterAll(() => {
	mock.module(SCHEDULE_MODULE, () => real);
	if (savedHome === undefined) delete process.env.DG_HOME;
	else process.env.DG_HOME = savedHome;
	if (dgHome) cleanupDgHome(dgHome);
});

async function listOutput(extra: string[]): Promise<string[]> {
	const out: string[] = [];
	const log = spyOn(console, "log").mockImplementation((...parts) => {
		out.push(parts.join(" "));
	});
	const err = spyOn(console, "error").mockImplementation(() => {});
	try {
		const { registerJobCommands } = await import("../../src/commands/jobs");
		const program = new Command().exitOverride();
		registerJobCommands(program);
		await program.parseAsync(["node", "dg-daemon", "job", "list", ...extra]);
	} finally {
		log.mockRestore();
		err.mockRestore();
	}
	return out;
}

describe("job list of a renamed scheduled row", () => {
	it("prints was and the old name after the name", async () => {
		const out = await listOutput([]);

		const line = out.find((entry) => entry.startsWith("fresh")) ?? "";
		expect(line.indexOf('was "old"')).toBeGreaterThan("fresh".length - 1);
	});

	it("keeps the key renamedFrom in the --json row", async () => {
		const out = await listOutput(["--json"]);

		const rows = JSON.parse(out.join("")).jobs;
		expect(rows[0].renamedFrom).toBe("old");
	});
});
