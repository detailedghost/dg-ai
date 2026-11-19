import { afterEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { freshTempDir } from "../utils/daemon-harness";
import {
	type Booted,
	bootSeeded,
	seedHome,
} from "../jobs/scheduled-fixtures";
import { runCli } from "./service-cli-helpers";

setDefaultTimeout(30_000);

const booted: Booted[] = [];
afterEach(async () => {
	for (const daemon of booted.splice(0)) await daemon.dispose();
});

async function prepared() {
	const cwd = freshTempDir("job-cwd");
	const daemon = await bootSeeded({
		jobsVersion: 2,
		jobs: {
			x: {
				every: "15m",
				argv: ["printf", '{"id":"a","title":"A"}\n'],
				cwd,
				feed: true,
			},
		},
	});
	booted.push(daemon);
	return daemon;
}

const NOTE_OR_HOME = /^(note:|dg home:)/;
const withoutNotes = (stderr: string): string =>
	stderr
		.split("\n")
		.filter((line) => !NOTE_OR_HOME.test(line))
		.join("\n");

describe("job exec", () => {
	it("gives the same stdout, stderr and exit code as job run", async () => {
		const one = await prepared();
		const two = await prepared();
		const viaRun = await runCli(one.dgHome, ["job", "run", "x"], {
			port: one.port,
		});
		const viaExec = await runCli(two.dgHome, ["job", "exec", "x"], {
			port: two.port,
		});
		expect(viaRun.code).toBe(0);
		expect(viaExec.code).toBe(viaRun.code);
		expect(viaExec.stdout).toBe(viaRun.stdout);
		expect(withoutNotes(viaExec.stderr)).toBe(withoutNotes(viaRun.stderr));
		expect(viaRun.stderr).toContain(
			'note: "job run" is now "job start"; this form goes away in the next major release',
		);
		expect(viaExec.stderr).toContain(
			'note: "job exec" is now "job start"; this form goes away in the next major release',
		);
	});

	it("fails the same way as job run for an unknown label", async () => {
		const { dgHome, port } = await prepared();
		const viaRun = await runCli(dgHome, ["job", "run", "ghost"], { port });
		const viaExec = await runCli(dgHome, ["job", "exec", "ghost"], { port });
		expect(viaRun.code).toBe(1);
		expect(viaExec.code).toBe(viaRun.code);
		expect(viaExec.stdout).toBe(viaRun.stdout);
		expect(withoutNotes(viaExec.stderr)).toBe(withoutNotes(viaRun.stderr));
	});

	it("needs a live daemon for job run and job exec of a scheduled job", async () => {
		const { dgHome } = await seedHome({
			jobsVersion: 2,
			jobs: {
				x: {
					every: "15m",
					argv: ["printf", ""],
					cwd: freshTempDir("job-cwd"),
				},
			},
		});

		for (const verb of ["run", "exec"]) {
			const result = await runCli(dgHome, ["job", verb, "x"]);
			expect(result.code).toBe(1);
			expect(result.stderr).toContain("no live dg-daemon");
		}
	});
});
