import { afterEach, describe, expect, it } from "bun:test";
import { resolveDgPaths } from "@dg/common/node";
import {
	ChatStore,
	cleanupDgHome,
	FILE_ONLY_SEAMS,
	killDaemonByPidFile,
	startWithSession,
} from "@dg/dg-daemon/test-harness";
import { runCli } from "./cli-wire";

let dgHome = "";

afterEach(() => {
	if (!dgHome) return;
	killDaemonByPidFile(dgHome);
	cleanupDgHome(dgHome);
	dgHome = "";
});

describe("dg-agent overwatch integration", () => {
	it("publishes a mutation result before an immediate snapshot can run", async () => {
		const started = await startWithSession();
		dgHome = started.dgHome;
		const session = ["--session", started.bootstrap.sessionId];

		const mutation = await runCli(dgHome, started.port, [
			"overwatch",
			...session,
			"set",
			"print",
			"--task",
			"Prepare launch collateral",
		]);
		const snapshot = await runCli(dgHome, started.port, [
			"overwatch",
			...session,
			"snapshot",
			"--json",
		]);

		expect(mutation).toMatchObject({ exitCode: 0, stderr: "" });
		expect(snapshot.exitCode).toBe(0);
		expect(JSON.parse(snapshot.stdout)).toMatchObject({
			lanes: [{ chat: "print", task: "Prepare launch collateral" }],
		});
	});

	it("returns a failing exit code for a daemon lane-limit rejection", async () => {
		const started = await startWithSession();
		dgHome = started.dgHome;
		const store = await ChatStore.open(
			resolveDgPaths({ env: { DG_HOME: dgHome } }),
			FILE_ONLY_SEAMS,
		);
		for (let index = 0; index < 100; index++) {
			store.upsertLane({
				chat: `chat${index}`,
				task: "Seed lane",
				stage: "review",
				kind: "chat",
				publisher: "seed",
			});
		}
		store.close();

		const result = await runCli(dgHome, started.port, [
			"overwatch",
			"--session",
			started.bootstrap.sessionId,
			"set",
			"overflow",
		]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("already has 100 lanes");
	});
});
