import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import handler from "../../../../src/pw/commands/close/run";
import spec from "../../../../src/pw/commands/close/spec";
import {
	read,
	recordPath,
	socketPathFor,
} from "../../../../src/pw/core/registry";
import {
	argsFor,
	clientEnv,
	startFakeDaemon,
	useTempScratch,
} from "../../../../src/pw/test-support";

useTempScratch();

describe("close", () => {
	test("exits 1 with the fixed message when the session is not open", async () => {
		const env = clientEnv();
		expect(await handler(argsFor(spec, "-s=github"), env)).toBe(1);
		expect(env.stderr).toEqual(["Browser 'github' is not open. Run: pw open"]);
	});

	test("stops the daemon and removes the registry record and socket", async () => {
		const daemon = await startFakeDaemon("github");
		const env = clientEnv();
		try {
			expect(await handler(argsFor(spec, "-s=github"), env)).toBe(0);
			expect(env.stdout).toEqual(["### Browser `github` closed."]);
			expect(read("github")).toBeNull();
			expect(existsSync(recordPath("github"))).toBe(false);
			expect(existsSync(socketPathFor("github"))).toBe(false);
			const exited = await Promise.race([
				daemon.child.exited.then(() => true),
				Bun.sleep(5_000).then(() => false),
			]);
			expect(exited).toBe(true);
		} finally {
			daemon.dispose();
		}
	});
});
