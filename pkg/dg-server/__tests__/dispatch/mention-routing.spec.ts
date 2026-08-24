import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { runCli } from "../commands/cli-wire";
import {
	startWithSession as bootDaemonSession,
	cleanupDgHome,
	deliverUserMessage,
	killDaemonByLockfile,
} from "../utils/daemon-harness";
import { publishSubagents, scratchScriptDir } from "./dispatch-wire";

let dgHome: string;
let scratchDir: string;

afterEach(() => {
	killDaemonByLockfile(dgHome);
	cleanupDgHome(dgHome);
	if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

async function startWithSession() {
	const started = await bootDaemonSession();
	dgHome = started.dgHome;
	return started;
}

describe("@ mention resolution", () => {
	it("resolves an inline @mention against the published subagent list and carries it on the queued message recv delivers", async () => {
		const { port, bootstrap } = await startWithSession();
		scratchDir = scratchScriptDir();
		await publishSubagents(
			dgHome,
			port,
			bootstrap.sessionId,
			["reviewer", "planner"],
			scratchDir,
		);

		const body = "could @reviewer take a look at this";
		await deliverUserMessage(port, bootstrap, body);

		const recv = await runCli(dgHome, port, [
			"recv",
			"--session",
			bootstrap.sessionId,
			"--block",
			"--timeout",
			"3000",
		]);
		expect(recv.exitCode).toBe(0);
		const parsed = JSON.parse(recv.stdout.trim());
		expect(parsed.message.body).toBe(body);
		expect(parsed.message.subagentName).toBe("reviewer");
	}, 10_000);

	it("passes an unresolved mention through as ordinary prose, delivered unchanged with no resolved-name field", async () => {
		const { port, bootstrap } = await startWithSession();
		scratchDir = scratchScriptDir();
		await publishSubagents(
			dgHome,
			port,
			bootstrap.sessionId,
			["reviewer"],
			scratchDir,
		);

		const body = "hey @totallyunregistered can you help";
		await deliverUserMessage(port, bootstrap, body);

		const recv = await runCli(dgHome, port, [
			"recv",
			"--session",
			bootstrap.sessionId,
			"--block",
			"--timeout",
			"3000",
		]);
		expect(recv.exitCode).toBe(0);
		const parsed = JSON.parse(recv.stdout.trim());
		expect(parsed.message.body).toBe(body);
		expect(parsed.message.subagentName).toBeUndefined();
	}, 10_000);
});
