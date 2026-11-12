import { afterEach, describe, expect, it } from "bun:test";
import { cleanupDgHome, freshDgHome, freshTempDir } from "../utils/daemon-harness";
import { runCli } from "./service-cli-helpers";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) cleanupDgHome(home);
});

async function prepared() {
	const dgHome = freshDgHome();
	homes.push(dgHome);
	const add = await runCli(dgHome, [
		"job", "add", "--label", "x", "--every", "15m", "--cwd", freshTempDir("job-cwd"),
		"--", "printf", '{"id":"a","title":"A"}\n',
	]);
	expect(add.code).toBe(0);
	return dgHome;
}

describe("job exec", () => {
	it("gives the same stdout, stderr and exit code as job run", async () => {
		const viaRun = await runCli(await prepared(), ["job", "run", "x"]);
		const viaExec = await runCli(await prepared(), ["job", "exec", "x"]);
		expect(viaRun.code).toBe(0);
		expect(viaExec).toEqual(viaRun);
	});

	it("fails the same way as job run for an unknown label", async () => {
		const dgHome = await prepared();
		const viaRun = await runCli(dgHome, ["job", "run", "ghost"]);
		const viaExec = await runCli(dgHome, ["job", "exec", "ghost"]);
		expect(viaRun.code).toBe(1);
		expect(viaExec).toEqual(viaRun);
	});
});
