import { afterEach, describe, expect, it } from "bun:test";
import { freshTempDir } from "../utils/daemon-harness";
import { homeTracker, runCli, seedJobs, sleeperEntry } from "./job-cli-helpers";

const homes = homeTracker();
afterEach(() => homes.cleanup());

const CMD = [process.execPath, "-e", "1"];

const add = (flags: string[]) => [
	"job",
	"add",
	...flags,
	"--cwd",
	freshTempDir("job-cwd"),
	"--",
	...CMD,
];

describe("removed alias forms of the job group", () => {
	it.each([
		[["--label", "x", "--every", "15m"], "--label"],
		[["--name", "x", "--cron", "0 9 * * *"], "--cron"],
		[["--name", "x", "--continuous", "--pass-env", "PATH"], "--pass-env"],
	])("exits 1 with an unknown option error for %p", async (flags, option) => {
		const result = await runCli(homes.fresh(), add(flags));

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`error: unknown option '${option}'`);
	});

	it.each(["rm", "run", "exec"])(
		"exits 1 with an unknown command error for job %s",
		async (verb) => {
			const dgHome = homes.fresh();
			seedJobs(dgHome, { x: sleeperEntry(freshTempDir("job-cwd")) });

			const result = await runCli(dgHome, ["job", verb, "x"]);

			expect(result.code).toBe(1);
			expect(result.stderr).toContain(`error: unknown command '${verb}'`);
		},
	);
});
